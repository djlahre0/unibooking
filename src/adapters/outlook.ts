import type { AvailabilitySlot, Booking, BookingStatus, Calendar, TimeRange } from '../types';
import {
  asArray,
  asRecord,
  defineAdapter,
  hexColor,
  probeConnection,
  reqString,
} from '../adapter-kit';
import { UnibookingError } from '../errors';
import {
  allDayDates,
  allDayInstant,
  assertAllDayInput,
  assertValidRange,
  instantToZoned,
  wallClockIn,
} from '../time';
import { freeSlots } from '../availability';
import { graphDateTime, graphToInstant, nextLinkFrom, parseGraphError, PREFER_UTC } from '../graph';

/**
 * Outlook / Microsoft 365 calendars via Microsoft Graph. A plain calendar (no
 * staff/services). `availability` is derived from the getSchedule API — free
 * slots are the gaps between busy blocks — which needs a mailbox SMTP address
 * (supplied via `providerOptions.schedules`/`mailbox`, or a UPN-form `userId`)
 * plus a positive `durationMinutes` to size each slot. `idempotency` maps to
 * Graph's event `transactionId`. Scope: `Calendars.ReadWrite`.
 *
 * `listCalendars` reads the mailbox's calendars; each `Calendar.id` is a valid
 * `calendarId`. Writes honor `range.timezone` (wall clock + zone, so Outlook
 * shows the event in the zone the user picked), `description` (plain-text
 * body), `location` and `allDay`.
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

/** Event requests: UTC times + immutable ids (the shared Graph default), plus
 *  plain-text bodies so `description` never carries Outlook's HTML wrapper. */
const PREFER = { prefer: `${PREFER_UTC.prefer}, outlook.body-content-type="text"` };

/** A pageToken is the full @odata.nextLink from a previous page; follow it
 *  verbatim so any Graph paging param ($skiptoken or $skip) is preserved. */
function followLink(pageToken: string | undefined): string | undefined {
  if (pageToken === undefined) return undefined;
  if (/^https?:\/\//i.test(pageToken)) return pageToken;
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

/** The calendar date of an all-day event boundary. Graph converts event times
 *  into the `Prefer` zone, so an all-day event created in +05:30 can come back
 *  as 18:30 the previous day in UTC. At midnight, the reported date is the
 *  date; otherwise convert back to the event's original zone, where it IS
 *  midnight. */
function allDayDate(dtz: any, originalZone: unknown): string | undefined {
  const raw: unknown = dtz?.dateTime;
  if (typeof raw !== 'string' || raw.length < 10) return undefined;
  if (/T00:00:00(?:\.0+)?$/.test(raw)) return raw.slice(0, 10);
  const instant = graphToInstant(dtz);
  if (instant !== undefined && typeof originalZone === 'string') {
    try {
      const local = instantToZoned(instant, originalZone);
      if (local.time === '00:00') return local.date;
    } catch {
      // An unresolvable zone (e.g. a custom tzone://) leaves the reported date.
    }
  }
  return raw.slice(0, 10);
}

/** Canonical range → Graph `start`/`end` (+ `isAllDay`). A resolvable
 *  `range.timezone` is written as wall clock + zone, which Graph accepts for
 *  IANA and Windows names alike; otherwise UTC, as before. An update always
 *  states `isAllDay`, so a timed range turns an all-day event back into a
 *  timed one. */
function outlookTimes(
  range: TimeRange,
  allDay: boolean | undefined,
  update: boolean,
): Record<string, unknown> {
  if (allDay === true) {
    const d = allDayDates(range, 'outlook');
    const timeZone = range.timezone ?? 'UTC';
    return {
      isAllDay: true,
      start: { dateTime: `${d.start}T00:00:00`, timeZone },
      end: { dateTime: `${d.end}T00:00:00`, timeZone },
    };
  }
  const flag = update ? { isAllDay: false } : {};
  const tz = range.timezone;
  const start = tz ? wallClockIn(range.start, tz) : undefined;
  const end = tz ? wallClockIn(range.end, tz) : undefined;
  if (tz && start && end) {
    return {
      ...flag,
      start: { dateTime: start, timeZone: tz },
      end: { dateTime: end, timeZone: tz },
    };
  }
  return { ...flag, start: graphDateTime(range.start), end: graphDateTime(range.end) };
}

/** `description` → a plain-text body, `location` → a display name. An empty
 *  string is sent too: it clears the field. */
function textFields(input: { description?: string; location?: string }): Record<string, unknown> {
  return {
    ...(input.description !== undefined
      ? { body: { contentType: 'text', content: input.description } }
      : {}),
    ...(input.location !== undefined ? { location: { displayName: input.location } } : {}),
  };
}

function toCalendar(raw: unknown): Calendar {
  const c = asRecord(raw, 'outlook', 'calendar');
  const id = reqString(c.id, 'outlook', 'calendar.id');
  const color = hexColor(c.hexColor);
  return {
    id,
    name: typeof c.name === 'string' && c.name ? c.name : id,
    primary: c.isDefaultCalendar === true,
    readOnly: c.canEdit === false,
    ...(color ? { color } : {}),
    raw: c,
  };
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
  const allDayStart =
    e.isAllDay === true ? allDayDate(e.start, e.originalStartTimeZone) : undefined;
  const allDayEnd =
    e.isAllDay === true
      ? allDayDate(e.end, e.originalEndTimeZone ?? e.originalStartTimeZone)
      : undefined;
  const allDay = allDayStart !== undefined && allDayEnd !== undefined;
  return {
    id: reqString(e.id, 'outlook', 'event.id'),
    provider: 'outlook',
    title: typeof e.subject === 'string' && e.subject ? e.subject : '(untitled)',
    range:
      allDayStart !== undefined && allDayEnd !== undefined
        ? { start: allDayInstant(allDayStart), end: allDayInstant(allDayEnd) }
        : { start, end },
    status: mapStatus(e),
    ...(customer ? { customer } : {}),
    ...(typeof e.createdDateTime === 'string' ? { createdAt: e.createdDateTime } : {}),
    ...(typeof e.lastModifiedDateTime === 'string' ? { updatedAt: e.lastModifiedDateTime } : {}),
    ...(typeof e.body?.content === 'string' && e.body.content.trim()
      ? { description: e.body.content }
      : {}),
    ...(typeof e.location?.displayName === 'string' && e.location.displayName
      ? { location: e.location.displayName }
      : {}),
    ...(allDay ? { allDay: true } : {}),
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
    serviceCatalog: false,
    staffDirectory: false,
    serviceCatalogWrite: false,
    staffDirectoryWrite: false,
    calendarList: true,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Bearer ${c.accessToken}` } }),
  requestIdHeader: 'request-id',
  parseError: parseGraphError,
  build: (http) => ({
    async checkConnection() {
      const c = await http.resolve();
      return probeConnection('outlook', async () => {
        // Probe the same principal the adapter reads calendars for, so a token
        // scoped to a different mailbox reports dead rather than falsely healthy.
        const res = await http.request(c, { path: who(c) });
        const email = res?.mail ?? res?.userPrincipalName;
        return {
          account: {
            ...(res?.id ? { id: String(res.id) } : {}),
            ...(res?.displayName ? { name: String(res.displayName) } : {}),
            ...(email ? { email: String(email) } : {}),
          },
          raw: res,
        };
      });
    },
    async createBooking(input) {
      assertValidRange(input.range, 'outlook');
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: `${scope(c)}/events`,
        headers: PREFER,
        body: {
          subject: input.title,
          ...outlookTimes(input.range, input.allDay, false),
          ...textFields(input),
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
        headers: PREFER,
      });
      return toBooking(res);
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'outlook');
      assertAllDayInput(input, 'outlook');
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
        headers: PREFER,
        body: {
          ...(input.title !== undefined ? { subject: input.title } : {}),
          ...(input.range ? outlookTimes(input.range, input.allDay, true) : {}),
          ...textFields(input),
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
      const follow = followLink(query.pageToken);
      if (query.limit !== undefined && (query.limit < 1 || query.limit > 1000)) {
        // calendarView documents $top as min 1, max 1000.
        throw new UnibookingError({
          provider: 'outlook',
          code: 'INVALID_INPUT',
          message: `limit must be between 1 and 1000 (got ${query.limit})`,
        });
      }
      const res = follow
        ? await http.request(c, { path: follow, headers: PREFER })
        : await http.request(c, {
            path: `${scope(c)}/calendarView`,
            headers: PREFER,
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

    async listCalendars(query) {
      const c = await http.resolve();
      const follow = followLink(query?.pageToken);
      const res = follow
        ? await http.request(c, { path: follow })
        : await http.request(c, {
            path: `${who(c)}/calendars`,
            query: { $top: query?.limit },
          });
      const calendars = asArray(res?.value, 'outlook', 'calendars.value').map(toCalendar);
      const next = nextLinkFrom(res);
      return { calendars, ...(next !== undefined ? { nextPageToken: next } : {}) };
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
