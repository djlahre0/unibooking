import type { Booking, BookingStatus, Customer } from '../types';
import { defineAdapter, probeConnection, unsupported } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { allDayDates, allDayInstant, assertAllDayInput, assertValidRange } from '../time';
import { discoverCalendars, findPrincipal } from '../caldav';
import {
  buildICS,
  expandRecurrence,
  instantToICalUTC,
  parseCalendarEntries,
  parseICS,
  patchICS,
  type VEvent,
} from '../ical';

/**
 * Apple Calendar / any CalDAV server (iCloud, Fastmail, Nextcloud, …). Speaks
 * WebDAV + iCalendar rather than JSON. For iCloud, use an app-specific password
 * (appleid.apple.com → Sign-In and Security). No staff/services/availability/
 * webhooks.
 *
 * `listCalendars` runs CalDAV discovery from the server root (iCloud by
 * default; any other server via `options.baseUrl`), so an account and password
 * are all a caller needs. Each `Calendar.id` is a collection URL to pass back
 * as `calendarUrl` for event operations. Events carry DESCRIPTION, LOCATION and
 * all-day (`VALUE=DATE`) dates.
 */
export type AppleCredentials = {
  username: string;
  appPassword: string;
  /** The calendar collection URL, e.g. `https://p01-caldav.icloud.com/123/calendars/home/`.
   *  Optional: `listCalendars()` discovers the account's calendars, and each
   *  `Calendar.id` is a valid value. Required for event operations. */
  calendarUrl?: string;
};

/** The collection event operations address. Checked before any request, so a
 *  missing one fails fast with directions instead of an opaque 404. */
function collection(c: AppleCredentials): string {
  if (c.calendarUrl) return c.calendarUrl;
  throw new UnibookingError({
    provider: 'apple',
    code: 'INVALID_INPUT',
    message:
      'Apple event operations need calendarUrl — call listCalendars() and pass a Calendar.id as calendarUrl',
  });
}

const BASE = 'https://caldav.icloud.com/';

function resourceUrl(calendarUrl: string, uid: string): string {
  return `${calendarUrl.replace(/\/$/, '')}/${encodeURIComponent(uid)}.ics`;
}

/** The resource name a listBookings booking id should carry: the last path
 *  segment of the DAV href, minus the `.ics` extension, URL-decoded. Round-trips
 *  through `resourceUrl` even when a server stores an event under a name that
 *  isn't its UID (common for events created outside this library). */
function resourceNameFromHref(href: string): string | undefined {
  const path = href.trim().replace(/\/+$/, '');
  const seg = path.slice(path.lastIndexOf('/') + 1).replace(/\.ics$/i, '');
  if (!seg) return undefined;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function mapStatus(s: string | undefined): BookingStatus {
  switch (s) {
    case undefined:
      // No STATUS on a calendar event is normal and means it's a real booking.
      return 'confirmed';
    case 'CONFIRMED':
      return 'confirmed';
    case 'TENTATIVE':
      return 'pending';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

/** Canonical status → iCal `STATUS` (iCal only models these three). Returns
 *  undefined for statuses with no iCal equivalent so they're left unchanged. */
function toICalStatus(s: BookingStatus | undefined): string | undefined {
  switch (s) {
    case 'confirmed':
    case 'completed':
      return 'CONFIRMED';
    case 'pending':
      return 'TENTATIVE';
    case 'cancelled':
    case 'declined':
      return 'CANCELLED';
    default:
      return undefined;
  }
}

function etagOf(headers: Headers): string | undefined {
  return headers.get('etag') ?? undefined;
}

function customerOf(ev: VEvent): Customer | undefined {
  if (!ev.attendee) return undefined;
  const { email, name } = ev.attendee;
  if (!email && !name) return undefined;
  return { ...(email ? { email } : {}), ...(name ? { name } : {}) };
}

/** The series master (the VEVENT with no RECURRENCE-ID), or the first component
 *  when a resource holds only overrides. Override-before-master ordering is
 *  legal, so reading `events[0]` can report an overridden occurrence's times as
 *  if they were the booking's. */
function masterEvent(events: VEvent[]): VEvent | undefined {
  return events.find((ev) => ev.recurrenceId === undefined) ?? events[0];
}

function toBooking(ev: VEvent): Booking {
  if (ev.start === undefined || ev.end === undefined) {
    throw new UnibookingError({
      provider: 'apple',
      code: 'UPSTREAM',
      message: `VEVENT ${ev.uid} is missing DTSTART/DTEND`,
    });
  }
  const customer = customerOf(ev);
  return {
    id: ev.uid,
    provider: 'apple',
    title: ev.summary ?? '(untitled)',
    range: { start: ev.start, end: ev.end },
    ...(customer ? { customer } : {}),
    status: mapStatus(ev.status),
    ...(ev.description ? { description: ev.description } : {}),
    ...(ev.location ? { location: ev.location } : {}),
    ...(ev.allDay ? { allDay: true } : {}),
    raw: ev.raw,
  };
}

function calendarQuery(startBasic: string, endBasic: string): string {
  // `<C:expand>` asks the server to return each in-window recurrence instance as
  // its own VEVENT (concrete DTSTART/DTEND, RRULE removed) rather than the
  // unexpanded master — so a repeating series reports the right in-window times
  // (RFC 4791 §9.6.5), matching how Google/Outlook expand recurrences. Its
  // start/end must be UTC "date with time" values, same as the time-range.
  // iCloud honors this; servers that ignore it (some Fastmail/Nextcloud/Baïkal
  // setups) return the unexpanded master, which `listBookings` then expands
  // client-side via `expandRecurrence` (a bounded RRULE/EXDATE subset) so those
  // series still report the right in-window occurrences.
  return (
    `<?xml version="1.0" encoding="utf-8" ?>` +
    `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
    `<D:prop><D:getetag/><C:calendar-data><C:expand start="${startBasic}" end="${endBasic}"/></C:calendar-data></D:prop>` +
    `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">` +
    `<C:time-range start="${startBasic}" end="${endBasic}"/>` +
    `</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`
  );
}

const now = (): string => new Date().toISOString();

// CalDAV speaks iCalendar and WebDAV XML, never JSON — the shared default
// `accept: application/json` would be wrong on every request here, and a strict
// server may answer it with 406.
const ACCEPT_ICS = { accept: 'text/calendar' };
const ACCEPT_XML = { accept: 'application/xml' };

export const apple = defineAdapter<AppleCredentials>({
  id: 'apple',
  capabilities: {
    availability: false,
    staff: false,
    services: false,
    webhooks: false,
    idempotency: true,
    customers: false,
    serviceCatalog: false,
    staffDirectory: false,
    serviceCatalogWrite: false,
    staffDirectoryWrite: false,
    calendarList: true,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Basic ${btoa(`${c.username}:${c.appPassword}`)}` } }),
  build: (http) => ({
    async checkConnection() {
      const c = await http.resolve();
      return probeConnection('apple', async () => {
        // CalDAV has no identity endpoint. Without a collection, principal
        // discovery is the cheapest authenticated request; with one, a Depth:0
        // PROPFIND on it also proves the credentials still open that calendar.
        if (!c.calendarUrl) {
          return { account: { name: c.username }, raw: await findPrincipal(http, c, 'apple') };
        }
        const res = await http.request(c, {
          method: 'PROPFIND',
          path: c.calendarUrl,
          headers: { depth: '0' },
          parse: 'text',
        });
        return { account: { name: c.username }, raw: res };
      });
    },
    async createBooking(input) {
      assertValidRange(input.range, 'apple');
      const c = await http.resolve();
      const calendarUrl = collection(c);
      const dates = input.allDay === true ? allDayDates(input.range, 'apple') : undefined;
      const uid = input.idempotencyKey ?? globalThis.crypto.randomUUID();
      const ics = buildICS({
        uid,
        start: dates?.start ?? input.range.start,
        end: dates?.end ?? input.range.end,
        ...(dates ? { allDay: true } : {}),
        stamp: now(),
        summary: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.location ? { location: input.location } : {}),
        ...(input.customer?.email ? { attendeeEmail: input.customer.email } : {}),
        ...(input.customer?.name ? { attendeeName: input.customer.name } : {}),
      });
      await http.request(c, {
        method: 'PUT',
        path: resourceUrl(calendarUrl, uid),
        // If-None-Match:* makes the PUT a create-only: a colliding UID (or a
        // replayed idempotencyKey) fails with 412 instead of silently
        // overwriting an existing event.
        headers: {
          ...ACCEPT_ICS,
          'content-type': 'text/calendar; charset=utf-8',
          'if-none-match': '*',
        },
        body: ics,
        parse: 'none',
      });
      return {
        id: uid,
        provider: 'apple',
        title: input.title,
        // An all-day booking reads back as UTC midnights of its dates, so echo
        // that form rather than the caller's offset-bearing input.
        range: dates
          ? { start: allDayInstant(dates.start), end: allDayInstant(dates.end) }
          : input.range,
        ...(input.customer ? { customer: input.customer } : {}),
        status: 'confirmed',
        ...(input.description ? { description: input.description } : {}),
        ...(input.location ? { location: input.location } : {}),
        ...(dates ? { allDay: true } : {}),
        raw: { uid, ics },
      };
    },

    async getBooking(id) {
      const c = await http.resolve();
      const text = await http.request<string>(c, {
        path: resourceUrl(collection(c), id),
        headers: ACCEPT_ICS,
        parse: 'text',
      });
      const event = masterEvent(parseICS(text));
      if (!event) {
        throw new UnibookingError({
          provider: 'apple',
          code: 'NOT_FOUND',
          message: `event ${id} not found`,
        });
      }
      // Address by the resource id the caller passed, not the VEVENT UID (they
      // can differ), so the returned booking stays re-fetchable.
      return { ...toBooking(event), id };
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'apple');
      assertAllDayInput(input, 'apple');
      const dates =
        input.range && input.allDay === true ? allDayDates(input.range, 'apple') : undefined;
      const c = await http.resolve();
      const calendarUrl = collection(c);
      let etag: string | undefined;
      const text = await http.request<string>(c, {
        path: resourceUrl(calendarUrl, id),
        headers: ACCEPT_ICS,
        parse: 'text',
        onResponse: ({ headers }) => {
          etag = etagOf(headers);
        },
      });
      const current = masterEvent(parseICS(text));
      if (!current || current.start === undefined || current.end === undefined) {
        throw new UnibookingError({
          provider: 'apple',
          code: 'NOT_FOUND',
          message: `event ${id} not found`,
        });
      }
      // Patch the fetched VCALENDAR in place rather than rebuilding from the lean
      // model — otherwise RRULE, LOCATION, DESCRIPTION, extra attendees, alarms,
      // and VTIMEZONE would be silently dropped on every edit.
      const status = input.status !== undefined ? toICalStatus(input.status) : undefined;
      const ics = patchICS(text, {
        stamp: now(),
        ...(dates
          ? { allDay: true, start: dates.start, end: dates.end }
          : input.range
            ? { start: input.range.start, end: input.range.end }
            : {}),
        ...(input.title !== undefined ? { summary: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        // A status with no iCal form (e.g. no_show) leaves the existing STATUS
        // untouched instead of erasing it.
        ...(status !== undefined ? { status } : {}),
      });
      await http.request(c, {
        method: 'PUT',
        path: resourceUrl(calendarUrl, id),
        // If-Match on the captured ETag makes the write fail (412) rather than
        // silently clobber a concurrent edit (lost-update protection).
        headers: {
          ...ACCEPT_ICS,
          'content-type': 'text/calendar; charset=utf-8',
          ...(etag ? { 'if-match': etag } : {}),
        },
        body: ics,
        parse: 'none',
      });
      return { ...toBooking(masterEvent(parseICS(ics))!), id };
    },

    /** Deletes the whole DAV resource. For a recurring series that means the
     *  entire series — CalDAV has no single-instance delete here, and expanded
     *  instances from `listBookings` all share this one id. */
    async cancelBooking(id) {
      const c = await http.resolve();
      await http.request(c, {
        method: 'DELETE',
        path: resourceUrl(collection(c), id),
        headers: ACCEPT_XML,
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'apple');
      const c = await http.resolve();
      const xml = await http.request<string>(c, {
        method: 'REPORT',
        path: collection(c),
        headers: { ...ACCEPT_XML, 'content-type': 'application/xml; charset=utf-8', depth: '1' },
        body: calendarQuery(instantToICalUTC(query.range.start), instantToICalUTC(query.range.end)),
        parse: 'text',
      });
      // Pair each event with its DAV href so the booking id addresses the real
      // resource (a server may store an event under a name that isn't its UID).
      let bookings = parseCalendarEntries(xml).flatMap((entry) => {
        const name = entry.href ? resourceNameFromHref(entry.href) : undefined;
        return (
          parseICS(entry.ics)
            // Client-side RRULE fallback: a server-expanded instance has no RRULE
            // and passes through untouched, but a server that ignored `<C:expand>`
            // returns the master (RRULE intact) — expand it locally to the right
            // in-window occurrences. All occurrences of one resource keep its id.
            .flatMap((ev) => expandRecurrence(ev, query.range.start, query.range.end))
            .filter((ev) => ev.start !== undefined && ev.end !== undefined)
            .map((ev) => {
              const b = toBooking(ev);
              return name ? { ...b, id: name } : b;
            })
        );
      });
      // CalDAV's calendar-query filters by time range only, so `status` and
      // `limit` are applied here rather than silently ignored. There is no
      // paging to resume, hence never a nextPageToken.
      if (query.status !== undefined) bookings = bookings.filter((b) => b.status === query.status);
      if (query.limit !== undefined && query.limit >= 0) bookings = bookings.slice(0, query.limit);
      return { bookings };
    },

    async searchAvailability(_query) {
      return unsupported('apple', 'availability');
    },

    // Discovery has no paging to resume, so there is never a nextPageToken;
    // defineAdapter's backstop applies `limit` to the single page.
    async listCalendars() {
      const c = await http.resolve();
      return { calendars: await discoverCalendars(http, c, 'apple') };
    },
  }),
});
