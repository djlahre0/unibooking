import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { google } from 'unibooking/adapters/google';
import { readCalendarConfig } from './config';
import { clientFor, RefreshFailed, runCalendarOp } from './ops';
import type { CalendarSession, StoredTokens } from './session';
import { fakeFetch } from './fake-fetch';

const GCAL = 'https://www.googleapis.com/calendar/v3/';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const RANGE = { start: '2026-09-21T00:00:00+05:30', end: '2026-09-28T00:00:00+05:30' };
const EVENT = {
  id: 'e1',
  summary: 'Standup',
  status: 'confirmed',
  start: { dateTime: '2026-09-21T10:00:00+05:30' },
  end: { dateTime: '2026-09-21T10:30:00+05:30' },
};
const CONFIG = readCalendarConfig({
  SESSION_SECRET: 'x'.repeat(40),
  GOOGLE_CLIENT_ID: 'cid',
  GOOGLE_CLIENT_SECRET: 'csecret',
});

let net: ReturnType<typeof fakeFetch>;
beforeEach(() => {
  net = fakeFetch();
  vi.stubGlobal('fetch', net.fn);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runCalendarOp', () => {
  it('collects events across pages', async () => {
    net
      .on('GET', `${GCAL}calendars/primary/events`, {
        body: { items: [EVENT], nextPageToken: 'p2' },
      })
      .on('GET', `${GCAL}calendars/primary/events`, { body: { items: [{ ...EVENT, id: 'e2' }] } });
    const res = (await runCalendarOp(google({ accessToken: 't' }), 'listEvents', RANGE)) as {
      events: Array<{ id: string }>;
      truncated: boolean;
    };
    expect(res.events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(res.truncated).toBe(false);
    expect(new URL(net.calls[1]!.url).searchParams.get('pageToken')).toBe('p2');
  });

  it('maps an EventInput to a canonical create', async () => {
    net.on('POST', `${GCAL}calendars/primary/events`, { body: EVENT });
    await runCalendarOp(google({ accessToken: 't' }), 'createEvent', {
      event: {
        title: 'Standup',
        start: '2026-09-21T10:00:00+05:30',
        end: '2026-09-21T10:30:00+05:30',
        timezone: 'Asia/Kolkata',
        description: 'Daily',
        location: 'Room 4',
      },
    });
    expect(JSON.parse(net.calls[0]!.body)).toMatchObject({
      summary: 'Standup',
      start: { dateTime: '2026-09-21T10:00:00+05:30', timeZone: 'Asia/Kolkata' },
      description: 'Daily',
      location: 'Room 4',
    });
  });

  it('validates input before any request', async () => {
    const client = google({ accessToken: 't' });
    await expect(
      runCalendarOp(client, 'createEvent', {
        event: { title: '  ', start: RANGE.start, end: RANGE.end },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('title') });
    await expect(
      runCalendarOp(client, 'updateEvent', { event: { title: 'x' } }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      runCalendarOp(client, 'updateEvent', { id: 'e1', event: { start: RANGE.start } }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('together'),
    });
    await expect(runCalendarOp(client, 'listEvents', {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(net.calls).toHaveLength(0);
  });

  it('deletes an event', async () => {
    net.on('DELETE', `${GCAL}calendars/primary/events/e1`, { status: 204 });
    expect(await runCalendarOp(google({ accessToken: 't' }), 'deleteEvent', { id: 'e1' })).toEqual({
      deleted: true,
      id: 'e1',
    });
  });
});

describe('clientFor', () => {
  const expired: CalendarSession = {
    provider: 'google',
    tokens: { accessToken: 'old', refreshToken: 'r1', expiresAt: '2000-01-01T00:00:00Z' },
    account: { email: 'jane@gmail.com' },
  };

  it('refreshes an expired token, reports it, and keeps the refresh token', async () => {
    net
      .on('POST', TOKEN_URL, { body: { access_token: 'fresh', expires_in: 3600 } })
      .on('GET', `${GCAL}users/me/calendarList`, { body: { items: [] } });
    let refreshed: StoredTokens | undefined;
    const client = clientFor(expired, CONFIG, 'http://localhost:3000', undefined, (t) => {
      refreshed = t;
    });
    await runCalendarOp(client, 'listCalendars', {});
    expect(refreshed).toMatchObject({ accessToken: 'fresh', refreshToken: 'r1' });
    expect(net.calls[1]!.headers.get('authorization')).toBe('Bearer fresh');
  });

  it('turns a failed refresh into RefreshFailed', async () => {
    net.on('POST', TOKEN_URL, { status: 400, body: { error: 'invalid_grant' } });
    const client = clientFor(expired, CONFIG, 'http://localhost:3000', undefined, () => {});
    await expect(runCalendarOp(client, 'listCalendars', {})).rejects.toBeInstanceOf(RefreshFailed);
  });

  it('targets the selected calendar', async () => {
    net.on('GET', `${GCAL}calendars/work%40group.calendar.google.com/events/e1`, { body: EVENT });
    const fresh: CalendarSession = { ...expired, tokens: { accessToken: 'ok' } };
    const client = clientFor(
      fresh,
      CONFIG,
      'http://localhost:3000',
      'work@group.calendar.google.com',
      () => {},
    );
    await runCalendarOp(client, 'getEvent', { id: 'e1' });
    expect(net.pending()).toEqual([]);
  });

  it('refuses an Apple calendar outside iCloud before any request', () => {
    const appleSession: CalendarSession = {
      provider: 'apple',
      apple: { username: 'jane@icloud.com', appPassword: 'p' },
      account: {},
    };
    expect(() =>
      clientFor(
        appleSession,
        CONFIG,
        'http://localhost:3000',
        'https://evil.example/cal/',
        () => {},
      ),
    ).toThrow(/icloud/i);
    expect(net.calls).toHaveLength(0);
  });
});

/**
 * `eventOf` casts the request's JSON `event` object straight to `EventInput`,
 * so at runtime any field can be any JSON type. `toCreate` guards `title` with
 * `typeof`, but `toUpdate` does not — it calls `.trim()` on whatever arrived,
 * which turns a malformed body into an internal TypeError surfaced to the
 * caller instead of a clean INVALID_INPUT. These pin the boundary.
 */
describe('runCalendarOp rejects a malformed event body', () => {
  const client = () => google({ accessToken: 't' });

  it('a non-string title on update is INVALID_INPUT, not a TypeError', async () => {
    await expect(
      runCalendarOp(client(), 'updateEvent', { id: 'e1', event: { title: 123 } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('a non-string start on create is rejected before any request goes out', async () => {
    await expect(
      runCalendarOp(client(), 'createEvent', { event: { title: 'ok', start: 123, end: 456 } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(net.calls).toHaveLength(0);
  });

  it('a non-boolean allDay is rejected rather than silently dropped', async () => {
    await expect(
      runCalendarOp(client(), 'updateEvent', { id: 'e1', event: { allDay: 'yes' } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('an array is not a valid event body', async () => {
    await expect(
      runCalendarOp(client(), 'createEvent', { event: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/event/i) });
  });
});

describe('runCalendarOp: the calendars themselves', () => {
  it('createCalendar posts to Google and returns the new calendar', async () => {
    net
      .on('POST', `${GCAL}calendars`, { body: { id: 'c9', summary: 'Front desk' } })
      .on('GET', `${GCAL}users/me/calendarList/c9`, {
        body: { id: 'c9', summary: 'Front desk', accessRole: 'owner' },
      });
    const cal = (await runCalendarOp(google({ accessToken: 't' }), 'createCalendar', {
      name: '  Front desk  ',
    })) as { id: string; name: string; readOnly: boolean };
    expect(cal).toMatchObject({ id: 'c9', name: 'Front desk', readOnly: false });
  });

  it('validates the name and colour before calling the provider', async () => {
    const client = google({ accessToken: 't' });
    await expect(runCalendarOp(client, 'createCalendar', { name: ' ' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      runCalendarOp(client, 'createCalendar', { name: 'X', color: 'green' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      runCalendarOp(client, 'updateCalendar', { calendarId: 'c9', name: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('deleteCalendar needs the calendar id', async () => {
    await expect(
      runCalendarOp(google({ accessToken: 't' }), 'deleteCalendar', {}),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
