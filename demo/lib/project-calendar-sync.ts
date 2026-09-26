import type { Booking } from 'unibooking';
import type { Call } from './call-type';
import type { Connection } from './result';
import type { CalendarCopy, CalendarLinks, BusyBlock, ProjectBooking } from './project';

/**
 * Calendar sync: YOUR PROJECT <-> ONE calendar provider.
 *
 * - Project -> calendar: each project booking is written into the calendar its
 *   staff member (else service, else "all bookings") is linked to, and kept
 *   there: moved, retitled, removed when cancelled or deleted, moved to
 *   another calendar when the link changes. Never duplicated: every copy is
 *   recorded and also carries a marker in its description, so a copy made from
 *   another browser (or after the record was lost) is found and reused.
 * - Calendar -> project: a copy moved in the calendar moves the booking in the
 *   project (when the project did not also change it -- then the project
 *   wins, since it is where the booking was made). Every other event in a
 *   linked calendar comes back as busy time.
 *
 * Only the selected provider's calendars are ever read or written; nothing is
 * copied from one provider to another.
 */

export type Reach = (calendarId: string) => { conn: Connection; args: Record<string, unknown> };

export type ProjectSyncInput = {
  provider: string;
  bookings: ProjectBooking[];
  links: CalendarLinks;
  range: { start: string; end: string };
  /** Title for a booking's calendar event. */
  titleOf: (b: ProjectBooking) => string;
  /** Description body for a booking's calendar event (the marker is added). */
  describe: (b: ProjectBooking) => string;
  call: Call;
  reach: Reach;
  now?: () => string;
};

export type ProjectSyncReport = {
  created: number;
  updated: number;
  moved: number;
  removed: number;
  pulled: number;
  unchanged: number;
  unlinked: number;
  busy: number;
  errors: { bookingId: string; message: string }[];
  log: string[];
};

export const MARKER = (bookingId: string) => `[unibooking:project:${bookingId}]`;
const MARKER_RE = /\[unibooking:project:([^\]\s]+)\]/;

export function copiedBooking(e: { description?: string }): string | null {
  const m = e.description ? MARKER_RE.exec(e.description) : null;
  return m ? m[1]! : null;
}

export function calendarFor(
  links: CalendarLinks,
  b: Pick<ProjectBooking, 'staffId' | 'serviceId'>,
): string | undefined {
  return (
    (b.staffId ? links.staff[b.staffId] : undefined) ??
    (b.serviceId ? links.services[b.serviceId] : undefined) ??
    links.all
  );
}

const overlaps = (a: { start: string; end: string }, r: { start: string; end: string }) =>
  Date.parse(a.start) < Date.parse(r.end) && Date.parse(a.end) > Date.parse(r.start);
const sameTime = (a: { start: string; end: string }, b: { start: string; end: string }) =>
  Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end);

async function must<T>(p: ReturnType<Call>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(r.error?.message ?? 'request failed');
  return r.data as T;
}

/** Every event in one calendar within the range, across pages (bounded). */
async function listEvents(
  input: ProjectSyncInput,
  calendarId: string,
): Promise<{ events: Booking[]; complete: boolean }> {
  const { conn, args } = input.reach(calendarId);
  const events: Booking[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await must<{ bookings: Booking[]; nextPageToken?: string }>(
      input.call(input.provider, conn, 'listBookings', {
        ...args,
        ...input.range,
        limit: 100,
        ...(pageToken ? { pageToken } : {}),
      }),
    );
    events.push(...page.bookings);
    pageToken = page.nextPageToken;
    if (!pageToken) return { events, complete: true };
  }
  return { events, complete: false };
}

export async function syncProjectCalendars(input: ProjectSyncInput): Promise<{
  bookings: ProjectBooking[];
  links: CalendarLinks;
  report: ProjectSyncReport;
}> {
  const { provider, call, reach, range } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const links: CalendarLinks = { ...input.links, copies: { ...input.links.copies } };
  const bookings = input.bookings.map((b) => ({ ...b }));
  const report: ProjectSyncReport = {
    created: 0,
    updated: 0,
    moved: 0,
    removed: 0,
    pulled: 0,
    unchanged: 0,
    unlinked: 0,
    busy: 0,
    errors: [],
    log: [],
  };

  // Every calendar involved: linked now, or still holding a copy.
  const calendars = new Set<string>(
    [links.all, ...Object.values(links.staff), ...Object.values(links.services)].filter(
      (x): x is string => !!x,
    ),
  );
  for (const c of Object.values(links.copies)) calendars.add(c.calendarId);

  // Read them: our copies (by booking id) and everything else (busy time).
  const eventsByBooking = new Map<string, { calendarId: string; event: Booking }>();
  const busy: BusyBlock[] = [];
  let complete = true;
  // Calendars read in full. A copy missing from a calendar that failed to load
  // (or was cut off at the page cap) is NOT evidence it was deleted: treating
  // it as deleted would recreate it and duplicate the event.
  const readInFull = new Set<string>();
  for (const calendarId of calendars) {
    try {
      const got = await listEvents(input, calendarId);
      complete &&= got.complete;
      if (got.complete) readInFull.add(calendarId);
      for (const e of got.events) {
        const bookingId = copiedBooking(e);
        if (bookingId) {
          eventsByBooking.set(bookingId, { calendarId, event: e });
          if (!links.copies[bookingId]) {
            // A copy this project has no record of: adopt it, never duplicate.
            links.copies[bookingId] = {
              calendarId,
              eventId: e.id,
              start: e.range.start,
              end: e.range.end,
              title: e.title,
            };
            report.log.push(`Found an existing copy of ${bookingId}.`);
          }
        } else if (e.status !== 'cancelled') {
          busy.push({
            calendarId,
            eventId: e.id,
            title: e.title,
            start: e.range.start,
            end: e.range.end,
          });
        }
      }
    } catch (err) {
      complete = false;
      report.errors.push({ bookingId: '—', message: `Could not read a calendar: ${(err as Error).message}` });
    }
  }

  const remove = async (bookingId: string, copy: CalendarCopy) => {
    const { conn, args } = reach(copy.calendarId);
    const r = await call(provider, conn, 'cancelBooking', { ...args, bookingId: copy.eventId });
    // Already gone from the calendar is the state we wanted.
    if (!r.ok && r.error?.code !== 'NOT_FOUND') throw new Error(r.error?.message ?? 'delete failed');
    delete links.copies[bookingId];
  };
  const create = async (b: ProjectBooking, calendarId: string) => {
    const { conn, args } = reach(calendarId);
    const title = input.titleOf(b);
    const ev = await must<Booking>(
      call(provider, conn, 'createBooking', {
        ...args,
        title,
        start: b.start,
        end: b.end,
        description: `${input.describe(b)}\n${MARKER(b.id)}`,
      }),
    );
    links.copies[b.id] = { calendarId, eventId: ev.id, start: b.start, end: b.end, title };
  };

  const seen = new Set<string>();
  for (const b of bookings) {
    if (!overlaps(b, range)) continue;
    seen.add(b.id);
    const target = calendarFor(links, b);
    const copy = links.copies[b.id];
    try {
      if (b.status === 'cancelled' || !target) {
        if (copy) {
          await remove(b.id, copy);
          report.removed++;
        } else if (!target) {
          report.unlinked++;
        }
        continue;
      }
      if (copy && copy.calendarId !== target) {
        await remove(b.id, copy);
        await create(b, target);
        report.moved++;
        continue;
      }
      if (!copy) {
        await create(b, target);
        report.created++;
        continue;
      }
      const live = eventsByBooking.get(b.id)?.event;
      if (!live && !readInFull.has(copy.calendarId)) {
        // Could not see the calendar properly this time: leave it alone.
        report.errors.push({
          bookingId: b.id,
          message: 'its calendar could not be read in full; left as it was',
        });
        continue;
      }
      if (!live) {
        // Deleted in the calendar. The booking still stands in the project,
        // which owns it, so the copy is put back.
        delete links.copies[b.id];
        await create(b, target);
        report.created++;
        report.log.push(`${b.id}: its calendar copy was deleted; recreated.`);
        continue;
      }
      const projectChanged = !sameTime(b, copy) || input.titleOf(b) !== copy.title;
      const calendarChanged = !sameTime(live.range, copy);
      if (calendarChanged && !projectChanged) {
        // Moved in the calendar: bring the new time into the project.
        b.start = live.range.start;
        b.end = live.range.end;
        b.updatedAt = now();
        links.copies[b.id] = { ...copy, start: b.start, end: b.end };
        report.pulled++;
        report.log.push(`${b.id}: moved in the calendar; project updated.`);
        continue;
      }
      if (projectChanged) {
        const { conn, args } = reach(target);
        const title = input.titleOf(b);
        await must(
          call(provider, conn, 'updateBooking', {
            ...args,
            bookingId: copy.eventId,
            input: { title, start: b.start, end: b.end },
          }),
        );
        links.copies[b.id] = { ...copy, start: b.start, end: b.end, title };
        report.updated++;
        continue;
      }
      report.unchanged++;
    } catch (err) {
      report.errors.push({ bookingId: b.id, message: (err as Error).message });
    }
  }

  // Copies of bookings the project no longer has (deleted there). Only inside
  // the range, and only when every calendar was read in full.
  if (complete) {
    for (const [bookingId, copy] of Object.entries(links.copies)) {
      if (seen.has(bookingId) || bookings.some((b) => b.id === bookingId)) continue;
      if (!overlaps(copy, range)) continue;
      try {
        await remove(bookingId, copy);
        report.removed++;
      } catch (err) {
        report.errors.push({ bookingId, message: (err as Error).message });
      }
    }
  }

  links.busy = busy;
  links.lastSyncedAt = now();
  report.busy = busy.length;
  return { bookings, links, report };
}
