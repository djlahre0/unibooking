import { describe, expect, it } from 'vitest';
import { freeSlots, slotsWithinRange, sortSlots } from '../src/availability';
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
