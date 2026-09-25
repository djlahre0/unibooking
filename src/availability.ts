import type {
  AvailabilityQuery,
  AvailabilitySlot,
  HoursPeriod,
  ProviderId,
  TimeRange,
  Weekday,
  WorkingHours,
} from './types';
import { UnibookingError } from './errors';
import { addMinutes, formatWithOffset, zonedToInstant } from './time';
import { zoneOffsetMinutes } from './tz';

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
 * Free-slot derivation for the plain-calendar adapters, in its original form:
 * the gaps in `range` no busy interval covers, sliced into back-to-back slots of
 * exactly `durationMinutes`, emitted in UTC. Kept as the name the adapters and
 * their tests grew up with; `computeSlots` is the general version.
 */
export function freeSlots(
  range: { start: string; end: string },
  busy: Array<{ start: string; end: string }>,
  durationMinutes: number,
): AvailabilitySlot[] {
  if (!(durationMinutes > 0)) return [];
  if (Number.isNaN(Date.parse(range.start)) || Number.isNaN(Date.parse(range.end))) return [];
  return computeSlots({ range, busy, durationMinutes });
}

// --- computeSlots -----------------------------------------------------------

/** A span of time that blocks a slot: a calendar event, an existing booking, a
 *  class the staff member teaches. Offset-bearing RFC3339 instants. */
export interface BusyInterval {
  start: string;
  end: string;
}

export interface ComputeSlotsInput {
  /** The window to search. `timezone`, when set and no `workingHours` are
   *  given, is the zone the `intervalMinutes` grid is anchored in. */
  range: TimeRange;
  /** Length of each slot — normally the service's duration. */
  durationMinutes: number;
  /** Minutes between candidate starts. Setting it (or `workingHours`) puts
   *  starts on a grid counted from the start of each opening period, or from
   *  local midnight without hours — so a gap that opens at 10:10 offers 10:30,
   *  not 10:10. Omitted along with `workingHours`, slots run back-to-back from
   *  the start of each free gap, emitted in UTC. */
  intervalMinutes?: number;
  /** Everything that blocks time. Overlaps and duplicates are fine. */
  busy?: ReadonlyArray<BusyInterval>;
  /** Only offer slots fully inside these weekly hours. */
  workingHours?: WorkingHours;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  /** Earliest start, as minutes after `now`. Requires `now`. */
  minNoticeMinutes?: number;
  /** The current time. Slots starting before `now + minNoticeMinutes` are
   *  dropped; omitted, nothing is dropped for being in the past. */
  now?: number | Date | string;
  /** Stop after this many slots. */
  limit?: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS: Weekday[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
/** Statuses that do not occupy the time they name. */
const NON_BLOCKING = new Set(['cancelled', 'declined', 'waitlisted']);

function nonNegative(v: number | undefined): boolean {
  return v === undefined || (Number.isFinite(v) && v >= 0);
}

/**
 * The first reason the slot rules are unusable, phrased for the caller, or
 * undefined. Shared by `computeSlots` (which throws RangeError, like the other
 * pure time helpers) and the adapters (which throw INVALID_INPUT before any
 * request goes out).
 */
export function slotRulesProblem(
  input: Pick<
    ComputeSlotsInput,
    | 'durationMinutes'
    | 'intervalMinutes'
    | 'workingHours'
    | 'bufferBeforeMinutes'
    | 'bufferAfterMinutes'
    | 'minNoticeMinutes'
  >,
): string | undefined {
  if (!(Number.isFinite(input.durationMinutes) && input.durationMinutes > 0)) {
    return 'durationMinutes must be a positive number';
  }
  if (
    input.intervalMinutes !== undefined &&
    !(Number.isFinite(input.intervalMinutes) && input.intervalMinutes > 0)
  ) {
    return 'intervalMinutes must be a positive number';
  }
  if (!nonNegative(input.bufferBeforeMinutes)) return 'bufferBeforeMinutes must be ≥ 0';
  if (!nonNegative(input.bufferAfterMinutes)) return 'bufferAfterMinutes must be ≥ 0';
  if (!nonNegative(input.minNoticeMinutes)) return 'minNoticeMinutes must be ≥ 0';
  const hours = input.workingHours;
  if (hours !== undefined) {
    if (
      typeof hours.timezone !== 'string' ||
      zoneOffsetMinutes(hours.timezone, new Date()) === null
    ) {
      return `workingHours.timezone is not a known time zone: ${String(hours.timezone)}`;
    }
    if (!Array.isArray(hours.periods)) return 'workingHours.periods must be an array';
    for (const p of hours.periods) {
      if (!WEEKDAYS.includes(p?.dayOfWeek)) {
        return `workingHours period has an unknown dayOfWeek: ${String(p?.dayOfWeek)}`;
      }
      if (!HHMM.test(p.start) || !(HHMM.test(p.end) || p.end === '24:00')) {
        return `workingHours period times must be HH:MM (got ${String(p.start)}–${String(p.end)})`;
      }
    }
  }
  return undefined;
}

/** `slotRulesProblem` for an adapter: INVALID_INPUT, before any request. */
export function assertSlotRules(query: AvailabilityQuery, provider: ProviderId): void {
  const problem = slotRulesProblem({
    durationMinutes: query.durationMinutes ?? NaN,
    ...slotRulesOf(query),
  });
  if (problem !== undefined) {
    throw new UnibookingError({ provider, code: 'INVALID_INPUT', message: problem });
  }
}

/** The slot-rule fields of a canonical query, for handing to `computeSlots`. */
export function slotRulesOf(
  query: AvailabilityQuery,
): Pick<
  ComputeSlotsInput,
  | 'intervalMinutes'
  | 'workingHours'
  | 'bufferBeforeMinutes'
  | 'bufferAfterMinutes'
  | 'minNoticeMinutes'
> {
  return {
    ...(query.intervalMinutes !== undefined ? { intervalMinutes: query.intervalMinutes } : {}),
    ...(query.workingHours !== undefined ? { workingHours: query.workingHours } : {}),
    ...(query.bufferBeforeMinutes !== undefined
      ? { bufferBeforeMinutes: query.bufferBeforeMinutes }
      : {}),
    ...(query.bufferAfterMinutes !== undefined
      ? { bufferAfterMinutes: query.bufferAfterMinutes }
      : {}),
    ...(query.minNoticeMinutes !== undefined ? { minNoticeMinutes: query.minNoticeMinutes } : {}),
  };
}

function epochOf(v: number | Date | string): number {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  return Date.parse(v);
}

function localDate(epochMs: number, zone: string): string {
  const off = zoneOffsetMinutes(zone, new Date(epochMs)) ?? 0;
  return formatWithOffset(epochMs, off).slice(0, 10);
}

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** A wall-clock time on a date in a zone → epoch ms. `24:00` is the next
 *  midnight. */
function wallToEpoch(date: string, hhmm: string, zone: string): number {
  if (hhmm === '24:00') return Date.parse(zonedToInstant(`${shiftDay(date, 1)}T00:00`, zone));
  return Date.parse(zonedToInstant(`${date}T${hhmm}`, zone));
}

interface Window {
  start: number;
  end: number;
  /** Where the start grid is counted from. */
  anchor: number;
}

/** The opening periods that touch [from, to), each clipped to it. */
function hoursWindows(from: number, to: number, hours: WorkingHours): Window[] {
  const windows: Window[] = [];
  const zone = hours.timezone;
  // A day early: yesterday's overnight period can still be open at `from`.
  const last = localDate(to, zone);
  for (let date = shiftDay(localDate(from, zone), -1); date <= last; date = shiftDay(date, 1)) {
    const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
    for (const p of hours.periods as HoursPeriod[]) {
      if (p.dayOfWeek !== weekday) continue;
      const open = wallToEpoch(date, p.start, zone);
      // An end at or before the start runs past midnight into the next day.
      const closeDate = p.end !== '24:00' && p.end <= p.start ? shiftDay(date, 1) : date;
      const close = wallToEpoch(closeDate, p.end, zone);
      const start = Math.max(open, from);
      const end = Math.min(close, to);
      if (end > start) windows.push({ start, end, anchor: open });
    }
  }
  return windows.sort((a, b) => a.start - b.start);
}

/** Merge intervals into sorted, disjoint blocks. */
function mergeIntervals(list: Array<{ start: number; end: number }>) {
  const sorted = list.filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const b of sorted) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) {
      if (b.end > last.end) last.end = b.end;
    } else {
      merged.push({ ...b });
    }
  }
  return merged;
}

/** Busy intervals widened so that a slot touching the widened block is exactly
 *  a slot that violates a buffer: [start − after, end + before). */
function paddedBusy(
  busy: ReadonlyArray<BusyInterval>,
  before: number,
  after: number,
): Array<{ start: number; end: number }> {
  return mergeIntervals(
    busy
      .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
      .filter((b) => !Number.isNaN(b.start) && !Number.isNaN(b.end))
      .map((b) => ({ start: b.start - after, end: b.end + before })),
  );
}

/** Index of the first block that ends after `t` (blocks are sorted, disjoint). */
function firstEndingAfter(blocks: Array<{ start: number; end: number }>, t: number): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid]!.end <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Bookable slots from everything that constrains them, in one pass: the search
 * window, the slot length and start grid, weekly working hours in their own
 * zone, busy time from any number of sources (calendar events, existing
 * bookings, classes taught), buffers around busy time, minimum notice and the
 * current time.
 *
 * Pure: no I/O, and the clock is an input. DST is handled by anchoring every
 * opening period in its zone on its own date, so "09:00–17:00" stays 09:00–17:00
 * local across a transition. Slots are chronological and never overlap busy
 * time (buffers included). With `workingHours` or a zoned grid, instants are
 * written in that zone's offset; otherwise in UTC.
 *
 * Throws RangeError for unusable rules (see `slotRulesProblem`) or an
 * unparseable range.
 */
export function computeSlots(input: ComputeSlotsInput): AvailabilitySlot[] {
  const problem = slotRulesProblem(input);
  if (problem !== undefined) throw new RangeError(problem);
  const from = Date.parse(input.range.start);
  const to = Date.parse(input.range.end);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new RangeError(`range is not a pair of valid timestamps`);
  }
  const nowMs = input.now !== undefined ? epochOf(input.now) : undefined;
  if (nowMs !== undefined && Number.isNaN(nowMs)) throw new RangeError('now is not a valid time');
  if (input.minNoticeMinutes && nowMs === undefined) {
    throw new RangeError('minNoticeMinutes needs now');
  }

  const durationMs = input.durationMinutes * MINUTE_MS;
  const earliest =
    nowMs === undefined ? -Infinity : nowMs + (input.minNoticeMinutes ?? 0) * MINUTE_MS;
  const blocks = paddedBusy(
    input.busy ?? [],
    (input.bufferBeforeMinutes ?? 0) * MINUTE_MS,
    (input.bufferAfterMinutes ?? 0) * MINUTE_MS,
  );
  const limit = input.limit ?? Infinity;
  const slots: AvailabilitySlot[] = [];
  if (to <= from || limit <= 0) return slots;

  const gridded = input.intervalMinutes !== undefined || input.workingHours !== undefined;
  if (!gridded) {
    // Back-to-back from each free gap, in UTC: the historical calendar
    // behaviour, kept exactly so existing callers see the same slots.
    let cursor = from;
    const emitGap = (gapStart: number, gapEnd: number): boolean => {
      for (let s = gapStart; s + durationMs <= gapEnd; s += durationMs) {
        if (s < earliest) continue;
        const start = formatWithOffset(s, 0);
        slots.push({ start, end: addMinutes(start, input.durationMinutes) });
        if (slots.length >= limit) return false;
      }
      return true;
    };
    for (const b of blocks) {
      if (b.end <= from) continue;
      if (b.start >= to) break;
      if (b.start > cursor && !emitGap(cursor, Math.min(b.start, to))) return slots;
      cursor = Math.max(cursor, b.end);
    }
    if (cursor < to) emitGap(cursor, to);
    return slots;
  }

  const zone = input.workingHours?.timezone ?? zoneOrUndefined(input.range.timezone);
  const step = (input.intervalMinutes ?? input.durationMinutes) * MINUTE_MS;
  const windows = input.workingHours
    ? hoursWindows(from, to, input.workingHours)
    : [
        {
          start: from,
          end: to,
          anchor: zone
            ? wallToEpoch(localDate(from, zone), '00:00', zone)
            : Math.floor(from / DAY_MS) * DAY_MS,
        },
      ];

  const fmt = (ms: number): string =>
    formatWithOffset(ms, zone ? (zoneOffsetMinutes(zone, new Date(ms)) ?? 0) : 0);
  const seen = new Set<number>();
  for (const w of windows) {
    const first = Math.max(w.start, earliest);
    let s = w.anchor + Math.max(0, Math.ceil((first - w.anchor) / step)) * step;
    let i = firstEndingAfter(blocks, s);
    for (; s + durationMs <= w.end; s += step) {
      while (i < blocks.length && blocks[i]!.end <= s) i++;
      const block = blocks[i];
      if (block && block.start < s + durationMs) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      slots.push({ start: fmt(s), end: fmt(s + durationMs) });
      if (slots.length >= limit) return sortSlots(slots);
    }
  }
  // Overlapping periods can interleave; chronological order is the contract.
  return sortSlots(slots);
}

function zoneOrUndefined(zone: string | undefined): string | undefined {
  return zone && zoneOffsetMinutes(zone, new Date()) !== null ? zone : undefined;
}

/**
 * Slots from one source minus busy time from another — a booking platform's
 * slots for a staff member, less the events on that person's own Google or
 * Outlook calendar. Buffers work as in `computeSlots`.
 */
export function excludeBusy<T extends { start: string; end: string }>(
  slots: ReadonlyArray<T>,
  busy: ReadonlyArray<BusyInterval>,
  options: { bufferBeforeMinutes?: number; bufferAfterMinutes?: number } = {},
): T[] {
  const blocks = paddedBusy(
    busy,
    (options.bufferBeforeMinutes ?? 0) * MINUTE_MS,
    (options.bufferAfterMinutes ?? 0) * MINUTE_MS,
  );
  return slots.filter((slot) => {
    const s = Date.parse(slot.start);
    const e = Date.parse(slot.end);
    if (Number.isNaN(s) || Number.isNaN(e)) return false;
    const block = blocks[firstEndingAfter(blocks, s)];
    return !(block && block.start < e);
  });
}

/**
 * The busy time bookings, calendar events or class sessions occupy: every item
 * except the ones whose status frees the time (cancelled, declined,
 * waitlisted).
 */
export function busyFromBookings(
  items: ReadonlyArray<{ range: { start: string; end: string }; status?: string }>,
): BusyInterval[] {
  return items
    .filter((b) => b.status === undefined || !NON_BLOCKING.has(b.status))
    .map((b) => ({ start: b.range.start, end: b.range.end }));
}
