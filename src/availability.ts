import type { AvailabilitySlot, TimeRange } from './types';
import { addMinutes, formatWithOffset } from './time';

/**
 * Order slots chronologically by start instant.
 *
 * Providers hand availability back grouped by whatever they iterate over, not by
 * time: Mindbody and Microsoft Bookings return a whole shift per staff member,
 * and the day-fan-out adapters concatenate one day's answer after another. That
 * left `slots[0]` meaning "first thing the provider happened to mention" rather
 * than "earliest opening", and made the same logical availability come back in a
 * different order per provider — the exact cross-provider variance this package
 * exists to erase. `defineAdapter` applies this to every adapter's
 * `searchAvailability` so no adapter has to remember.
 *
 * The sort is by instant, not string — `08:00-07:00` is later than `12:00Z`
 * despite sorting earlier lexically. It is stable, so slots sharing a start keep
 * the provider's own order (usually staff order), and it copies rather than
 * mutating the caller's array. An unparseable start sorts last instead of being
 * dropped: ordering is not the place to discard data.
 */
export function sortSlots(slots: AvailabilitySlot[]): AvailabilitySlot[] {
  const key = (s: AvailabilitySlot): number => {
    const ms = Date.parse(s.start);
    return Number.isNaN(ms) ? Infinity : ms;
  };
  return [...slots].sort((a, b) => key(a) - key(b));
}

/**
 * Clip a slot list to the window the caller actually asked for.
 *
 * Several providers answer availability at DATE granularity — Acuity's
 * `availability/times`, Vagaro's `appointmentDate`, Setmore's `selected_date`,
 * Zenoti's booking `date` — or hand back a whole staff shift (Mindbody's
 * `Availabilities[]`). In every one of those cases the upstream request cannot
 * express `range` any finer than a day, so a partial-day query comes back
 * carrying the entire business day and the adapter has to do the narrowing
 * itself. Providers whose endpoint takes real instants (Square, Calendly,
 * Bookeo, Phorest, Wix, Graph) filter server-side and don't need this.
 *
 * The window is half-open on the START instant: a slot is bookable if it begins
 * at or after `range.start` and strictly before `range.end`. The end is
 * deliberately not bounded — for a start-only provider the slot length comes
 * from the service duration, so the last bookable start of a window routinely
 * runs past it, and that slot is still real.
 */
export function slotsWithinRange(slots: AvailabilitySlot[], range: TimeRange): AvailabilitySlot[] {
  const windowStart = Date.parse(range.start);
  const windowEnd = Date.parse(range.end);
  if (Number.isNaN(windowStart) || Number.isNaN(windowEnd)) return slots;
  return slots.filter((s) => {
    const start = Date.parse(s.start);
    // An unparseable start can't be shown to be inside the window; dropping it
    // is the honest answer, and it keeps a malformed instant out of the result.
    if (Number.isNaN(start)) return false;
    return start >= windowStart && start < windowEnd;
  });
}

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
