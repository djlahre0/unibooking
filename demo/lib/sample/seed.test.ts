import { describe, it, expect } from 'vitest';
import { buildSeed, BUSINESS_HOURS } from './seed';
import { instantToZoned } from 'unibooking';
import { shiftDate } from '../calendar/agenda';

const TZ = 'America/New_York';
const TODAY = '2026-09-20'; // a Sunday, so the closed-day rule is exercised

describe('buildSeed', () => {
  it('is deterministic for the same day and zone', () => {
    expect(buildSeed(TODAY, TZ)).toEqual(buildSeed(TODAY, TZ));
  });

  it('records what it was anchored to', () => {
    const data = buildSeed(TODAY, TZ);
    expect(data.seededAt).toBe(TODAY);
    expect(data.timezone).toBe(TZ);
    expect(data.version).toBe(1);
  });

  it('seeds a catalog with one inactive staff member to toggle', () => {
    const data = buildSeed(TODAY, TZ);
    expect(data.services).toHaveLength(6);
    expect(data.staff).toHaveLength(4);
    expect(data.customers).toHaveLength(8);
    expect(data.staff.filter((s) => !s.active)).toHaveLength(1);
  });

  it('prices every service in explicit integer minor units', () => {
    for (const s of buildSeed(TODAY, TZ).services) {
      expect(s.price).toBeDefined();
      expect(Number.isInteger(s.price!.amount)).toBe(true);
      expect(s.price!.currency).toBe('USD');
    }
  });

  it('spreads bookings from a week back to three weeks ahead', () => {
    const data = buildSeed(TODAY, TZ);
    expect(data.bookings.length).toBeGreaterThanOrEqual(20);
    const days = data.bookings.map((b) => instantToZoned(b.range.start, TZ).date);
    expect(days.some((d) => d < TODAY)).toBe(true);
    expect(days.some((d) => d > TODAY)).toBe(true);
    expect(Math.min(...days.map(Date.parse))).toBeGreaterThanOrEqual(Date.parse('2026-09-13'));
    expect(Math.max(...days.map(Date.parse))).toBeLessThanOrEqual(Date.parse('2026-10-11'));
  });

  it('books only inside business hours and never on a closed day', () => {
    for (const b of buildSeed(TODAY, TZ).bookings) {
      const local = instantToZoned(b.range.start, TZ); // { date, time }
      const weekday = new Date(`${local.date}T00:00:00Z`).getUTCDay();
      const hours = BUSINESS_HOURS[weekday];
      expect(hours, `weekday ${weekday} should be open`).not.toBeNull();
      expect(local.time >= hours!.open).toBe(true);
      expect(instantToZoned(b.range.end, TZ).time <= hours!.close).toBe(true);
    }
  });

  it('ends every booking after it starts, with a known status and raw set', () => {
    const known = ['confirmed', 'pending', 'cancelled', 'declined', 'no_show', 'completed'];
    for (const b of buildSeed(TODAY, TZ).bookings) {
      expect(Date.parse(b.range.end)).toBeGreaterThan(Date.parse(b.range.start));
      expect(known).toContain(b.status);
      expect(b.raw).toBeDefined();
    }
  });

  it('includes past, cancelled and no-show bookings so every status renders', () => {
    const statuses = new Set(buildSeed(TODAY, TZ).bookings.map((b) => b.status));
    expect(statuses).toContain('completed');
    expect(statuses).toContain('cancelled');
    expect(statuses).toContain('no_show');
    expect(statuses).toContain('pending');
  });

  it('reserves nextId above every id it issued', () => {
    const data = buildSeed(TODAY, TZ);
    const used = data.bookings.map((b) => Number(b.id.replace('bkg_', '')));
    expect(data.nextId).toBeGreaterThan(Math.max(...used));
  });

  it('never double-books the same staff member, whichever weekday the seed is anchored to', () => {
    // The Sunday-slide rule (a booking landing on a closed Sunday moves to
    // Monday) can push two LAYOUT entries that were never meant to collide
    // onto the same day. Every one of the 7 possible anchor weekdays is
    // reachable in production (the seed always anchors to "today"), so all 7
    // must be checked, not just TODAY's.
    for (let offset = 0; offset < 7; offset++) {
      const anchor = shiftDate(TODAY, offset);
      const { bookings } = buildSeed(anchor, TZ);
      const active = bookings.filter((b) => b.status !== 'cancelled');
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const a = active[i]!;
          const b = active[j]!;
          if (!a.staffId || a.staffId !== b.staffId) continue;
          const overlap =
            Date.parse(a.range.start) < Date.parse(b.range.end) &&
            Date.parse(b.range.start) < Date.parse(a.range.end);
          expect(
            overlap,
            `anchor ${anchor} (TODAY+${offset}): ${a.id} and ${b.id} both use ${a.staffId} ` +
              `and overlap (${a.range.start}-${a.range.end} vs ${b.range.start}-${b.range.end})`,
          ).toBe(false);
        }
      }
    }
  });
});
