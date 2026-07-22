import { describe, expect, it } from 'vitest';
import { freeSlots } from '../src/availability';
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
