import type { Booking, BookingStatus } from '../types';
import { asArray, asRecord, defineAdapter, reqString, unsupported } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange } from '../time';
import { graphDateTime, graphToInstant, nextLinkFrom, parseGraphError, PREFER_UTC } from '../graph';

/**
 * Outlook / Microsoft 365 calendars via Microsoft Graph. A plain calendar (no
 * staff/services/availability). `idempotency` maps to Graph's event
 * `transactionId`. Scope: `Calendars.ReadWrite`.
 */
export type OutlookCredentials = {
  accessToken: string;
  /** Target another user's calendar (app permissions). Defaults to `me`. */
  userId?: string;
  /** Target a specific calendar. Defaults to the default calendar. */
  calendarId?: string;
};

const BASE = 'https://graph.microsoft.com/v1.0/';

function scope(c: OutlookCredentials): string {
  const who = c.userId ? `users/${encodeURIComponent(c.userId)}` : 'me';
  return c.calendarId ? `${who}/calendars/${encodeURIComponent(c.calendarId)}` : who;
}

function mapStatus(e: any): BookingStatus {
  if (e?.isCancelled === true) return 'cancelled';
  const response = e?.responseStatus?.response;
  if (response === 'declined') return 'declined';
  if (response === 'tentativelyAccepted' || e?.showAs === 'tentative') return 'pending';
  return 'confirmed';
}

function toBooking(raw: unknown): Booking {
  const e = asRecord(raw, 'outlook', 'event');
  const start = graphToInstant(e.start);
  const end = graphToInstant(e.end);
  if (start === undefined || end === undefined) {
    throw new UnibookingError({
      provider: 'outlook',
      code: 'UPSTREAM',
      message: 'event is missing start/end times',
    });
  }
  const att = Array.isArray(e.attendees) ? e.attendees[0]?.emailAddress : undefined;
  const customer =
    att && (att.address || att.name)
      ? { ...(att.address ? { email: att.address } : {}), ...(att.name ? { name: att.name } : {}) }
      : undefined;
  return {
    id: reqString(e.id, 'outlook', 'event.id'),
    provider: 'outlook',
    title: typeof e.subject === 'string' && e.subject ? e.subject : '(untitled)',
    range: { start, end },
    status: mapStatus(e),
    ...(customer ? { customer } : {}),
    ...(typeof e.createdDateTime === 'string' ? { createdAt: e.createdDateTime } : {}),
    ...(typeof e.lastModifiedDateTime === 'string' ? { updatedAt: e.lastModifiedDateTime } : {}),
    raw: e,
  };
}

export const outlook = defineAdapter<OutlookCredentials>({
  id: 'outlook',
  capabilities: {
    availability: false,
    staff: false,
    services: false,
    webhooks: true,
    idempotency: true,
    customers: false,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Bearer ${c.accessToken}` } }),
  requestIdHeader: 'request-id',
  parseError: parseGraphError,
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'outlook');
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: `${scope(c)}/events`,
        headers: PREFER_UTC,
        body: {
          subject: input.title,
          start: graphDateTime(input.range.start),
          end: graphDateTime(input.range.end),
          ...(input.customer?.email
            ? {
                attendees: [
                  {
                    emailAddress: {
                      address: input.customer.email,
                      ...(input.customer.name ? { name: input.customer.name } : {}),
                    },
                    type: 'required',
                  },
                ],
              }
            : {}),
          ...(input.idempotencyKey ? { transactionId: input.idempotencyKey } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(res);
    },

    async getBooking(id) {
      const c = await http.resolve();
      const res = await http.request(c, {
        path: `${scope(c)}/events/${encodeURIComponent(id)}`,
        headers: PREFER_UTC,
      });
      return toBooking(res);
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'outlook');
      if (input.status === 'cancelled') {
        throw new UnibookingError({
          provider: 'outlook',
          code: 'INVALID_INPUT',
          message: 'To cancel an Outlook event use cancelBooking(); PATCH cannot set isCancelled.',
        });
      }
      const c = await http.resolve();
      // Graph has no free-form status, but `showAs` models tentative vs busy.
      const showAs =
        input.status === 'pending'
          ? 'tentative'
          : input.status === 'confirmed'
            ? 'busy'
            : undefined;
      const res = await http.request(c, {
        method: 'PATCH',
        path: `${scope(c)}/events/${encodeURIComponent(id)}`,
        headers: PREFER_UTC,
        body: {
          ...(input.title !== undefined ? { subject: input.title } : {}),
          ...(input.range
            ? { start: graphDateTime(input.range.start), end: graphDateTime(input.range.end) }
            : {}),
          ...(showAs ? { showAs } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(res);
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      // NOTE: `notify: false` is not honorable for organizer-owned meetings.
      // Graph documents that deleting an event on the organizer's calendar
      // "sends a cancellation message to the meeting attendees" — so DELETE is
      // only silent for events with no attendees. Since createBooking attaches
      // an attendee whenever customer.email is set, most bookings we create will
      // notify on cancel regardless of this flag.
      if (options?.notify === true || options?.reason !== undefined) {
        await http.request(c, {
          method: 'POST',
          path: `${scope(c)}/events/${encodeURIComponent(id)}/cancel`,
          body: { ...(options.reason !== undefined ? { comment: options.reason } : {}) },
          parse: 'none',
        });
        return;
      }
      await http.request(c, {
        method: 'DELETE',
        path: `${scope(c)}/events/${encodeURIComponent(id)}`,
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'outlook');
      const c = await http.resolve();
      // A pageToken is the full @odata.nextLink from a previous page; follow it
      // verbatim so any Graph paging param ($skiptoken or $skip) is preserved.
      const follow =
        query.pageToken && /^https?:\/\//i.test(query.pageToken) ? query.pageToken : undefined;
      if (query.pageToken !== undefined && follow === undefined) {
        // A non-URL token used to be forwarded as `$skiptoken`. Graph pages
        // calendarView with `$skip`, silently ignores unrecognized query params,
        // and its docs say never to extract a paging token and reuse it — so
        // that path returned page 1 forever and the caller looped indefinitely.
        throw new UnibookingError({
          provider: 'outlook',
          code: 'INVALID_INPUT',
          message:
            'pageToken must be the full @odata.nextLink URL from a previous page; ' +
            'Graph paging tokens cannot be reconstructed',
        });
      }
      if (query.limit !== undefined && (query.limit < 1 || query.limit > 1000)) {
        // calendarView documents $top as min 1, max 1000.
        throw new UnibookingError({
          provider: 'outlook',
          code: 'INVALID_INPUT',
          message: `limit must be between 1 and 1000 (got ${query.limit})`,
        });
      }
      const res = follow
        ? await http.request(c, { path: follow, headers: PREFER_UTC })
        : await http.request(c, {
            path: `${scope(c)}/calendarView`,
            headers: PREFER_UTC,
            query: {
              startDateTime: query.range.start,
              endDateTime: query.range.end,
              $top: query.limit ?? 50,
              $orderby: 'start/dateTime',
            },
          });
      const bookings = asArray(res?.value, 'outlook', 'calendarView.value').map(toBooking);
      const next = nextLinkFrom(res);
      return { bookings, ...(next !== undefined ? { nextPageToken: next } : {}) };
    },

    async searchAvailability(_query) {
      return unsupported('outlook', 'availability');
    },
  }),
});
