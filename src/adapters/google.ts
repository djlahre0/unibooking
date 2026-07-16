import type { Booking, BookingStatus } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange } from '../time';

/**
 * Google Calendar (v3). A plain calendar: no native concept of staff, services,
 * or availability search, so those capabilities are false and
 * `searchAvailability` throws UNSUPPORTED. `idempotency` is false because Google
 * only accepts client-supplied event ids in a restricted format — pass such an
 * id via `providerOptions.id` if you need it.
 */
export type GoogleCredentials = {
  /** OAuth2 access token (scope `https://www.googleapis.com/auth/calendar`). */
  accessToken: string;
  /** Target calendar. Defaults to `'primary'`. */
  calendarId?: string;
};

const BASE = 'https://www.googleapis.com/calendar/v3/';

function calId(c: GoogleCredentials): string {
  return encodeURIComponent(c.calendarId ?? 'primary');
}

function point(instant: string, timezone: string | undefined): Record<string, unknown> {
  return { dateTime: instant, ...(timezone !== undefined ? { timeZone: timezone } : {}) };
}

function pointToInstant(p: any): string | undefined {
  if (!p || typeof p !== 'object') return undefined;
  if (typeof p.dateTime === 'string') return p.dateTime;
  // All-day event: date-only, and `end.date` is exclusive — appending midnight
  // UTC keeps the canonical `end > start` invariant.
  if (typeof p.date === 'string') return `${p.date}T00:00:00Z`;
  return undefined;
}

function mapStatus(s: unknown): BookingStatus {
  switch (s) {
    case 'confirmed':
      return 'confirmed';
    case 'tentative':
      return 'pending';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function toBooking(raw: unknown): Booking {
  const e = asRecord(raw, 'google', 'event');
  const start = pointToInstant(e.start);
  const end = pointToInstant(e.end);
  if (start === undefined || end === undefined) {
    throw new UnibookingError({
      provider: 'google',
      code: 'UPSTREAM',
      message: 'event is missing start/end times',
    });
  }
  const attendee = Array.isArray(e.attendees) ? e.attendees[0] : undefined;
  const customer =
    attendee && (attendee.email || attendee.displayName)
      ? {
          ...(attendee.email ? { email: attendee.email } : {}),
          ...(attendee.displayName ? { name: attendee.displayName } : {}),
        }
      : undefined;
  return {
    id: reqString(e.id, 'google', 'event.id'),
    provider: 'google',
    title: typeof e.summary === 'string' && e.summary ? e.summary : '(untitled)',
    range: {
      start,
      end,
      ...(e.start && typeof e.start.timeZone === 'string' ? { timezone: e.start.timeZone } : {}),
    },
    status: mapStatus(e.status),
    ...(customer ? { customer } : {}),
    ...(typeof e.created === 'string' ? { createdAt: e.created } : {}),
    ...(typeof e.updated === 'string' ? { updatedAt: e.updated } : {}),
    raw: e,
  };
}

function parseGoogleError(_status: number, body: unknown): { providerCode?: string; message?: string } {
  const err = (body as any)?.error;
  if (!err) return {};
  const providerCode = err.status ?? err.errors?.[0]?.reason;
  return {
    ...(typeof err.message === 'string' ? { message: err.message } : {}),
    ...(typeof providerCode === 'string' ? { providerCode } : {}),
  };
}

export const google = defineAdapter<GoogleCredentials>({
  id: 'google',
  capabilities: {
    availability: false,
    staff: false,
    services: false,
    webhooks: true,
    idempotency: false,
    customers: false,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Bearer ${c.accessToken}` } }),
  parseError: parseGoogleError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'google');
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: `calendars/${calId(c)}/events`,
        body: {
          summary: input.title,
          start: point(input.range.start, input.range.timezone),
          end: point(input.range.end, input.range.timezone),
          ...(input.customer?.email
            ? {
                attendees: [
                  {
                    email: input.customer.email,
                    ...(input.customer.name ? { displayName: input.customer.name } : {}),
                  },
                ],
              }
            : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(res);
    },

    async getBooking(id) {
      const c = await http.resolve();
      const res = await http.request(c, {
        path: `calendars/${calId(c)}/events/${encodeURIComponent(id)}`,
      });
      return toBooking(res);
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'google');
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'PATCH',
        path: `calendars/${calId(c)}/events/${encodeURIComponent(id)}`,
        body: {
          ...(input.title !== undefined ? { summary: input.title } : {}),
          ...(input.range
            ? {
                start: point(input.range.start, input.range.timezone),
                end: point(input.range.end, input.range.timezone),
              }
            : {}),
          ...(input.status === 'cancelled' ? { status: 'cancelled' } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(res);
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      const sendUpdates =
        options?.notify === true ? 'all' : options?.notify === false ? 'none' : undefined;
      await http.request(c, {
        method: 'DELETE',
        path: `calendars/${calId(c)}/events/${encodeURIComponent(id)}`,
        query: { sendUpdates },
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'google');
      const c = await http.resolve();
      const res = await http.request(c, {
        path: `calendars/${calId(c)}/events`,
        query: {
          timeMin: query.range.start,
          timeMax: query.range.end,
          singleEvents: true, // expand recurring events into instances
          orderBy: 'startTime', // requires singleEvents
          maxResults: query.limit ?? 50,
          pageToken: query.pageToken,
        },
      });
      const items = asArray(res?.items, 'google', 'events.items');
      return {
        bookings: items.map(toBooking),
        ...(typeof res?.nextPageToken === 'string' ? { nextPageToken: res.nextPageToken } : {}),
      };
    },

    async searchAvailability(_query) {
      return unsupported('google', 'availability');
    },
  }),
});
