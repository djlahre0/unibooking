import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { google } from '../../src/adapters/google';
import { isInstant } from '../../src/time';
import { runConformance } from '../conformance';

const EVENT = {
  id: 'ev1',
  summary: 'Haircut — Jane',
  start: { dateTime: '2026-07-20T15:00:00-07:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-07-20T15:45:00-07:00', timeZone: 'America/Los_Angeles' },
  status: 'confirmed',
  attendees: [{ email: 'jane@example.com', displayName: 'Jane Doe' }],
  created: '2026-07-01T00:00:00Z',
  updated: '2026-07-02T00:00:00Z',
};

const RANGE = { start: '2026-07-20T15:00:00-07:00', end: '2026-07-20T15:45:00-07:00' };

runConformance({
  provider: 'google',
  origin: 'https://www.googleapis.com',
  makeClient: () => google({ accessToken: 'token', calendarId: 'primary' }),
  errorProbe: {
    method: 'GET',
    path: '/calendar/v3/calendars/primary/events',
    run: (c) => c.getBooking('missing'),
  },
  cases: [
    {
      name: 'createBooking maps the event + attendee',
      method: 'POST',
      path: '/calendar/v3/calendars/primary/events',
      reply: EVENT,
      run: (c) =>
        c.createBooking({
          title: 'Haircut — Jane',
          range: RANGE,
          customer: { email: 'jane@example.com' },
        }),
      check: (b) => {
        expect(b.id).toBe('ev1');
        expect(b.customer?.email).toBe('jane@example.com');
        expect(Date.parse(b.range.end) > Date.parse(b.range.start)).toBe(true);
      },
    },
    {
      name: 'getBooking maps the event',
      method: 'GET',
      path: '/calendar/v3/calendars/primary/events',
      reply: EVENT,
      run: (c) => c.getBooking('ev1'),
      check: (b) => expect(b.status).toBe('confirmed'),
    },
    {
      name: 'updateBooking reschedules',
      method: 'PATCH',
      path: '/calendar/v3/calendars/primary/events',
      reply: { ...EVENT, end: { dateTime: '2026-07-20T16:00:00-07:00' } },
      run: (c) =>
        c.updateBooking('ev1', { range: { start: RANGE.start, end: '2026-07-20T16:00:00-07:00' } }),
    },
    {
      name: 'cancelBooking deletes',
      method: 'DELETE',
      path: '/calendar/v3/calendars/primary/events',
      reply: '',
      run: (c) => c.cancelBooking('ev1'),
    },
    {
      name: 'listBookings returns bookings + page token',
      method: 'GET',
      path: '/calendar/v3/calendars/primary/events',
      reply: { items: [EVENT], nextPageToken: 'next' },
      run: (c) =>
        c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => {
        expect(r.bookings).toHaveLength(1);
        expect(r.nextPageToken).toBe('next');
      },
    },
    {
      name: 'searchAvailability derives free slots from freeBusy',
      method: 'POST',
      path: '/calendar/v3/freeBusy',
      reply: {
        calendars: {
          primary: { busy: [{ start: '2026-07-20T10:00:00Z', end: '2026-07-20T11:00:00Z' }] },
        },
      },
      run: (c) =>
        c.searchAvailability({
          range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
          durationMinutes: 60,
        }),
      check: (slots) => {
        // The 10:00–11:00 busy block is excluded; 09–10 and 11–12 remain.
        expect(slots).toHaveLength(2);
        expect(slots[0].start).toBe('2026-07-20T09:00:00Z');
        expect(slots[1].start).toBe('2026-07-20T11:00:00Z');
        expect(slots.some((s: any) => s.start === '2026-07-20T10:00:00Z')).toBe(false);
      },
    },
  ],
});

describe('google: freeBusy-derived availability', () => {
  let agent: MockAgent;
  let previous: Dispatcher;
  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });

  it('rejects a missing durationMinutes with INVALID_INPUT', async () => {
    const client = google({ accessToken: 't', calendarId: 'primary' });
    await expect(
      client.searchAvailability({
        range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('excludes busy intervals and returns offset-bearing slots', async () => {
    agent
      .get('https://www.googleapis.com')
      .intercept({ path: (p) => p.startsWith('/calendar/v3/freeBusy'), method: 'POST' })
      .reply(
        200,
        JSON.stringify({
          calendars: {
            primary: { busy: [{ start: '2026-07-20T10:00:00Z', end: '2026-07-20T11:00:00Z' }] },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    const slots = await google({ accessToken: 't', calendarId: 'primary' }).searchAvailability({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
      durationMinutes: 60,
    });
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z']);
    // The busy hour is never offered as a slot start.
    expect(slots.some((s) => s.start === '2026-07-20T10:00:00Z')).toBe(false);
    for (const s of slots) {
      expect(isInstant(s.start)).toBe(true);
      expect(isInstant(s.end)).toBe(true);
    }
  });

  it('throws UPSTREAM when the calendar entry carries an errors array', async () => {
    agent
      .get('https://www.googleapis.com')
      .intercept({ path: (p) => p.startsWith('/calendar/v3/freeBusy'), method: 'POST' })
      .reply(
        200,
        JSON.stringify({
          calendars: { primary: { busy: [], errors: [{ reason: 'notACalendarUser' }] } },
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    await expect(
      google({ accessToken: 't', calendarId: 'primary' }).searchAvailability({
        range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
        durationMinutes: 60,
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM' });
  });
});
