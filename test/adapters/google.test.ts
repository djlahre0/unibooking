import { expect } from 'vitest';
import { google } from '../../src/adapters/google';
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
        c.createBooking({ title: 'Haircut — Jane', range: RANGE, customer: { email: 'jane@example.com' } }),
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
      run: (c) => c.updateBooking('ev1', { range: { start: RANGE.start, end: '2026-07-20T16:00:00-07:00' } }),
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
      run: (c) => c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => {
        expect(r.bookings).toHaveLength(1);
        expect(r.nextPageToken).toBe('next');
      },
    },
  ],
});
