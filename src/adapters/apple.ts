import type { Booking, BookingChange, BookingStatus, Customer } from '../types';
import { defineAdapter, probeConnection, unsupported } from '../adapter-kit';
import { UnibookingError, isUnibookingError } from '../errors';
import {
  allDayDates,
  allDayInstant,
  assertAllDayInput,
  assertValidRange,
  formatWithOffset,
} from '../time';
import {
  discoverCalendars,
  findPrincipal,
  multigetBody,
  parseSyncCollection,
  syncCollectionBody,
} from '../caldav';
import {
  buildICS,
  excludeOccurrenceICS,
  expandRecurrence,
  instantToICalUTC,
  occurrenceKey,
  overrideICS,
  parseCalendarEntries,
  parseICS,
  parseOccurrenceKey,
  patchICS,
  type OccurrenceRef,
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
 *
 * Booking ids are the DAV resource name. One occurrence of a recurring series
 * is `<resource>::<original start>` (`series-1::20260727T220000Z`, or
 * `…::20260727` for an all-day series) with `seriesId` naming the resource:
 * updating it writes a RECURRENCE-ID override and cancelling it adds an EXDATE,
 * so the rest of the series is untouched. The resource id addresses the whole
 * series.
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

/** An occurrence id split into its series resource and the occurrence, or
 *  undefined for a plain resource id. */
function occurrenceOf(id: string): { resource: string; ref: OccurrenceRef } | undefined {
  const cut = id.lastIndexOf('::');
  if (cut <= 0) return undefined;
  const ref = parseOccurrenceKey(id.slice(cut + 2));
  return ref ? { resource: id.slice(0, cut), ref } : undefined;
}

/** The booking id a listed VEVENT gets: its resource name, plus the occurrence
 *  key when it is one instance of a series. */
function bookingIdFor(resource: string, ev: VEvent): string {
  if (ev.recurrenceInstant === undefined) return resource;
  return `${resource}::${occurrenceKey({ instant: ev.recurrenceInstant, allDay: ev.allDay === true })}`;
}

function notFound(id: string): UnibookingError {
  return new UnibookingError({
    provider: 'apple',
    code: 'NOT_FOUND',
    message: `event ${id} not found`,
  });
}

/**
 * One occurrence of the series in `events`, or undefined when the series has
 * none at that start: its override if there is one, otherwise the master
 * shifted to the occurrence. Excluded starts have none. Where the rule can be
 * expanded exactly (a DTSTART not anchored in a TZID, and a rule
 * `expandRecurrence` models), a start the rule never produces has none either;
 * otherwise the id is trusted, since UTC-stepped expansion of a zoned series
 * drifts by an hour across DST.
 */
function occurrenceIn(events: VEvent[], ref: OccurrenceRef): VEvent | undefined {
  const at = Date.parse(ref.instant);
  const override = events.find(
    (ev) => ev.recurrenceInstant !== undefined && Date.parse(ev.recurrenceInstant) === at,
  );
  if (override) return override;
  const master = events.find((ev) => ev.recurrenceId === undefined);
  if (!master?.rrule || master.start === undefined || master.end === undefined) return undefined;
  if ((master.excluded ?? []).some((e) => Date.parse(e) === at)) return undefined;
  const durationMs = Date.parse(master.end) - Date.parse(master.start);
  const zoned = /^DTSTART;[^:\n]*TZID=/im.test(master.raw);
  if (!zoned) {
    const expanded = expandRecurrence(master, ref.instant, new Date(at + 1).toISOString());
    const modelled = !(expanded.length === 1 && expanded[0] === master);
    if (modelled && !expanded.some((ev) => ev.start !== undefined && Date.parse(ev.start) === at)) {
      return undefined;
    }
  }
  const occurrence: VEvent = {
    ...master,
    start: formatWithOffset(at, 0),
    end: formatWithOffset(at + durationMs, 0),
    recurrenceInstant: ref.instant,
  };
  delete occurrence.rrule;
  return occurrence;
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
    staffServiceAssignment: false,
    serviceCategories: false,
    businessHours: false,
    classCatalog: false,
    classEnrollment: false,
    classWaitlist: false,
    changeFeed: true,
    changeNotifications: false,
    versionedWrites: true,
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
      let created: string | undefined;
      await http.request(c, {
        method: 'PUT',
        path: resourceUrl(calendarUrl, uid),
        onResponse: ({ headers }) => {
          created = etagOf(headers);
        },
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
        // Servers may omit it on PUT (RFC 4791 §5.3.4 lets them change the
        // stored data); a later read reports it either way.
        ...(created ? { version: created } : {}),
        raw: { uid, ics },
      };
    },

    async getBooking(id) {
      const occurrence = occurrenceOf(id);
      const c = await http.resolve();
      let etag: string | undefined;
      const text = await http.request<string>(c, {
        path: resourceUrl(collection(c), occurrence?.resource ?? id),
        headers: ACCEPT_ICS,
        parse: 'text',
        onResponse: ({ headers }) => {
          etag = etagOf(headers);
        },
      });
      const events = parseICS(text);
      // The ETag versions the whole resource: every occurrence of a series
      // shares it, so a change to any of them invalidates the others' version.
      const version = etag ? { version: etag } : {};
      if (occurrence) {
        const ev = occurrenceIn(events, occurrence.ref);
        if (!ev) throw notFound(id);
        return { ...toBooking(ev), id, seriesId: occurrence.resource, ...version };
      }
      const event = masterEvent(events);
      if (!event) throw notFound(id);
      // Address by the resource id the caller passed, not the VEVENT UID (they
      // can differ), so the returned booking stays re-fetchable.
      return { ...toBooking(event), id, ...version };
    },

    async updateBooking(id, input) {
      if (input.range) assertValidRange(input.range, 'apple');
      assertAllDayInput(input, 'apple');
      const dates =
        input.range && input.allDay === true ? allDayDates(input.range, 'apple') : undefined;
      const occurrence = occurrenceOf(id);
      const c = await http.resolve();
      const calendarUrl = collection(c);
      const resource = occurrence?.resource ?? id;
      let etag: string | undefined;
      const text = await http.request<string>(c, {
        path: resourceUrl(calendarUrl, resource),
        headers: ACCEPT_ICS,
        parse: 'text',
        onResponse: ({ headers }) => {
          etag = etagOf(headers);
        },
      });
      const events = parseICS(text);
      const current = occurrence ? occurrenceIn(events, occurrence.ref) : masterEvent(events);
      if (!current || current.start === undefined || current.end === undefined) {
        throw notFound(id);
      }
      // Patch the fetched VCALENDAR in place rather than rebuilding from the lean
      // model — otherwise RRULE, LOCATION, DESCRIPTION, extra attendees, alarms,
      // and VTIMEZONE would be silently dropped on every edit.
      const status = input.status !== undefined ? toICalStatus(input.status) : undefined;
      const changes = {
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
      };
      // One occurrence gets a RECURRENCE-ID override; patching the master would
      // move or rename every occurrence of the series.
      const ics = occurrence ? overrideICS(text, occurrence.ref, changes) : patchICS(text, changes);
      // If-Match makes the write fail (412 → CONFLICT) rather than silently
      // clobber a concurrent edit. The caller's `ifVersion` guards the whole
      // read-edit-write they did; without one, the ETag just read guards the
      // gap between this method's own GET and PUT.
      const guard = input.ifVersion ?? etag;
      let written: string | undefined;
      await http.request(c, {
        method: 'PUT',
        path: resourceUrl(calendarUrl, resource),
        headers: {
          ...ACCEPT_ICS,
          'content-type': 'text/calendar; charset=utf-8',
          ...(guard ? { 'if-match': guard } : {}),
        },
        body: ics,
        parse: 'none',
        onResponse: ({ headers }) => {
          written = etagOf(headers);
        },
      });
      const version = written ? { version: written } : {};
      if (occurrence) {
        const updated = occurrenceIn(parseICS(ics), occurrence.ref)!;
        return { ...toBooking(updated), id, seriesId: occurrence.resource, ...version };
      }
      return { ...toBooking(masterEvent(parseICS(ics))!), id, ...version };
    },

    /** A resource id deletes the whole DAV resource — for a recurring series,
     *  every occurrence. An occurrence id removes that one occurrence with an
     *  EXDATE on the series (and drops its override), under the same ETag
     *  guard as an update. */
    async cancelBooking(id, options) {
      const occurrence = occurrenceOf(id);
      const c = await http.resolve();
      if (!occurrence) {
        await http.request(c, {
          method: 'DELETE',
          path: resourceUrl(collection(c), id),
          headers: {
            ...ACCEPT_XML,
            ...(options?.ifVersion !== undefined ? { 'if-match': options.ifVersion } : {}),
          },
          parse: 'none',
        });
        return;
      }
      const url = resourceUrl(collection(c), occurrence.resource);
      let etag: string | undefined;
      const text = await http.request<string>(c, {
        path: url,
        headers: ACCEPT_ICS,
        parse: 'text',
        onResponse: ({ headers }) => {
          etag = etagOf(headers);
        },
      });
      if (!occurrenceIn(parseICS(text), occurrence.ref)) throw notFound(id);
      const guard = options?.ifVersion ?? etag;
      await http.request(c, {
        method: 'PUT',
        path: url,
        headers: {
          ...ACCEPT_ICS,
          'content-type': 'text/calendar; charset=utf-8',
          ...(guard ? { 'if-match': guard } : {}),
        },
        body: excludeOccurrenceICS(text, occurrence.ref, now()),
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
              // One occurrence of a series is addressed on its own, so an
              // edit or cancel of "this Monday" leaves the other Mondays be.
              const resource = name ?? ev.uid;
              return {
                ...toBooking(ev),
                id: bookingIdFor(resource, ev),
                ...(ev.recurrenceInstant !== undefined ? { seriesId: resource } : {}),
                ...(entry.etag ? { version: entry.etag } : {}),
              };
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

    /**
     * DAV:sync-collection (RFC 6578) over the whole collection: `range` is
     * ignored. A change is per resource, so a recurring series arrives as its
     * master under the resource id (not as expanded occurrences). Members the
     * server reports without their data are fetched with calendar-multiget. An
     * out-of-date token (`DAV:valid-sync-token`) is `fullSyncRequired`.
     */
    async syncBookings(query = {}) {
      const c = await http.resolve();
      const url = collection(c);
      const token = query.pageToken ?? query.syncToken ?? '';
      let xml: string;
      try {
        xml = await http.request<string>(c, {
          method: 'REPORT',
          path: url,
          // RFC 6578 §3.2: sync-collection is only defined at Depth 0.
          headers: { ...ACCEPT_XML, 'content-type': 'application/xml; charset=utf-8', depth: '0' },
          body: syncCollectionBody(token),
          parse: 'text',
        });
      } catch (e) {
        if (
          token !== '' &&
          isUnibookingError(e) &&
          (e.httpStatus === 410 || /valid-sync-token/i.test(e.message))
        ) {
          return { changes: [], fullSyncRequired: true };
        }
        throw e;
      }
      const result = parseSyncCollection(xml ?? '', new URL(url, BASE).toString());

      const missing = result.entries
        .filter((e) => e.status < 300 && e.ics === undefined)
        .map((e) => e.href);
      const fetched = new Map<string, { ics: string; etag?: string }>();
      if (missing.length > 0) {
        const multi = await http.request<string>(c, {
          method: 'REPORT',
          path: url,
          headers: { ...ACCEPT_XML, 'content-type': 'application/xml; charset=utf-8', depth: '1' },
          body: multigetBody(missing),
          parse: 'text',
        });
        for (const entry of parseCalendarEntries(multi ?? '')) {
          if (entry.href) {
            fetched.set(resourceNameFromHref(entry.href) ?? entry.href, {
              ics: entry.ics,
              ...(entry.etag ? { etag: entry.etag } : {}),
            });
          }
        }
      }

      const changes: BookingChange[] = [];
      for (const entry of result.entries) {
        const name = resourceNameFromHref(entry.href);
        if (!name) continue;
        if (entry.status === 404) {
          // Nothing to remove on a first, full sync.
          if (token !== '') changes.push({ type: 'delete', id: name });
          continue;
        }
        const data = entry.ics ?? fetched.get(name)?.ics;
        const etag = entry.etag ?? fetched.get(name)?.etag;
        const event = data ? masterEvent(parseICS(data)) : undefined;
        // Not an event (a task in a mixed collection), or unreadable.
        if (!event || event.start === undefined || event.end === undefined) continue;
        changes.push({
          type: 'upsert',
          booking: { ...toBooking(event), id: name, ...(etag ? { version: etag } : {}) },
        });
      }
      return {
        changes,
        ...(result.syncToken
          ? result.truncated
            ? { nextPageToken: result.syncToken }
            : { syncToken: result.syncToken }
          : {}),
      };
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
