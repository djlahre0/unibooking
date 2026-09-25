import type {
  AvailabilitySlot,
  Booking,
  BookingChange,
  BookingStatus,
  Calendar,
  TimeRange,
  Watch,
  WatchInput,
} from '../types';
import {
  asArray,
  asRecord,
  defineAdapter,
  hexColor,
  probeConnection,
  reqString,
  unsupported,
} from '../adapter-kit';
import { UnibookingError, isUnibookingError } from '../errors';
import {
  allDayDates,
  allDayInstant,
  assertAllDayInput,
  assertValidRange,
  instantToZoned,
  wallClockIn,
} from '../time';
import { assertSlotRules, computeSlots, slotRulesOf, type BusyInterval } from '../availability';
import { graphDateTime, graphToInstant, nextLinkFrom, parseGraphError, PREFER_UTC } from '../graph';

/**
 * Outlook / Microsoft 365 calendars via Microsoft Graph. A plain calendar (no
 * staff/services). `availability` is the complement of busy time and needs a
 * positive `durationMinutes` to size each slot. Busy time comes from the
 * target calendar's own events (calendarView), which respects `calendarId` and
 * works for personal Microsoft accounts; `providerOptions.schedules`/`mailbox`
 * instead asks getSchedule for those mailboxes' free/busy (work or school
 * accounts only). The canonical slot rules are applied locally, and slots that
 * have already started are dropped. `idempotency` maps to Graph's event
 * `transactionId`. Scope: `Calendars.ReadWrite`.
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

/** The mailbox SMTP address(es) the caller asked getSchedule about, from
 *  `providerOptions.schedules` (string | string[]) or `providerOptions.mailbox`;
 *  undefined when neither is given, which selects the calendarView path. */
function requestedSchedules(
  providerOptions: Record<string, unknown> | undefined,
): string[] | undefined {
  const po = providerOptions ?? {};
  const fromSchedules = po.schedules;
  if (typeof fromSchedules === 'string' && fromSchedules) return [fromSchedules];
  if (Array.isArray(fromSchedules)) {
    const list = fromSchedules.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (list.length > 0) return list;
  }
  if (typeof po.mailbox === 'string' && po.mailbox) return [po.mailbox];
  return undefined;
}

/** getSchedule's `availabilityViewInterval` is documented as 5–1440 minutes
 *  and only sizes the `availabilityView` string, which this adapter does not
 *  read — slots are cut from `scheduleItems`. Clamped so a 2-minute or a
 *  two-day slot length is not rejected over a field nothing uses. */
function viewInterval(durationMinutes: number): number {
  return Math.min(1440, Math.max(5, Math.round(durationMinutes)));
}

/** How many calendarView pages availability reads before refusing the window.
 *  Each page is up to 1000 events; a window busier than that is a query to
 *  narrow, not one to answer from a silent prefix of the calendar. */
const MAX_BUSY_PAGES = 10;

/** Whether an event occupies its time: not cancelled and not shown as free.
 *  Tentative, out-of-office, working-elsewhere and unknown all block, matching
 *  the getSchedule path. */
function blocksTime(e: any): boolean {
  return e?.isCancelled !== true && e?.showAs !== 'free';
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
  // The guest: the first attendee who is neither a room/equipment resource
  // nor the organizer (Graph includes the organizer in `attendees` on events
  // copied onto an attendee's calendar).
  const organizer =
    typeof e.organizer?.emailAddress?.address === 'string'
      ? e.organizer.emailAddress.address.toLowerCase()
      : undefined;
  const att = Array.isArray(e.attendees)
    ? e.attendees.find(
        (a: any) =>
          a?.type !== 'resource' &&
          !(
            organizer !== undefined &&
            typeof a?.emailAddress?.address === 'string' &&
            a.emailAddress.address.toLowerCase() === organizer
          ),
      )?.emailAddress
    : undefined;
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
    // calendarView expands a series into occurrences (and exceptions) whose own
    // id addresses just that one; `seriesMasterId` is the series.
    ...(typeof e.seriesMasterId === 'string' && e.seriesMasterId && e.type !== 'seriesMaster'
      ? { seriesId: e.seriesMasterId }
      : {}),
    ...(typeof e['@odata.etag'] === 'string' && e['@odata.etag']
      ? { version: e['@odata.etag'] }
      : {}),
    raw: e,
  };
}

/** `If-Match` for a versioned write: Graph compares it with the event's
 *  `@odata.etag` and answers a stale one with 412 → CONFLICT. */
function ifMatch(version: string | undefined): Record<string, string> {
  return version !== undefined ? { 'if-match': version } : {};
}

/** Delta pages: the event representation `listBookings` reads, plus a page
 *  size (delta ignores `$top`). */
const PREFER_DELTA = { prefer: `${PREFER.prefer}, odata.maxpagesize=100` };

/** Graph's documented ceiling for an Outlook event subscription is 10,080
 *  minutes; ask for a little less so clock skew cannot push a request over it
 *  (Graph says requests past the maximum will fail). */
const MAX_SUBSCRIPTION_MS = (10_080 - 10) * 60_000;
const DEFAULT_WATCH_TTL_S = 7 * 24 * 60 * 60;
/** Graph's documented maximum `clientState` length. */
const MAX_CLIENT_STATE = 128;

/** Graph error codes that mean "this delta token is no longer usable". */
const RESYNC_CODES = new Set(['SyncStateNotFound', 'SyncStateInvalid', 'resyncRequired']);

function assertWatchInput(input: WatchInput): void {
  const https = /^https:\/\//i;
  const problem = !https.test(input.address)
    ? 'watch address must be an https URL (Graph delivers to HTTPS only)'
    : input.lifecycleAddress !== undefined && !https.test(input.lifecycleAddress)
      ? 'lifecycleAddress must be an https URL'
      : !input.token
        ? 'watch token is required: Graph echoes it as clientState on every notification'
        : input.token.length > MAX_CLIENT_STATE
          ? `watch token must be at most ${MAX_CLIENT_STATE} characters (Graph clientState)`
          : input.ttlSeconds !== undefined && !(input.ttlSeconds > 0)
            ? 'ttlSeconds must be positive'
            : undefined;
  if (problem) {
    throw new UnibookingError({ provider: 'outlook', code: 'INVALID_INPUT', message: problem });
  }
}

function subscriptionExpiry(nowMs: number, ttlSeconds: number | undefined): string {
  const ttlMs = Math.min((ttlSeconds ?? DEFAULT_WATCH_TTL_S) * 1000, MAX_SUBSCRIPTION_MS);
  return new Date(nowMs + ttlMs).toISOString();
}

function toWatch(raw: unknown): Watch {
  const sub = asRecord(raw, 'outlook', 'subscription');
  return {
    id: reqString(sub.id, 'outlook', 'subscription.id'),
    provider: 'outlook',
    ...(typeof sub.expirationDateTime === 'string' && sub.expirationDateTime
      ? { expiresAt: sub.expirationDateTime }
      : {}),
    raw: sub,
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
    staffServiceAssignment: false,
    serviceCategories: false,
    businessHours: false,
    classCatalog: false,
    classEnrollment: false,
    classWaitlist: false,
    changeFeed: true,
    changeNotifications: true,
    versionedWrites: true,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Bearer ${c.accessToken}` } }),
  requestIdHeader: 'request-id',
  parseError: parseGraphError,
  build: (http, env) => ({
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
        headers: { ...PREFER, ...ifMatch(input.ifVersion) },
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
        // The cancel action documents no If-Match, so a version guard is
        // checked by reading the event first. A change landing between the
        // read and the cancel is not caught; DELETE below is fully guarded.
        if (options.ifVersion !== undefined) {
          const current = await http.request(c, {
            path: `${scope(c)}/events/${encodeURIComponent(id)}`,
            headers: PREFER,
            query: { $select: 'id' },
          });
          if (current?.['@odata.etag'] !== options.ifVersion) {
            throw new UnibookingError({
              provider: 'outlook',
              code: 'CONFLICT',
              message: 'the event changed since it was read (ifVersion no longer matches)',
            });
          }
        }
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
        headers: ifMatch(options?.ifVersion),
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

    /**
     * Incremental sync via calendarView delta. The token is the full
     * `@odata.deltaLink` (and a page token the `@odata.nextLink`), followed
     * verbatim as Graph requires. Graph v1.0 documents delta for the user's
     * default calendar only, so a client pinned to a `calendarId` cannot sync.
     * The window (`range`) is required on the first round and kept for every
     * later one. Removed events — and events that left the window — arrive as
     * deletes. An expired token (410) is `fullSyncRequired`.
     */
    async syncBookings(query = {}) {
      if (query.range) assertValidRange(query.range, 'outlook');
      const follow = followLink(query.pageToken ?? query.syncToken);
      if (!follow && !query.range) {
        throw new UnibookingError({
          provider: 'outlook',
          code: 'INVALID_INPUT',
          message: 'the first Outlook sync needs a range: calendarView delta tracks one window',
        });
      }
      const c = await http.resolve();
      if (c.calendarId) {
        return unsupported(
          'outlook',
          'syncBookings on a specific calendarId (Graph v1.0 delta covers the default calendar only)',
        );
      }
      let res: any;
      try {
        res = follow
          ? await http.request(c, { path: follow, headers: PREFER_DELTA })
          : await http.request(c, {
              path: `${who(c)}/calendarView/delta`,
              headers: PREFER_DELTA,
              query: { startDateTime: query.range!.start, endDateTime: query.range!.end },
            });
      } catch (e) {
        if (
          isUnibookingError(e) &&
          (e.httpStatus === 410 ||
            (e.providerCode !== undefined && RESYNC_CODES.has(e.providerCode)))
        ) {
          return { changes: [], fullSyncRequired: true };
        }
        throw e;
      }
      const changes: BookingChange[] = asArray(res?.value, 'outlook', 'delta.value').map(
        (item: any): BookingChange =>
          item && typeof item === 'object' && '@removed' in item
            ? { type: 'delete', id: reqString(item.id, 'outlook', 'delta.id') }
            : { type: 'upsert', booking: toBooking(item) },
      );
      const next = nextLinkFrom(res);
      const delta =
        typeof res?.['@odata.deltaLink'] === 'string' && res['@odata.deltaLink']
          ? res['@odata.deltaLink']
          : undefined;
      return {
        changes,
        ...(next !== undefined ? { nextPageToken: next } : {}),
        ...(delta !== undefined ? { syncToken: delta } : {}),
      };
    },

    /** A Graph subscription to the calendar's events. Graph validates
     *  `input.address` synchronously while creating it — the endpoint must
     *  already answer the `validationToken` handshake (see
     *  `graphValidationToken` in `unibooking/webhooks/outlook`). */
    async watchBookings(input) {
      assertWatchInput(input);
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'POST',
        path: 'subscriptions',
        body: {
          changeType: 'created,updated,deleted',
          notificationUrl: input.address,
          resource: `${scope(c)}/events`,
          expirationDateTime: subscriptionExpiry(env.now(), input.ttlSeconds),
          clientState: input.token,
          ...(input.lifecycleAddress ? { lifecycleNotificationUrl: input.lifecycleAddress } : {}),
        },
      });
      return toWatch(res);
    },

    async renewWatch(watch, input) {
      assertWatchInput(input);
      const c = await http.resolve();
      const res = await http.request(c, {
        method: 'PATCH',
        path: `subscriptions/${encodeURIComponent(watch.id)}`,
        body: { expirationDateTime: subscriptionExpiry(env.now(), input.ttlSeconds) },
      });
      return toWatch(res);
    },

    async stopWatch(watch) {
      const c = await http.resolve();
      try {
        await http.request(c, {
          method: 'DELETE',
          path: `subscriptions/${encodeURIComponent(watch.id)}`,
          parse: 'none',
        });
      } catch (e) {
        // Already expired or deleted: the state the caller asked for.
        if (isUnibookingError(e) && e.code === 'NOT_FOUND') return;
        throw e;
      }
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
            'Outlook exposes busy time only; pass a positive durationMinutes to size each slot',
        });
      }
      assertSlotRules(query, 'outlook');
      const durationMinutes = query.durationMinutes;
      const c = await http.resolve();
      const schedules = requestedSchedules(query.providerOptions);
      const toBusy = (items: any[]): BusyInterval[] =>
        items.flatMap((it: any): BusyInterval[] => {
          const start = graphToInstant(it?.start);
          const end = graphToInstant(it?.end);
          return start !== undefined && end !== undefined ? [{ start, end }] : [];
        });

      let busy: BusyInterval[];
      if (schedules) {
        // getSchedule lives under the mailbox calendar, never a specific
        // calendarId, so target `${who}/calendar` rather than `scope(c)`.
        // Microsoft documents it as unavailable to personal accounts.
        const res = await http.request(c, {
          method: 'POST',
          path: `${who(c)}/calendar/getSchedule`,
          headers: PREFER_UTC,
          body: {
            schedules,
            startTime: graphDateTime(query.range.start),
            endTime: graphDateTime(query.range.end),
            availabilityViewInterval: viewInterval(durationMinutes),
          },
        });
        const first = asArray(res?.value, 'outlook', 'getSchedule.value')[0];
        const items = asArray(first?.scheduleItems, 'outlook', 'getSchedule.scheduleItems');
        // Everything that is NOT 'free' (busy/tentative/oof/workingElsewhere/
        // unknown) blocks a booking; drop items whose Graph times don't convert.
        busy = toBusy(items.filter((it: any) => it?.status !== 'free'));
      } else {
        // The target calendar's own events, recurrences expanded. This is the
        // path every account type supports, and the only one that can honour
        // `calendarId` — getSchedule answers for a whole mailbox.
        const events: any[] = [];
        let next: string | undefined;
        for (let page = 0; ; page++) {
          if (page === MAX_BUSY_PAGES) {
            throw new UnibookingError({
              provider: 'outlook',
              code: 'INVALID_INPUT',
              message: `more than ${MAX_BUSY_PAGES * 1000} events in the availability window; narrow the range`,
            });
          }
          const res = next
            ? await http.request(c, { path: next, headers: PREFER_UTC })
            : await http.request(c, {
                path: `${scope(c)}/calendarView`,
                headers: PREFER_UTC,
                query: {
                  startDateTime: query.range.start,
                  endDateTime: query.range.end,
                  $select: 'start,end,showAs,isCancelled',
                  $top: 1000,
                },
              });
          events.push(...asArray(res?.value, 'outlook', 'calendarView.value'));
          next = nextLinkFrom(res);
          if (!next) break;
        }
        busy = toBusy(events.filter(blocksTime));
      }
      return computeSlots({
        range: query.range,
        durationMinutes,
        busy,
        ...slotRulesOf(query),
        now: env.now(),
      });
    },
  }),
});
