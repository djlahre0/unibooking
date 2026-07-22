import type { AvailabilitySlot, Booking, BookingStatus } from '../types';
import { asArray, asRecord, defineAdapter, reqString } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange } from '../time';
import { freeSlots } from '../availability';
import { graphDateTime, graphToInstant, nextLinkFrom, parseGraphError, PREFER_UTC } from '../graph';

/**
 * Outlook / Microsoft 365 calendars via Microsoft Graph. A plain calendar (no
 * staff/services). `availability` is derived from the getSchedule API — free
 * slots are the gaps between busy blocks — which needs a mailbox SMTP address
 * (supplied via `providerOptions.schedules`/`mailbox`, or a UPN-form `userId`)
 * plus a positive `durationMinutes` to size each slot. `idempotency` maps to
 * Graph's event `transactionId`. Scope: `Calendars.ReadWrite`.
 */
export type OutlookCredentials = {
  accessToken: string;
  /** Target another user's calendar (app permissions). Defaults to `me`. */
  userId?: string;
  /** Target a specific calendar. Defaults to the default calendar. */
  calendarId?: string;
};

const BASE = 'https://graph.microsoft.com/v1.0/';

/** The mailbox segment of a Graph path: another user by id, or `me`. */
function who(c: OutlookCredentials): string {
  return c.userId ? `users/${encodeURIComponent(c.userId)}` : 'me';
}

function scope(c: OutlookCredentials): string {
  return c.calendarId ? `${who(c)}/calendars/${encodeURIComponent(c.calendarId)}` : who(c);
}

/** Resolve the mailbox SMTP address(es) getSchedule needs in `schedules`. It is
 *  NOT part of OutlookCredentials, so look, in order: (1) providerOptions
 *  (`schedules` string|string[], or `mailbox` string); (2) a UPN/email userId;
 *  (3) fail — Graph's `me` alias is not a valid schedule id, so there is no
 *  sensible default to fall back to. */
function resolveSchedules(
  c: OutlookCredentials,
  providerOptions: Record<string, unknown> | undefined,
): string[] {
  const po = providerOptions ?? {};
  const fromSchedules = po.schedules;
  if (typeof fromSchedules === 'string' && fromSchedules) return [fromSchedules];
  if (Array.isArray(fromSchedules)) {
    const list = fromSchedules.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (list.length > 0) return list;
  }
  if (typeof po.mailbox === 'string' && po.mailbox) return [po.mailbox];
  if (c.userId && c.userId.includes('@')) return [c.userId];
  throw new UnibookingError({
    provider: 'outlook',
    code: 'INVALID_INPUT',
    message:
      'getSchedule needs a mailbox address; supply it via providerOptions.schedules ' +
      "(string or string[]) or providerOptions.mailbox — Graph's `me` alias is not a valid schedule id",
  });
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
    availability: true,
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

    async searchAvailability(query): Promise<AvailabilitySlot[]> {
      assertValidRange(query.range, 'outlook');
      // getSchedule returns busy blocks only, so a slot size is required to
      // derive free slots; it also doubles as the availabilityViewInterval.
      if (typeof query.durationMinutes !== 'number' || query.durationMinutes <= 0) {
        throw new UnibookingError({
          provider: 'outlook',
          code: 'INVALID_INPUT',
          message:
            'getSchedule returns busy blocks only; pass a positive durationMinutes to size each slot',
        });
      }
      const durationMinutes = query.durationMinutes;
      const c = await http.resolve();
      const schedules = resolveSchedules(c, query.providerOptions);
      // getSchedule lives under the mailbox calendar, never a specific
      // calendarId, so target `${who}/calendar` rather than `scope(c)`.
      const res = await http.request(c, {
        method: 'POST',
        path: `${who(c)}/calendar/getSchedule`,
        headers: PREFER_UTC,
        body: {
          schedules,
          startTime: graphDateTime(query.range.start),
          endTime: graphDateTime(query.range.end),
          availabilityViewInterval: durationMinutes,
        },
      });
      const first = asArray(res?.value, 'outlook', 'getSchedule.value')[0];
      const items = asArray(first?.scheduleItems, 'outlook', 'getSchedule.scheduleItems');
      // Everything that is NOT 'free' (busy/tentative/oof/workingElsewhere/
      // unknown) blocks a booking; drop items whose Graph times don't convert.
      const busy = items
        .filter((it: any) => it?.status !== 'free')
        .flatMap((it: any): Array<{ start: string; end: string }> => {
          const start = graphToInstant(it?.start);
          const end = graphToInstant(it?.end);
          return start !== undefined && end !== undefined ? [{ start, end }] : [];
        });
      return freeSlots(query.range, busy, durationMinutes);
    },
  }),
});
