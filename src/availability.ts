import type { AvailabilitySlot } from './types';
import { addMinutes, formatWithOffset } from './time';

/**
 * Free-slot derivation shared by the plain-calendar adapters (Google freeBusy,
 * Outlook getSchedule). Both providers expose busy intervals only, so bookable
 * availability is the complement: the gaps in `range` no busy interval covers,
 * sliced into back-to-back slots of exactly `durationMinutes`.
 *
 * Every input is an RFC3339 instant with an offset (arithmetic uses `Date.parse`).
 * Slots are emitted in UTC (`Z`) via `formatWithOffset(epoch, 0)` so the output is
 * deterministic and offset-bearing regardless of which offsets the provider used
 * for its busy blocks — the conformance suite asserts `isInstant(slot.start)` and
 * `end > start`.
 */
export function freeSlots(
  range: { start: string; end: string },
  busy: Array<{ start: string; end: string }>,
  durationMinutes: number,
): AvailabilitySlot[] {
  const rangeStart = Date.parse(range.start);
  const rangeEnd = Date.parse(range.end);
  const durationMs = durationMinutes * 60_000;
  if (Number.isNaN(rangeStart) || Number.isNaN(rangeEnd) || durationMs <= 0) return [];

  // Clamp each busy interval to the range, drop anything that lands outside it
  // (or fails to parse), then sort so we can sweep left to right.
  const clamped = busy
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b) => !Number.isNaN(b.start) && !Number.isNaN(b.end))
    .map((b) => ({ start: Math.max(b.start, rangeStart), end: Math.min(b.end, rangeEnd) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  // Merge overlapping/adjacent busy intervals into disjoint blocks.
  const merged: Array<{ start: number; end: number }> = [];
  for (const b of clamped) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) {
      if (b.end > last.end) last.end = b.end;
    } else {
      merged.push({ ...b });
    }
  }

  // The free gaps are what the merged busy blocks leave uncovered within the
  // range; slice each gap, discarding a trailing remainder too short to fit.
  const slots: AvailabilitySlot[] = [];
  const emitGap = (gapStart: number, gapEnd: number) => {
    for (let s = gapStart; s + durationMs <= gapEnd; s += durationMs) {
      const start = formatWithOffset(s, 0);
      slots.push({ start, end: addMinutes(start, durationMinutes) });
    }
  };
  let cursor = rangeStart;
  for (const b of merged) {
    if (b.start > cursor) emitGap(cursor, b.start);
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < rangeEnd) emitGap(cursor, rangeEnd);
  return slots;
}
