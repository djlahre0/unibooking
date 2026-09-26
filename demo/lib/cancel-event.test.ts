import { describe, it, expect, vi } from 'vitest';
import type { Booking, BookingClient } from 'unibooking';
import {
  CANCELLED_PREFIX,
  eventStatus,
  isMarkedCancelled,
  markCancelled,
  setEventStatus,
} from './cancel-event';
import { dispatch } from './dispatch';
import { google } from 'unibooking/adapters/google';
import { outlook } from 'unibooking/adapters/outlook';
import { apple } from 'unibooking/adapters/apple';

function fakeClient(id: string, booking: Partial<Booking> = {}) {
  const current = { id: 'e1', title: 'Standup', status: 'confirmed', ...booking } as Booking;
  const updateBooking = vi.fn(async (_id: string, input: Record<string, unknown>) => ({
    ...current,
    ...input,
  }));
  const cancelBooking = vi.fn(async () => {});
  const client = {
    id,
    getBooking: vi.fn(async () => current),
    updateBooking,
    cancelBooking,
  } as unknown as BookingClient;
  return { client, updateBooking, cancelBooking };
}

describe('markCancelled', () => {
  it('Google: marks the title and frees the slot, never deleting', async () => {
    const { client, updateBooking, cancelBooking } = fakeClient('google');
    await markCancelled(client, 'e1');
    expect(cancelBooking).not.toHaveBeenCalled();
    const input = updateBooking.mock.calls[0]![1];
    expect(input).toMatchObject({
      title: 'Cancelled: Standup',
      notify: true,
      providerOptions: { transparency: 'transparent' },
    });
    // status 'cancelled' is a delete on Google.
    expect(input).not.toHaveProperty('status');
  });

  it("Outlook: shows the slot as free (PATCH can't set isCancelled)", async () => {
    const { client, updateBooking } = fakeClient('outlook');
    await markCancelled(client, 'e1');
    const input = updateBooking.mock.calls[0]![1];
    expect(input).toMatchObject({ providerOptions: { showAs: 'free' } });
    expect(input).not.toHaveProperty('status');
  });

  it('Apple: writes STATUS:CANCELLED via the canonical status', async () => {
    const { client, updateBooking } = fakeClient('apple');
    await markCancelled(client, 'e1');
    expect(updateBooking.mock.calls[0]![1]).toMatchObject({
      title: 'Cancelled: Standup',
      status: 'cancelled',
    });
  });

  it('does not stack the prefix when cancelled twice', async () => {
    const { client, updateBooking } = fakeClient('google', { title: 'Cancelled: Standup' });
    await markCancelled(client, 'e1');
    expect(updateBooking.mock.calls[0]![1].title).toBe('Cancelled: Standup');
  });

  it('appends the reason to the notes', async () => {
    const { client, updateBooking } = fakeClient('google', { description: 'Agenda' });
    await markCancelled(client, 'e1', 'Room unavailable');
    expect(updateBooking.mock.calls[0]![1].description).toBe(
      'Agenda\n\nCancelled: Room unavailable',
    );
  });

  it('refuses booking platforms, where cancelBooking is the real cancel', async () => {
    const { client, updateBooking } = fakeClient('square');
    await expect(markCancelled(client, 'e1')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(updateBooking).not.toHaveBeenCalled();
  });

  it('is reachable through dispatch as markCancelled', async () => {
    const { client, updateBooking } = fakeClient('google');
    await dispatch(client, 'markCancelled', { bookingId: 'e1' });
    expect(updateBooking).toHaveBeenCalledWith('e1', expect.objectContaining({ notify: true }));
  });
});

describe('setEventStatus', () => {
  it('Google: restoring a cancelled event strips the marker and blocks the time again', async () => {
    const { client, updateBooking } = fakeClient('google', { title: 'Cancelled: Standup' });
    await setEventStatus(client, 'e1', 'confirmed');
    expect(updateBooking).toHaveBeenCalledWith('e1', {
      status: 'confirmed',
      notify: true,
      title: 'Standup',
      providerOptions: { transparency: 'opaque' },
    });
  });

  it('Outlook: tentative is left to the adapter, which maps it to showAs', async () => {
    const { client, updateBooking } = fakeClient('outlook');
    await setEventStatus(client, 'e1', 'pending');
    expect(updateBooking).toHaveBeenCalledWith('e1', { status: 'pending', notify: true });
  });

  it('cancelled goes through markCancelled (kept, never deleted)', async () => {
    const { client, updateBooking, cancelBooking } = fakeClient('apple');
    await setEventStatus(client, 'e1', 'cancelled');
    expect(updateBooking.mock.calls[0]![1]).toMatchObject({
      status: 'cancelled',
      title: 'Cancelled: Standup',
    });
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it('refuses a booking platform', async () => {
    const { client } = fakeClient('square');
    await expect(setEventStatus(client, 'e1', 'confirmed')).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });

  it('dispatch updateBooking routes a calendar status here, after the other fields', async () => {
    const { client, updateBooking } = fakeClient('google', { title: 'Cancelled: Standup' });
    await dispatch(client, 'updateBooking', {
      bookingId: 'e1',
      input: { title: 'Cancelled: Standup v2', status: 'pending' },
    });
    expect(updateBooking.mock.calls[0]![1]).toEqual({ title: 'Cancelled: Standup v2' });
    expect(updateBooking.mock.calls[1]![1]).toMatchObject({ status: 'pending' });
  });

  it('dispatch updateBooking passes a platform status straight to the adapter', async () => {
    const { client, updateBooking } = fakeClient('square');
    await dispatch(client, 'updateBooking', { bookingId: 'e1', input: { status: 'no_show' } });
    expect(updateBooking).toHaveBeenCalledWith('e1', { status: 'no_show' });
  });

  it('eventStatus reads the marker first, then tentative', () => {
    expect(eventStatus({ title: 'Cancelled: X', status: 'confirmed' })).toBe('cancelled');
    expect(eventStatus({ title: 'X', status: 'pending' })).toBe('pending');
    expect(eventStatus({ title: 'X', status: 'unknown' as never })).toBe('confirmed');
  });
});

describe('isMarkedCancelled', () => {
  it('recognises the title marker and a provider-side cancelled status', () => {
    expect(isMarkedCancelled({ title: `${CANCELLED_PREFIX}X`, status: 'confirmed' })).toBe(true);
    expect(isMarkedCancelled({ title: 'X', status: 'cancelled' })).toBe(true);
    expect(isMarkedCancelled({ title: 'X', status: 'confirmed' })).toBe(false);
  });
});

/** Records every request and answers from `respond`. */
function recorder(respond: (method: string, url: string) => Response) {
  const calls: { method: string; url: string; body: string }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : '' });
    return respond(method, url);
  }) as typeof fetch;
  return { calls, fetchFn };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('markCancelled against the real adapters', () => {
  it('Google sends one PATCH (never a DELETE) with transparency and sendUpdates=all', async () => {
    const event = {
      id: 'e1',
      summary: 'Standup',
      status: 'confirmed',
      start: { dateTime: '2026-10-01T09:00:00Z' },
      end: { dateTime: '2026-10-01T09:30:00Z' },
    };
    const { calls, fetchFn } = recorder((method) =>
      json(method === 'PATCH' ? { ...event, summary: 'Cancelled: Standup' } : event),
    );
    const client = google({ accessToken: 't' }, { fetch: fetchFn });
    await markCancelled(client, 'e1');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(calls[1]!.url).toContain('sendUpdates=all');
    expect(JSON.parse(calls[1]!.body)).toMatchObject({
      summary: 'Cancelled: Standup',
      transparency: 'transparent',
    });
    expect(JSON.parse(calls[1]!.body)).not.toHaveProperty('status');
  });

  it('Outlook sends one PATCH with showAs free', async () => {
    const event = {
      id: 'e1',
      subject: 'Standup',
      start: { dateTime: '2026-10-01T09:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-01T09:30:00.0000000', timeZone: 'UTC' },
    };
    const { calls, fetchFn } = recorder(() => json(event));
    const client = outlook({ accessToken: 't' }, { fetch: fetchFn });
    await markCancelled(client, 'e1');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(JSON.parse(calls[1]!.body)).toMatchObject({
      subject: 'Cancelled: Standup',
      showAs: 'free',
    });
  });

  it('Apple rewrites the event with STATUS:CANCELLED instead of deleting it', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      'BEGIN:VEVENT',
      'UID:e1',
      'DTSTAMP:20261001T000000Z',
      'DTSTART:20261001T090000Z',
      'DTEND:20261001T093000Z',
      'SUMMARY:Standup',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const { calls, fetchFn } = recorder((method) =>
      method === 'PUT'
        ? new Response(null, { status: 204, headers: { etag: '"2"' } })
        : new Response(ics, {
            status: 200,
            headers: { etag: '"1"', 'content-type': 'text/calendar' },
          }),
    );
    const client = apple(
      {
        username: 'a@icloud.com',
        appPassword: 'x',
        calendarUrl: 'https://caldav.icloud.com/1/calendars/home/',
      },
      { fetch: fetchFn },
    );
    await markCancelled(client, 'e1');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toContain('STATUS:CANCELLED');
    expect(put?.body).toContain('SUMMARY:Cancelled: Standup');
  });
});
