import { describe, it, expect } from 'vitest';
import type { Booking } from 'unibooking';
import type { Call } from './call-type';
import { emptyCalendarLinks, type CalendarLinks, type ProjectBooking } from './project';
import { copiedBooking, syncProjectCalendars, type Reach } from './project-calendar-sync';

/** One calendar provider in memory: calendars by id, behind `Call`. */
function google() {
  const calendars = new Map<string, Booking[]>();
  const providersCalled = new Set<string>();
  let next = 1;
  const call: Call = async (provider, conn, op, args) => {
    providersCalled.add(provider);
    const id = String(args.calendarId ?? conn.creds.calendarId);
    const events = calendars.get(id) ?? [];
    calendars.set(id, events);
    switch (op) {
      case 'listBookings':
        return { ok: true, data: { bookings: events.map((e) => ({ ...e, range: { ...e.range } })) } };
      case 'createBooking': {
        const ev = {
          id: `ev${next++}`,
          title: String(args.title),
          description: String(args.description),
          range: { start: String(args.start), end: String(args.end) },
          status: 'confirmed',
        } as Booking;
        events.push(ev);
        return { ok: true, data: ev };
      }
      case 'updateBooking': {
        const ev = events.find((e) => e.id === args.bookingId)!;
        const i = args.input as { title: string; start: string; end: string };
        Object.assign(ev, { title: i.title, range: { start: i.start, end: i.end } });
        return { ok: true, data: ev };
      }
      case 'cancelBooking': {
        const at = events.findIndex((e) => e.id === args.bookingId);
        if (at === -1) return { ok: false, error: { code: 'NOT_FOUND', message: 'gone' } };
        events.splice(at, 1);
        return { ok: true, data: { cancelled: true } };
      }
      default:
        return { ok: false, error: { message: `unexpected ${op}` } };
    }
  };
  const reach: Reach = (calendarId) => ({ conn: { creds: {}, signedIn: true }, args: { calendarId } });
  return { calendars, call, reach, providersCalled };
}

const RANGE = { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' };
const bk = (id: string, over: Partial<ProjectBooking> = {}): ProjectBooking => ({
  id,
  staffId: 'ub_maya',
  serviceId: 'ub_mani',
  customer: 'Priya',
  start: '2026-10-05T10:00:00Z',
  end: '2026-10-05T10:45:00Z',
  status: 'confirmed',
  updatedAt: '2026-09-26T00:00:00Z',
  ...over,
});
const NAMES: Record<string, string> = { ub_maya: 'Maya', ub_mani: 'Manicure', ub_pedi: 'Pedicure' };

function run(g: ReturnType<typeof google>, bookings: ProjectBooking[], links: CalendarLinks) {
  return syncProjectCalendars({
    provider: 'google',
    bookings,
    links,
    range: RANGE,
    titleOf: (b) => `${NAMES[b.serviceId!] ?? 'Booking'} · ${b.customer}`,
    describe: (b) => `Booked in your project with ${NAMES[b.staffId!]}`,
    call: g.call,
    reach: g.reach,
    now: () => '2026-09-26T12:00:00Z',
  });
}

const servicesLinked = (): CalendarLinks => ({
  ...emptyCalendarLinks(),
  services: { ub_mani: 'manicure-cal', ub_pedi: 'pedicure-cal' },
});

describe('project -> calendar', () => {
  it('puts each booking in its service calendar once, with a marker', async () => {
    const g = google();
    const first = await run(g, [bk('pb_1'), bk('pb_2', { serviceId: 'ub_pedi' })], servicesLinked());
    expect(first.report).toMatchObject({ created: 2, errors: [] });
    expect(g.calendars.get('manicure-cal')!.map((e) => e.title)).toEqual(['Manicure · Priya']);
    expect(copiedBooking(g.calendars.get('manicure-cal')![0]!)).toBe('pb_1');
    // Only the one selected provider is ever called.
    expect([...g.providersCalled]).toEqual(['google']);

    const again = await run(g, [bk('pb_1'), bk('pb_2', { serviceId: 'ub_pedi' })], first.links);
    expect(again.report).toMatchObject({ created: 0, unchanged: 2 });
  });

  it('the staff link wins over the service link', async () => {
    const g = google();
    await run(g, [bk('pb_1')], { ...servicesLinked(), staff: { ub_maya: 'maya-cal' } });
    expect(g.calendars.get('maya-cal')).toHaveLength(1);
    expect(g.calendars.get('manicure-cal')).toHaveLength(0);
  });

  it('follows a reschedule, a cancel and a delete made in the project', async () => {
    const g = google();
    const first = await run(g, [bk('pb_1'), bk('pb_2'), bk('pb_3')], servicesLinked());
    const moved = bk('pb_1', { start: '2026-10-06T09:00:00Z', end: '2026-10-06T09:45:00Z' });
    const cancelled = bk('pb_2', { status: 'cancelled' });
    // pb_3 deleted from the project entirely.
    const r = await run(g, [moved, cancelled], first.links);
    expect(r.report).toMatchObject({ updated: 1, removed: 2 });
    const left = g.calendars.get('manicure-cal')!;
    expect(left).toHaveLength(1);
    expect(left[0]!.range.start).toBe('2026-10-06T09:00:00Z');
  });

  it('moves a copy when the booking’s calendar link changes', async () => {
    const g = google();
    const first = await run(g, [bk('pb_1')], servicesLinked());
    const r = await run(g, [bk('pb_1')], { ...first.links, staff: { ub_maya: 'maya-cal' } });
    expect(r.report.moved).toBe(1);
    expect(g.calendars.get('manicure-cal')).toHaveLength(0);
    expect(g.calendars.get('maya-cal')).toHaveLength(1);
  });

  it('adopts a copy it has no record of instead of duplicating', async () => {
    const g = google();
    const first = await run(g, [bk('pb_1')], servicesLinked());
    const r = await run(g, [bk('pb_1')], { ...first.links, copies: {} });
    expect(r.report.created).toBe(0);
    expect(g.calendars.get('manicure-cal')).toHaveLength(1);
  });

  it('recreates a copy deleted in the calendar, since the project owns the booking', async () => {
    const g = google();
    const first = await run(g, [bk('pb_1')], servicesLinked());
    g.calendars.set('manicure-cal', []);
    const r = await run(g, [bk('pb_1')], first.links);
    expect(r.report.created).toBe(1);
    expect(g.calendars.get('manicure-cal')).toHaveLength(1);
  });
});

describe('a calendar that could not be read', () => {
  it('never recreates (duplicates) a copy it simply could not see', async () => {
    const g = google();
    const first = await run(g, [bk('pb_1')], servicesLinked());
    // The next read of that calendar fails.
    const failing: typeof g.call = async (p, c, op, args) =>
      op === 'listBookings' ? { ok: false, error: { message: 'timeout' } } : g.call(p, c, op, args);
    const r = await syncProjectCalendars({
      provider: 'google',
      bookings: [bk('pb_1')],
      links: first.links,
      range: RANGE,
      titleOf: (b) => `${NAMES[b.serviceId!]} · ${b.customer}`,
      describe: () => '',
      call: failing,
      reach: g.reach,
    });
    expect(r.report.created).toBe(0);
    expect(g.calendars.get('manicure-cal')).toHaveLength(1);
    expect(r.links.copies.pb_1).toBeDefined();
    expect(r.report.errors.length).toBeGreaterThan(0);
  });
});

describe('calendar -> project', () => {
  it('a copy moved in the calendar moves the booking in the project', async () => {
    const g = google();
    const first = await run(g, [bk('pb_1')], servicesLinked());
    g.calendars.get('manicure-cal')![0]!.range = {
      start: '2026-10-05T15:00:00Z',
      end: '2026-10-05T15:45:00Z',
    };
    const r = await run(g, [bk('pb_1')], first.links);
    expect(r.report.pulled).toBe(1);
    expect(r.bookings[0]).toMatchObject({ start: '2026-10-05T15:00:00Z' });
  });

  it('other events in a linked calendar come back as busy time', async () => {
    const g = google();
    g.calendars.set('manicure-cal', [
      {
        id: 'x1',
        title: 'Staff training',
        range: { start: '2026-10-07T09:00:00Z', end: '2026-10-07T12:00:00Z' },
        status: 'confirmed',
      } as Booking,
    ]);
    const r = await run(g, [], servicesLinked());
    expect(r.report.busy).toBe(1);
    expect(r.links.busy[0]).toMatchObject({ calendarId: 'manicure-cal', title: 'Staff training' });
  });

  it('a booking with no linked calendar is left alone and counted', async () => {
    const g = google();
    const r = await run(g, [bk('pb_1')], emptyCalendarLinks());
    expect(r.report).toMatchObject({ unlinked: 1, created: 0 });
  });
});
