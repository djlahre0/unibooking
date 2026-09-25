import { describe, expect, it } from 'vitest';
import {
  busyFromBookings,
  computeSlots,
  excludeBusy,
  freeSlots,
  slotsWithinRange,
  sortSlots,
} from '../src/availability';
import { isInstant } from '../src/time';

// A 3-hour window; most cases slice it at a 60-minute duration.
const RANGE = { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' };

describe('freeSlots', () => {
  it('slices the whole range when nothing is busy', () => {
    const slots = freeSlots(RANGE, [], 60);
    expect(slots.map((s) => s.start)).toEqual([
      '2026-07-20T09:00:00Z',
      '2026-07-20T10:00:00Z',
      '2026-07-20T11:00:00Z',
    ]);
    expect(slots.map((s) => s.end)).toEqual([
      '2026-07-20T10:00:00Z',
      '2026-07-20T11:00:00Z',
      '2026-07-20T12:00:00Z',
    ]);
    // Every emitted instant is offset-bearing (Z form) and non-empty.
    for (const s of slots) {
      expect(isInstant(s.start)).toBe(true);
      expect(isInstant(s.end)).toBe(true);
      expect(Date.parse(s.end) > Date.parse(s.start)).toBe(true);
    }
  });

  it('returns nothing when a busy interval covers the whole range', () => {
    const slots = freeSlots(
      RANGE,
      [{ start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' }],
      60,
    );
    expect(slots).toEqual([]);
  });

  it('emits slots before and after a busy block in the middle', () => {
    const slots = freeSlots(
      RANGE,
      [{ start: '2026-07-20T10:00:00Z', end: '2026-07-20T11:00:00Z' }],
      60,
    );
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z']);
    // No slot overlaps the busy hour.
    expect(slots.some((s) => s.start === '2026-07-20T10:00:00Z')).toBe(false);
  });

  it('merges overlapping and adjacent busy intervals', () => {
    const overlapping = freeSlots(
      RANGE,
      [
        { start: '2026-07-20T10:00:00Z', end: '2026-07-20T10:45:00Z' },
        { start: '2026-07-20T10:30:00Z', end: '2026-07-20T11:00:00Z' },
      ],
      60,
    );
    const adjacent = freeSlots(
      RANGE,
      [
        { start: '2026-07-20T10:00:00Z', end: '2026-07-20T10:30:00Z' },
        { start: '2026-07-20T10:30:00Z', end: '2026-07-20T11:00:00Z' },
      ],
      60,
    );
    // Both collapse to a single 10:00–11:00 busy block, leaving 09–10 and 11–12.
    const expected = ['2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z'];
    expect(overlapping.map((s) => s.start)).toEqual(expected);
    expect(adjacent.map((s) => s.start)).toEqual(expected);
  });

  it('drops a free gap shorter than the requested duration', () => {
    // 40-minute window, 45-minute slots → nothing fits.
    const slots = freeSlots({ start: '2026-07-20T09:00:00Z', end: '2026-07-20T09:40:00Z' }, [], 45);
    expect(slots).toEqual([]);
  });

  it('discards a trailing remainder too short to fit a slot', () => {
    // 75-minute window, 30-minute slots → two slots, the final 15 minutes dropped.
    const slots = freeSlots({ start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:15:00Z' }, [], 30);
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T09:00:00Z', '2026-07-20T09:30:00Z']);
    expect(slots[slots.length - 1]!.end).toBe('2026-07-20T10:00:00Z');
  });

  it('clamps busy intervals that extend past the range', () => {
    const slots = freeSlots(
      RANGE,
      [
        { start: '2026-07-20T08:00:00Z', end: '2026-07-20T10:00:00Z' }, // starts before the range
        { start: '2026-07-20T11:00:00Z', end: '2026-07-20T13:00:00Z' }, // ends after the range
      ],
      60,
    );
    // Only the clamped 10:00–11:00 gap remains bookable.
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T10:00:00Z']);
    expect(slots[0]!.end).toBe('2026-07-20T11:00:00Z');
  });

  it('accepts busy intervals in any offset and still emits UTC instants', () => {
    // Busy block given in a -07:00 offset (17:00–18:00Z) inside a UTC range.
    const slots = freeSlots(
      RANGE,
      [{ start: '2026-07-20T03:00:00-07:00', end: '2026-07-20T04:00:00-07:00' }],
      60,
    );
    // 03:00-07:00 == 10:00Z .. 11:00Z busy → 09–10 and 11–12 free.
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z']);
    for (const s of slots) expect(isInstant(s.start)).toBe(true);
  });
});

describe('slotsWithinRange', () => {
  const slot = (start: string) => ({ start, end: addHour(start) });
  const addHour = (s: string) =>
    new Date(Date.parse(s) + 3_600_000).toISOString().slice(0, 19) + 'Z';
  // A full business day of hourly starts, 09:00–17:00Z.
  const day = [9, 10, 11, 12, 13, 14, 15, 16].map((h) =>
    slot(`2026-07-20T${String(h).padStart(2, '0')}:00:00Z`),
  );

  it('keeps only the slots starting inside a narrow window', () => {
    const kept = slotsWithinRange(day, {
      start: '2026-07-20T12:00:00Z',
      end: '2026-07-20T14:00:00Z',
    });
    expect(kept.map((s) => s.start)).toEqual(['2026-07-20T12:00:00Z', '2026-07-20T13:00:00Z']);
  });

  it('is half-open: a slot starting exactly at range.end is excluded', () => {
    const kept = slotsWithinRange(day, {
      start: '2026-07-20T09:00:00Z',
      end: '2026-07-20T12:00:00Z',
    });
    expect(kept.map((s) => s.start)).toEqual([
      '2026-07-20T09:00:00Z',
      '2026-07-20T10:00:00Z',
      '2026-07-20T11:00:00Z',
    ]);
  });

  it('keeps a slot that starts inside but runs past range.end', () => {
    // A start-only provider sizes the slot from the service duration, so the
    // last bookable start legitimately overruns the window.
    const kept = slotsWithinRange(
      [{ start: '2026-07-20T13:30:00Z', end: '2026-07-20T14:30:00Z' }],
      { start: '2026-07-20T12:00:00Z', end: '2026-07-20T14:00:00Z' },
    );
    expect(kept).toHaveLength(1);
  });

  it('compares instants, not wall clocks, across differing offsets', () => {
    // 06:00-07:00 == 13:00Z, inside the window; 06:00+02:00 == 04:00Z, outside.
    const kept = slotsWithinRange(
      [
        { start: '2026-07-20T06:00:00-07:00', end: '2026-07-20T07:00:00-07:00' },
        { start: '2026-07-20T06:00:00+02:00', end: '2026-07-20T07:00:00+02:00' },
      ],
      { start: '2026-07-20T12:00:00Z', end: '2026-07-20T14:00:00Z' },
    );
    expect(kept.map((s) => s.start)).toEqual(['2026-07-20T06:00:00-07:00']);
  });

  it('drops slots whose start does not parse', () => {
    const kept = slotsWithinRange([{ start: 'not-a-time', end: 'nope' }], {
      start: '2026-07-20T12:00:00Z',
      end: '2026-07-20T14:00:00Z',
    });
    expect(kept).toEqual([]);
  });
});

describe('sortSlots', () => {
  it('orders by start instant', () => {
    const sorted = sortSlots([
      { start: '2026-07-20T14:00:00Z', end: '2026-07-20T15:00:00Z' },
      { start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:00:00Z' },
      { start: '2026-07-20T11:00:00Z', end: '2026-07-20T12:00:00Z' },
    ]);
    expect(sorted.map((s) => s.start)).toEqual([
      '2026-07-20T09:00:00Z',
      '2026-07-20T11:00:00Z',
      '2026-07-20T14:00:00Z',
    ]);
  });

  it('interleaves per-staff blocks into one chronological list', () => {
    // How Mindbody and Microsoft Bookings arrive: a whole shift per staff.
    const sorted = sortSlots([
      { start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:00:00Z', staffId: 'A' },
      { start: '2026-07-20T10:00:00Z', end: '2026-07-20T11:00:00Z', staffId: 'A' },
      { start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:00:00Z', staffId: 'B' },
      { start: '2026-07-20T10:00:00Z', end: '2026-07-20T11:00:00Z', staffId: 'B' },
    ]);
    expect(sorted.map((s) => `${s.start.slice(11, 16)}/${s.staffId}`)).toEqual([
      '09:00/A',
      '09:00/B',
      '10:00/A',
      '10:00/B',
    ]);
  });

  it('compares instants, not strings, across differing offsets', () => {
    // 08:00-07:00 == 15:00Z, which is LATER than 12:00Z despite sorting first
    // as a string.
    const sorted = sortSlots([
      { start: '2026-07-20T08:00:00-07:00', end: '2026-07-20T09:00:00-07:00' },
      { start: '2026-07-20T12:00:00Z', end: '2026-07-20T13:00:00Z' },
    ]);
    expect(sorted[0]!.start).toBe('2026-07-20T12:00:00Z');
  });

  it('is stable for equal starts and does not mutate its input', () => {
    const input = [
      { start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:00:00Z', staffId: 'B' },
      { start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:00:00Z', staffId: 'A' },
    ];
    const sorted = sortSlots(input);
    expect(sorted.map((s) => s.staffId)).toEqual(['B', 'A']);
    expect(input.map((s) => s.staffId)).toEqual(['B', 'A']);
  });

  it('parks unparseable starts at the end rather than dropping them', () => {
    const sorted = sortSlots([
      { start: 'not-a-time', end: 'nope' },
      { start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:00:00Z' },
    ]);
    expect(sorted.map((s) => s.start)).toEqual(['2026-07-20T09:00:00Z', 'not-a-time']);
  });
});

describe('computeSlots', () => {
  const MON = '2026-09-21'; // a Monday

  it('keeps the historical back-to-back form without a grid or hours', () => {
    const slots = computeSlots({
      range: { start: '2026-09-21T09:10:00Z', end: '2026-09-21T11:10:00Z' },
      durationMinutes: 60,
    });
    expect(slots.map((s) => s.start)).toEqual(['2026-09-21T09:10:00Z', '2026-09-21T10:10:00Z']);
  });

  it('puts starts on the interval grid, counted from local midnight', () => {
    const slots = computeSlots({
      range: {
        start: '2026-09-21T09:10:00+02:00',
        end: '2026-09-21T11:00:00+02:00',
        timezone: 'Europe/Berlin',
      },
      durationMinutes: 30,
      intervalMinutes: 30,
    });
    expect(slots.map((s) => s.start)).toEqual([
      '2026-09-21T09:30:00+02:00',
      '2026-09-21T10:00:00+02:00',
      '2026-09-21T10:30:00+02:00',
    ]);
  });

  it('offers only times inside working hours, per weekday, in their zone', () => {
    const slots = computeSlots({
      range: { start: `${MON}T00:00:00Z`, end: '2026-09-23T00:00:00Z' },
      durationMinutes: 60,
      workingHours: {
        timezone: 'America/New_York',
        periods: [
          { dayOfWeek: 'MON', start: '09:00', end: '11:00' },
          { dayOfWeek: 'TUE', start: '13:00', end: '14:00' },
        ],
      },
    });
    expect(slots.map((s) => s.start)).toEqual([
      '2026-09-21T09:00:00-04:00',
      '2026-09-21T10:00:00-04:00',
      '2026-09-22T13:00:00-04:00',
    ]);
  });

  it('keeps wall-clock hours across a DST change', () => {
    // US DST ends Sun 1 Nov 2026: 09:00 is -04:00 on Friday, -05:00 on Monday.
    const slots = computeSlots({
      range: { start: '2026-10-30T00:00:00Z', end: '2026-11-03T00:00:00Z' },
      durationMinutes: 60,
      workingHours: {
        timezone: 'America/New_York',
        periods: [
          { dayOfWeek: 'FRI', start: '09:00', end: '10:00' },
          { dayOfWeek: 'MON', start: '09:00', end: '10:00' },
        ],
      },
    });
    expect(slots.map((s) => s.start)).toEqual([
      '2026-10-30T09:00:00-04:00',
      '2026-11-02T09:00:00-05:00',
    ]);
  });

  it('handles a period that runs past midnight', () => {
    const slots = computeSlots({
      range: { start: `${MON}T00:00:00Z`, end: '2026-09-23T00:00:00Z' },
      durationMinutes: 60,
      workingHours: {
        timezone: 'UTC',
        periods: [{ dayOfWeek: 'MON', start: '22:00', end: '01:00' }],
      },
    });
    expect(slots.map((s) => s.start)).toEqual([
      '2026-09-21T22:00:00Z',
      '2026-09-21T23:00:00Z',
      '2026-09-22T00:00:00Z',
    ]);
  });

  it('accepts 24:00 as the end of the day', () => {
    const slots = computeSlots({
      range: { start: `${MON}T00:00:00Z`, end: '2026-09-22T06:00:00Z' },
      durationMinutes: 60,
      workingHours: {
        timezone: 'UTC',
        periods: [{ dayOfWeek: 'MON', start: '22:00', end: '24:00' }],
      },
    });
    expect(slots.map((s) => s.start)).toEqual(['2026-09-21T22:00:00Z', '2026-09-21T23:00:00Z']);
  });

  it('keeps busy time and its buffers clear', () => {
    const slots = computeSlots({
      range: { start: `${MON}T09:00:00Z`, end: `${MON}T13:00:00Z` },
      durationMinutes: 60,
      intervalMinutes: 30,
      busy: [{ start: `${MON}T11:00:00Z`, end: `${MON}T11:30:00Z` }],
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
    });
    // A slot needs 15 free minutes after it (so it must end by 10:45) and 15
    // before it (so it may start at 11:45 at the earliest: 12:00 on the grid).
    expect(slots.map((s) => s.start)).toEqual([
      '2026-09-21T09:00:00Z',
      '2026-09-21T09:30:00Z',
      '2026-09-21T12:00:00Z',
    ]);
  });

  it('drops slots before now plus minimum notice', () => {
    const slots = computeSlots({
      range: { start: `${MON}T09:00:00Z`, end: `${MON}T12:00:00Z` },
      durationMinutes: 30,
      intervalMinutes: 30,
      now: `${MON}T09:05:00Z`,
      minNoticeMinutes: 60,
    });
    expect(slots[0]?.start).toBe('2026-09-21T10:30:00Z');
  });

  it('never offers a slot already under way, even without notice', () => {
    const slots = computeSlots({
      range: { start: `${MON}T09:00:00Z`, end: `${MON}T11:00:00Z` },
      durationMinutes: 60,
      now: new Date(`${MON}T09:00:01Z`),
    });
    expect(slots.map((s) => s.start)).toEqual(['2026-09-21T10:00:00Z']);
  });

  it('stops at the limit', () => {
    const slots = computeSlots({
      range: { start: `${MON}T09:00:00Z`, end: `${MON}T17:00:00Z` },
      durationMinutes: 30,
      intervalMinutes: 15,
      limit: 3,
    });
    expect(slots).toHaveLength(3);
  });

  it('rejects unusable rules with RangeError', () => {
    const range = { start: `${MON}T09:00:00Z`, end: `${MON}T17:00:00Z` };
    expect(() => computeSlots({ range, durationMinutes: 0 })).toThrow(RangeError);
    expect(() => computeSlots({ range, durationMinutes: 30, intervalMinutes: -5 })).toThrow(
      RangeError,
    );
    expect(() =>
      computeSlots({
        range,
        durationMinutes: 30,
        workingHours: { timezone: 'Nowhere/Land', periods: [] },
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSlots({
        range,
        durationMinutes: 30,
        workingHours: {
          timezone: 'UTC',
          periods: [{ dayOfWeek: 'MON', start: '9:00', end: '17:00' }],
        },
      }),
    ).toThrow(RangeError);
    expect(() => computeSlots({ range, durationMinutes: 30, minNoticeMinutes: 10 })).toThrow(
      RangeError,
    );
  });
});

describe('excludeBusy and busyFromBookings', () => {
  it('removes provider slots that clash with calendar busy time', () => {
    const slots = [
      { start: '2026-09-21T09:00:00Z', end: '2026-09-21T09:30:00Z', staffId: 'a' },
      { start: '2026-09-21T09:30:00Z', end: '2026-09-21T10:00:00Z', staffId: 'a' },
      { start: '2026-09-21T10:00:00Z', end: '2026-09-21T10:30:00Z', staffId: 'a' },
    ];
    const kept = excludeBusy(
      slots,
      [{ start: '2026-09-21T09:40:00Z', end: '2026-09-21T09:50:00Z' }],
      { bufferAfterMinutes: 5 },
    );
    // 09:30 overlaps; 09:00 ends at 09:30, and its 5-minute buffer after
    // (to 09:35) still clears the 09:40 event; 10:00 starts after it ends.
    expect(kept.map((s) => s.start)).toEqual(['2026-09-21T09:00:00Z', '2026-09-21T10:00:00Z']);
    expect(kept[0]).toBe(slots[0]); // extra fields and identity survive
  });

  it('treats cancelled, declined and waitlisted items as not busy', () => {
    const range = { start: '2026-09-21T09:00:00Z', end: '2026-09-21T10:00:00Z' };
    const busy = busyFromBookings([
      { range, status: 'confirmed' },
      { range, status: 'cancelled' },
      { range, status: 'declined' },
      { range, status: 'waitlisted' },
      { range, status: 'scheduled' }, // a ClassSession
      { range },
    ]);
    expect(busy).toHaveLength(3);
  });
});
