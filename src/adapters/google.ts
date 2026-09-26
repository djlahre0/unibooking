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
} from '../adapter-kit';
import { UnibookingError, isUnibookingError } from '../errors';
import { allDayDates, allDayInstant, assertAllDayInput, assertValidRange } from '../time';
import { assertSlotRules, computeSlots, slotRulesOf } from '../availability';
import type { HttpContext } from '../http';

/**
 * Google Calendar (v3). A plain calendar: no native concept of staff or
 * services, so those capabilities are false. `availability` is derived from the
 * freeBusy API — free slots are the gaps between busy intervals — which returns
 * busy blocks only, so `searchAvailability` requires a positive `durationMinutes`
 * to size each slot. The canonical slot rules (`intervalMinutes`,
 * `workingHours`, buffers, `minNoticeMinutes`) are applied locally, and slots
 * that have already started are dropped. `idempotency` is false because Google only accepts
 * client-supplied event ids in a restricted format — pass such an id via
 * `providerOptions.id` if you need it.
 *
 * `listCalendars` reads the user's calendar list; each `Calendar.id` is a valid
 * `calendarId`. Events carry `description`, `location` and all-day dates
 * (`start.date`/`end.date`, end exclusive) natively.
 */
export type GoogleCredentials = {
  /** OAuth2 access token (scope `https://www.googleapis.com/auth/calendar`). */
  accessToken: string;
  /** Target calendar. Defaults to `'primary'`. */
  calendarId?: string;
};

const BASE = 'https://www.googleapis.com/calendar/v3/';

/** The calendar id exactly as the API expects it inside a JSON body or as a
 *  response key. */
function rawCalId(c: GoogleCredentials): string {
  return c.calendarId ?? 'primary';
}

/** The same id escaped for a URL path segment. Never use this in a request body:
 *  freeBusy's `items[]` entry and the `calendars` key it answers with are both
 *  raw, and every calendar id except `primary` contains an `@`. */
function calId(c: GoogleCredentials): string {
  return encodeURIComponent(rawCalId(c));
}

function point(instant: string, timezone: string | undefined): Record<string, unknown> {
  return { dateTime: instant, ...(timezone !== undefined ? { timeZone: timezone } : {}) };
}

/** Canonical `notify` → Google's `sendUpdates` query value. Undefined leaves it
 *  to Google's default (no notifications). */
function sendUpdatesFor(notify: boolean | undefined): 'all' | 'none' | undefined {
  return notify === true ? 'all' : notify === false ? 'none' : undefined;
}

/** Canonical range → Google `start`/`end`. On update, `clear` nulls the other
 *  representation: PATCH merges, so switching a timed event to all-day (or
 *  back) would otherwise leave both `date` and `dateTime` set, which Google
 *  rejects. */
function eventTimes(
  range: TimeRange,
  allDay: boolean | undefined,
  clear: boolean,
): Record<string, unknown> {
  if (allDay === true) {
    const d = allDayDates(range, 'google');
    const other = clear ? { dateTime: null } : {};
    return { start: { date: d.start, ...other }, end: { date: d.end, ...other } };
  }
  const other = clear ? { date: null } : {};
  return {
    start: { ...point(range.start, range.timezone), ...other },
    end: { ...point(range.end, range.timezone), ...other },
  };
}

/** `description`/`location` as given. An empty string is sent too: it clears. */
function textFields(input: { description?: string; location?: string }): Record<string, unknown> {
  return {
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
  };
}

/** The calendarList entry for a calendar, after setting its colour if given.
 *  RGB colours need `colorRgbFormat=true` and a foreground to go with them. */
async function readCalendarEntry(
  http: HttpContext<GoogleCredentials>,
  c: GoogleCredentials,
  id: string,
  color: string | undefined,
): Promise<Calendar> {
  const path = `users/me/calendarList/${encodeURIComponent(id)}`;
  const bg = color ? hexColor(color) : undefined;
  if (color && !bg) {
    throw new UnibookingError({
      provider: 'google',
      code: 'INVALID_INPUT',
      message: 'color must be #RRGGBB',
    });
  }
  const res = bg
    ? await http.request(c, {
        method: 'PATCH',
        path,
        query: { colorRgbFormat: true },
        body: { backgroundColor: bg, foregroundColor: readableOn(bg) },
      })
    : await http.request(c, { path });
  return toCalendar(res);
}

/** Black or white, whichever reads better on `hex`. */
function readableOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? '#000000' : '#ffffff';
}

function toCalendar(raw: unknown): Calendar {
  const c = asRecord(raw, 'google', 'calendarListEntry');
  const id = reqString(c.id, 'google', 'calendarListEntry.id');
  // summaryOverride is the user's own rename of a calendar shared with them.
  const name = [c.summaryOverride, c.summary].find(
    (v): v is string => typeof v === 'string' && v !== '',
  );
  const color = hexColor(c.backgroundColor);
  return {
    id,
    name: name ?? id,
    ...(typeof c.timeZone === 'string' && c.timeZone ? { timezone: c.timeZone } : {}),
    primary: c.primary === true,
    // `reader` and `freeBusyReader` cannot write events; only these two can.
    readOnly: c.accessRole !== 'owner' && c.accessRole !== 'writer',
    ...(color ? { color } : {}),
    raw: c,
  };
}

function pointToInstant(p: any): string | undefined {
  if (!p || typeof p !== 'object') return undefined;
  if (typeof p.dateTime === 'string') return p.dateTime;
  // All-day event: date-only, and `end.date` is exclusive — appending midnight
  // UTC keeps the canonical `end > start` invariant.
  if (typeof p.date === 'string') return allDayInstant(p.date);
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

/** The guest a booking is for: the first attendee who is not the organizer,
 *  not the calendar this copy lives on (`self`) and not a room or resource.
 *  Google lists the organizer among the attendees whenever they also attend,
 *  which is every meeting created in its own UI — so `attendees[0]` named the
 *  calendar owner as the customer of their own event. */
function guestOf(attendees: unknown): any {
  if (!Array.isArray(attendees)) return undefined;
  return attendees.find(
    (a) => a && typeof a === 'object' && !a.organizer && !a.self && !a.resource,
  );
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
  const attendee = guestOf(e.attendees);
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
    ...(typeof e.description === 'string' && e.description ? { description: e.description } : {}),
    ...(typeof e.location === 'string' && e.location ? { location: e.location } : {}),
    ...(typeof e.start?.date === 'string' && typeof e.start?.dateTime !== 'string'
      ? { allDay: true }
      : {}),
    // `singleEvents` listing hands back instances whose own id edits or
    // deletes just that instance; `recurringEventId` is the series.
    ...(typeof e.recurringEventId === 'string' && e.recurringEventId
      ? { seriesId: e.recurringEventId }
      : {}),
    ...(typeof e.etag === 'string' && e.etag ? { version: e.etag } : {}),
    raw: e,
  };
}

/** Google echoes the requested calendar id back as the `calendars` key, but it
 *  normalizes email-form ids to lowercase — so an exact match is not guaranteed
 *  even when the request carried the id verbatim. Widen the lookup rather than
 *  reporting a calendar Google actually answered for. */
function resolveCalendarEntry(calendars: Record<string, any>, id: string): Record<string, any> {
  if (calendars[id] !== undefined) {
    return asRecord(calendars[id], 'google', `freeBusy.calendars[${id}]`);
  }
  const lower = id.toLowerCase();
  for (const [key, value] of Object.entries(calendars)) {
    if (key.toLowerCase() === lower) {
      return asRecord(value, 'google', `freeBusy.calendars[${key}]`);
    }
  }
  // Exactly one calendar was requested, so a lone entry can only be that one.
  const keys = Object.keys(calendars);
  const only = keys.length === 1 ? keys[0] : undefined;
  if (only !== undefined) {
    return asRecord(calendars[only], 'google', `freeBusy.calendars[${only}]`);
  }
  throw new UnibookingError({
    provider: 'google',
    code: 'UPSTREAM',
    message: `freeBusy returned no entry for calendar "${id}"`,
  });
}

/** Google's own ceiling on a channel's `token` (events.watch). */
const MAX_CHANNEL_TOKEN = 256;
/** Default channel lifetime, and the most this adapter asks for: Google caps
 *  events channels itself and reports the real end in `expiration`. */
const DEFAULT_WATCH_TTL_S = 7 * 24 * 60 * 60;

/** `If-Match` for a versioned write. Google answers a stale ETag with 412,
 *  which `codeForStatus` maps to CONFLICT. */
function ifMatch(version: string | undefined): Record<string, string> | undefined {
  return version !== undefined ? { 'if-match': version } : undefined;
}

function assertWatchInput(input: WatchInput): void {
  const problem = !/^https:\/\//i.test(input.address)
    ? 'watch address must be an https URL (Google delivers to HTTPS only)'
    : !input.token
      ? 'watch token is required: it is how a notification proves it came from this channel'
      : input.token.length > MAX_CHANNEL_TOKEN
        ? `watch token must be at most ${MAX_CHANNEL_TOKEN} characters`
        : input.ttlSeconds !== undefined && !(input.ttlSeconds > 0)
          ? 'ttlSeconds must be positive'
          : undefined;
  if (problem)
    throw new UnibookingError({ provider: 'google', code: 'INVALID_INPUT', message: problem });
}

function toWatch(raw: unknown): Watch {
  const ch = asRecord(raw, 'google', 'channel');
  const expiration = Number(ch.expiration);
  return {
    id: reqString(ch.id, 'google', 'channel.id'),
    provider: 'google',
    ...(typeof ch.resourceId === 'string' && ch.resourceId ? { resourceId: ch.resourceId } : {}),
    ...(Number.isFinite(expiration) && expiration > 0
      ? { expiresAt: new Date(expiration).toISOString() }
      : {}),
    raw: ch,
  };
}

/** events.watch on the client's calendar: a fresh channel id every time,
 *  since Google refuses to reuse one. */
async function openChannel(
  http: HttpContext<GoogleCredentials>,
  c: GoogleCredentials,
  input: WatchInput,
): Promise<Watch> {
  const res = await http.request(c, {
    method: 'POST',
    path: `calendars/${calId(c)}/events/watch`,
    body: {
      id: globalThis.crypto.randomUUID(),
      type: 'web_hook',
      address: input.address,
      token: input.token,
      params: { ttl: String(Math.round(input.ttlSeconds ?? DEFAULT_WATCH_TTL_S)) },
    },
  });
  return toWatch(res);
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
    customerDirectory: false,
    customerWrite: false,
    customerDelete: false,
    serviceCatalog: false,
    staffDirectory: false,
    serviceCatalogWrite: false,
    staffDirectoryWrite: false,
    staffDeactivate: false,
    staffDelete: false,
    serviceDelete: false,
    calendarList: true,
    calendarWrite: true,
    staffServiceAssignment: false,
    staffServiceAssignmentWrite: false,
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
  parseError: parseGoogleError,
  build: (http, env) => ({
    async checkConnection() {
      const c = await http.resolve();
      return probeConnection('google', async () => {
        const res = await http.request(c, {
          path: 'users/me/calendarList',
          query: { maxResults: 1 },
        });
        const first = asArray(res?.items, 'google', 'calendarList.items')[0];
        return {
          ...(first?.id ? { account: { id: String(first.id) } } : {}),
          raw: res,
        };
      });
    },
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
          ...eventTimes(input.range, input.allDay, false),
          ...textFields(input),
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
      assertAllDayInput(input, 'google');
      const c = await http.resolve();
      // Google models tentative/confirmed/cancelled as the event `status`, so a
      // canonical status update maps straight onto it (a status with no Google
      // form leaves the field untouched).
      const status = toGoogleStatus(input.status);
      const headers = ifMatch(input.ifVersion);
      const res = await http.request(c, {
        method: 'PATCH',
        path: `calendars/${calId(c)}/events/${encodeURIComponent(id)}`,
        query: { sendUpdates: sendUpdatesFor(input.notify) },
        ...(headers ? { headers } : {}),
        body: {
          ...(input.title !== undefined ? { summary: input.title } : {}),
          ...(input.range ? eventTimes(input.range, input.allDay, true) : {}),
          ...textFields(input),
          ...(status !== undefined ? { status } : {}),
          ...input.providerOptions,
        },
      });
      return toBooking(res);
    },

    async cancelBooking(id, options) {
      const c = await http.resolve();
      const sendUpdates = sendUpdatesFor(options?.notify);
      const headers = ifMatch(options?.ifVersion);
      await http.request(c, {
        method: 'DELETE',
        path: `calendars/${calId(c)}/events/${encodeURIComponent(id)}`,
        query: { sendUpdates },
        ...(headers ? { headers } : {}),
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

    /**
     * Incremental sync (events.list with a sync token). Recurring events come
     * back as instances, like `listBookings`. A deleted or cancelled event is a
     * `delete`; the first, full sync leaves those out, since there is nothing
     * to remove yet. An expired token (HTTP 410) is `fullSyncRequired`.
     */
    async syncBookings(query = {}) {
      if (query.range) assertValidRange(query.range, 'google');
      const full = query.syncToken === undefined;
      const c = await http.resolve();
      let res: any;
      try {
        res = await http.request(c, {
          path: `calendars/${calId(c)}/events`,
          query: {
            singleEvents: true,
            // Required for incremental rounds; sent on every page so the
            // round's query parameters stay identical, as Google asks.
            showDeleted: true,
            maxResults: 250,
            syncToken: query.syncToken,
            pageToken: query.pageToken,
            // Google refuses a time window alongside a sync token; it bounds
            // the full sync only.
            ...(full && query.range
              ? { timeMin: query.range.start, timeMax: query.range.end }
              : {}),
          },
        });
      } catch (e) {
        if (isUnibookingError(e) && e.httpStatus === 410) {
          return { changes: [], fullSyncRequired: true };
        }
        throw e;
      }
      const changes: BookingChange[] = [];
      for (const raw of asArray(res?.items, 'google', 'events.items')) {
        const e = asRecord(raw, 'google', 'event');
        if (e.status === 'cancelled') {
          if (!full) changes.push({ type: 'delete', id: reqString(e.id, 'google', 'event.id') });
          continue;
        }
        changes.push({ type: 'upsert', booking: toBooking(e) });
      }
      return {
        changes,
        ...(typeof res?.nextPageToken === 'string' && res.nextPageToken
          ? { nextPageToken: res.nextPageToken }
          : {}),
        ...(typeof res?.nextSyncToken === 'string' && res.nextSyncToken
          ? { syncToken: res.nextSyncToken }
          : {}),
      };
    },

    /** events.watch: Google POSTs to `input.address` (headers only, no body)
     *  whenever the calendar's events change — then call `syncBookings`. */
    async watchBookings(input) {
      assertWatchInput(input);
      return openChannel(http, await http.resolve(), input);
    },

    /** Google channels cannot be extended: a new channel is opened, then the
     *  old one stopped. Stopping is best effort — if it fails the old channel
     *  still expires by itself, and throwing would lose the new one. */
    async renewWatch(watch, input) {
      assertWatchInput(input);
      const c = await http.resolve();
      const next = await openChannel(http, c, input);
      if (watch.resourceId) {
        await http
          .request(c, {
            method: 'POST',
            path: 'channels/stop',
            body: { id: watch.id, resourceId: watch.resourceId },
            parse: 'none',
          })
          .catch(() => undefined);
      }
      return next;
    },

    async stopWatch(watch) {
      if (!watch.resourceId) {
        throw new UnibookingError({
          provider: 'google',
          code: 'INVALID_INPUT',
          message: 'stopping a Google channel needs the resourceId it was created with',
        });
      }
      const c = await http.resolve();
      try {
        await http.request(c, {
          method: 'POST',
          path: 'channels/stop',
          body: { id: watch.id, resourceId: watch.resourceId },
          parse: 'none',
        });
      } catch (e) {
        // Already expired or stopped: the state the caller asked for.
        if (isUnibookingError(e) && e.code === 'NOT_FOUND') return;
        throw e;
      }
    },

    // The calendar itself (name, zone, description) lives on /calendars; its
    // colour is per-user, on the calendarList entry. The entry is also what
    // listCalendars maps, so it is what these return.
    async createCalendar(input) {
      if (!input.name?.trim()) {
        throw new UnibookingError({
          provider: 'google',
          code: 'INVALID_INPUT',
          message: 'createCalendar requires a name',
        });
      }
      const c = await http.resolve();
      const created = await http.request(c, {
        method: 'POST',
        path: 'calendars',
        body: {
          summary: input.name.trim(),
          ...(input.timezone ? { timeZone: input.timezone } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...input.providerOptions,
        },
      });
      const id = reqString(created?.id, 'google', 'calendar.id');
      return readCalendarEntry(http, c, id, input.color);
    },

    async updateCalendar(id, input) {
      const c = await http.resolve();
      const body = {
        ...(input.name !== undefined ? { summary: input.name } : {}),
        ...(input.timezone !== undefined ? { timeZone: input.timezone } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...input.providerOptions,
      };
      if (Object.keys(body).length > 0) {
        await http.request(c, {
          method: 'PATCH',
          path: `calendars/${encodeURIComponent(id)}`,
          body,
        });
      }
      return readCalendarEntry(http, c, id, input.color);
    },

    async deleteCalendar(id) {
      if (id === 'primary') {
        throw new UnibookingError({
          provider: 'google',
          code: 'INVALID_INPUT',
          message: "The primary calendar can't be deleted",
        });
      }
      const c = await http.resolve();
      await http.request(c, {
        method: 'DELETE',
        path: `calendars/${encodeURIComponent(id)}`,
        parse: 'none',
      });
    },

    async listCalendars(query) {
      const c = await http.resolve();
      const res = await http.request(c, {
        path: 'users/me/calendarList',
        query: { maxResults: query?.limit, pageToken: query?.pageToken },
      });
      return {
        calendars: asArray(res?.items, 'google', 'calendarList.items').map(toCalendar),
        ...(typeof res?.nextPageToken === 'string' && res.nextPageToken
          ? { nextPageToken: res.nextPageToken }
          : {}),
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
      assertSlotRules(query, 'google');
      const durationMinutes = query.durationMinutes;
      const c = await http.resolve();
      const id = rawCalId(c);
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
      const cal = resolveCalendarEntry(
        asRecord(res?.calendars, 'google', 'freeBusy.calendars'),
        id,
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
      // A slot that has already started is never bookable. Booking platforms
      // drop those server-side; a busy-time complement has to do it here, or
      // the same query answers differently per provider.
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
