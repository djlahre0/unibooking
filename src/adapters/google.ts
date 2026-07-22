import type { AvailabilitySlot, Booking, BookingStatus } from '../types';
import { asArray, asRecord, defineAdapter, reqString } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange } from '../time';
import { freeSlots } from '../availability';

/**
 * Google Calendar (v3). A plain calendar: no native concept of staff or
 * services, so those capabilities are false. `availability` is derived from the
 * freeBusy API — free slots are the gaps between busy intervals — which returns
 * busy blocks only, so `searchAvailability` requires a positive `durationMinutes`
 * to size each slot. `idempotency` is false because Google only accepts
 * client-supplied event ids in a restricted format — pass such an id via
 * `providerOptions.id` if you need it.
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

/** Canonical `notify` → Google's `sendUpdates` query value. Undefined leaves it
 *  to Google's default (no notifications). */
function sendUpdatesFor(notify: boolean | undefined): 'all' | 'none' | undefined {
  return notify === true ? 'all' : notify === false ? 'none' : undefined;
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

/** Canonical status → Google event `status` (Google only writes these three).
 *  Returns undefined for statuses with no Google equivalent so `updateBooking`
 *  leaves the field untouched rather than sending something invalid. */
function toGoogleStatus(s: BookingStatus | undefined): string | undefined {
  switch (s) {
    case 'confirmed':
    case 'completed':
      return 'confirmed';
    case 'pending':
      return 'tentative';
    case 'cancelled':
      return 'cancelled';
    default:
      return undefined;
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

function parseGoogleError(
  _status: number,
  body: unknown,
): { providerCode?: string; message?: string } {
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
    availability: true,
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
        // Google emails attendees only when sendUpdates is set (default: none).
        query: { sendUpdates: sendUpdatesFor(input.notify) },
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
      // Google models tentative/confirmed/cancelled as the event `status`, so a
      // canonical status update maps straight onto it (a status with no Google
      // form leaves the field untouched).
      const status = toGoogleStatus(input.status);
      const res = await http.request(c, {
        method: 'PATCH',
        path: `calendars/${calId(c)}/events/${encodeURIComponent(id)}`,
        query: { sendUpdates: sendUpdatesFor(input.notify) },
        body: {
          ...(input.title !== undefined ? { summary: input.title } : {}),
          ...(input.range
            ? {
                start: point(input.range.start, input.range.timezone),
                end: point(input.range.end, input.range.timezone),
              }
            : {}),
          ...(status !== undefined ? { status } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(res);
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      const sendUpdates = sendUpdatesFor(options?.notify);
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

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'google');
      // freeBusy returns busy intervals only, so a slot size is required to
      // derive free slots. A plain calendar has no staff/service, so those are
      // ignored rather than turned into filters that don't exist.
      if (typeof query.durationMinutes !== 'number' || query.durationMinutes <= 0) {
        throw new UnibookingError({
          provider: 'google',
          code: 'INVALID_INPUT',
          message:
            'Google freeBusy returns busy intervals only; pass a positive durationMinutes to size each slot',
        });
      }
      const durationMinutes = query.durationMinutes;
      const c = await http.resolve();
      const id = calId(c);
      const res = await http.request(c, {
        method: 'POST',
        path: 'freeBusy',
        body: {
          timeMin: query.range.start,
          timeMax: query.range.end,
          items: [{ id }],
          ...query.providerOptions,
        },
      });
      // Response: { calendars: { [id]: { busy: [{start,end}], errors?: [...] } } }.
      const cal = asRecord(
        asRecord(res?.calendars, 'google', 'freeBusy.calendars')[id],
        'google',
        'freeBusy.calendars[calendarId]',
      );
      const errors = asArray(cal.errors, 'google', 'freeBusy.errors');
      if (errors.length > 0) {
        throw new UnibookingError({
          provider: 'google',
          code: 'UPSTREAM',
          message: `freeBusy could not read the calendar: ${errors[0]?.reason ?? 'unknown error'}`,
        });
      }
      const busy = asArray(cal.busy, 'google', 'freeBusy.busy');
      return freeSlots(query.range, busy, durationMinutes);
    },
  }),
});
