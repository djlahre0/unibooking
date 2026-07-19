import type { Booking, BookingStatus, Customer } from '../types';
import { defineAdapter, unsupported } from '../adapter-kit';
import { UnibookingError } from '../errors';
import { assertValidRange } from '../time';
import {
  buildICS,
  instantToICalUTC,
  parseCalendarEntries,
  parseICS,
  patchICS,
  type VEvent,
} from '../ical';

/**
 * Apple Calendar / any CalDAV server (iCloud, Fastmail, Nextcloud, …). Speaks
 * WebDAV + iCalendar rather than JSON. Provide the full calendar-collection URL
 * (this package does not run principal discovery). For iCloud, use an
 * app-specific password. No staff/services/availability/webhooks.
 */
export type AppleCredentials = {
  username: string;
  appPassword: string;
  /** The calendar collection URL, e.g. `https://p01-caldav.icloud.com/123/calendars/home/`. */
  calendarUrl: string;
};

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
    raw: ev.raw,
  };
}

function calendarQuery(startBasic: string, endBasic: string): string {
  // `<C:expand>` asks the server to return each in-window recurrence instance as
  // its own VEVENT (concrete DTSTART/DTEND, RRULE removed) rather than the
  // unexpanded master — so a repeating series reports the right in-window times
  // (RFC 4791 §9.6.5), matching how Google/Outlook expand recurrences. Its
  // start/end must be UTC "date with time" values, same as the time-range.
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

export const apple = defineAdapter<AppleCredentials>({
  id: 'apple',
  capabilities: {
    availability: false,
    staff: false,
    services: false,
    webhooks: false,
    idempotency: true,
    customers: false,
  },
  baseUrl: BASE,
  auth: (c) => ({ headers: { authorization: `Basic ${btoa(`${c.username}:${c.appPassword}`)}` } }),
  build: (http) => ({
    async createBooking(input) {
      assertValidRange(input.range, 'apple');
      const c = await http.resolve();
      const uid = input.idempotencyKey ?? globalThis.crypto.randomUUID();
      const ics = buildICS({
        uid,
        start: input.range.start,
        end: input.range.end,
        stamp: now(),
        summary: input.title,
        ...(input.customer?.email ? { attendeeEmail: input.customer.email } : {}),
        ...(input.customer?.name ? { attendeeName: input.customer.name } : {}),
      });
      await http.request(c, {
        method: 'PUT',
        path: resourceUrl(c.calendarUrl, uid),
        // If-None-Match:* makes the PUT a create-only: a colliding UID (or a
        // replayed idempotencyKey) fails with 412 instead of silently
        // overwriting an existing event.
        headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' },
        body: ics,
        parse: 'none',
      });
      return {
        id: uid,
        provider: 'apple',
        title: input.title,
        range: input.range,
        ...(input.customer ? { customer: input.customer } : {}),
        status: 'confirmed',
        raw: { uid, ics },
      };
    },

    async getBooking(id) {
      const c = await http.resolve();
      const text = await http.request<string>(c, {
        path: resourceUrl(c.calendarUrl, id),
        parse: 'text',
      });
      const events = parseICS(text);
      if (events.length === 0 || !events[0]) {
        throw new UnibookingError({ provider: 'apple', code: 'NOT_FOUND', message: `event ${id} not found` });
      }
      // Address by the resource id the caller passed, not the VEVENT UID (they
      // can differ), so the returned booking stays re-fetchable.
      return { ...toBooking(events[0]), id };
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'apple');
      const c = await http.resolve();
      let etag: string | undefined;
      const text = await http.request<string>(c, {
        path: resourceUrl(c.calendarUrl, id),
        parse: 'text',
        onResponse: ({ headers }) => {
          etag = etagOf(headers);
        },
      });
      const current = parseICS(text)[0];
      if (!current || current.start === undefined || current.end === undefined) {
        throw new UnibookingError({ provider: 'apple', code: 'NOT_FOUND', message: `event ${id} not found` });
      }
      // Patch the fetched VCALENDAR in place rather than rebuilding from the lean
      // model — otherwise RRULE, LOCATION, DESCRIPTION, extra attendees, alarms,
      // and VTIMEZONE would be silently dropped on every edit.
      const status =
        input.status !== undefined ? toICalStatus(input.status) : undefined;
      const ics = patchICS(text, {
        stamp: now(),
        ...(input.range ? { start: input.range.start, end: input.range.end } : {}),
        ...(input.title !== undefined ? { summary: input.title } : {}),
        // A status with no iCal form (e.g. no_show) leaves the existing STATUS
        // untouched instead of erasing it.
        ...(status !== undefined ? { status } : {}),
      });
      await http.request(c, {
        method: 'PUT',
        path: resourceUrl(c.calendarUrl, id),
        // If-Match on the captured ETag makes the write fail (412) rather than
        // silently clobber a concurrent edit (lost-update protection).
        headers: {
          'content-type': 'text/calendar; charset=utf-8',
          ...(etag ? { 'if-match': etag } : {}),
        },
        body: ics,
        parse: 'none',
      });
      return { ...toBooking(parseICS(ics)[0]!), id };
    },

    async cancelBooking(id) {
      const c = await http.resolve();
      await http.request(c, {
        method: 'DELETE',
        path: resourceUrl(c.calendarUrl, id),
        parse: 'none',
      });
    },

    async listBookings(query) {
      assertValidRange(query.range, 'apple');
      const c = await http.resolve();
      const xml = await http.request<string>(c, {
        method: 'REPORT',
        path: c.calendarUrl,
        headers: { 'content-type': 'application/xml; charset=utf-8', depth: '1' },
        body: calendarQuery(instantToICalUTC(query.range.start), instantToICalUTC(query.range.end)),
        parse: 'text',
      });
      // Pair each event with its DAV href so the booking id addresses the real
      // resource (a server may store an event under a name that isn't its UID).
      const bookings = parseCalendarEntries(xml).flatMap((entry) => {
        const name = entry.href ? resourceNameFromHref(entry.href) : undefined;
        return parseICS(entry.ics)
          .filter((ev) => ev.start !== undefined && ev.end !== undefined)
          .map((ev) => {
            const b = toBooking(ev);
            return name ? { ...b, id: name } : b;
          });
      });
      return { bookings };
    },

    async searchAvailability(_query) {
      return unsupported('apple', 'availability');
    },
  }),
});
