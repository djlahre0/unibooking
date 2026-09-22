import type { ProviderId, TimeRange } from './types';
import { UnibookingError } from './errors';
import { zoneOffsetMinutes } from './tz';

/**
 * Time handling is the #1 cross-provider correctness hazard. Rules here:
 *  - A canonical instant is an RFC3339 string WITH an offset (`Z` or `±HH:MM`).
 *  - Arithmetic preserves the input's offset so the displayed wall-clock stays
 *    meaningful (e.g. `15:00-07:00` + 45m = `15:45-07:00`, not a UTC `Z` form).
 *  - `end` must be strictly after `start`.
 * No date library — just careful epoch math, exhaustively unit-tested.
 */

const OFFSET_RE = /([+-]\d{2}:\d{2}|Z)$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:\d{2}|Z)$/i;

/** True if `s` is an RFC3339 timestamp with an explicit offset (an absolute instant). */
export function isInstant(s: string): boolean {
  return RFC3339_RE.test(s) && !Number.isNaN(Date.parse(s));
}

/** Offset of an RFC3339 string in minutes east of UTC (`Z` → 0), or null if absent. */
export function parseOffsetMinutes(iso: string): number | null {
  const m = OFFSET_RE.exec(iso);
  if (!m) return null;
  const tok = m[1]!;
  if (tok.toUpperCase() === 'Z') return 0;
  const sign = tok[0] === '-' ? -1 : 1;
  const hh = Number(tok.slice(1, 3));
  const mm = Number(tok.slice(4, 6));
  return sign * (hh * 60 + mm);
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

/** Format an epoch-ms instant as RFC3339 in a fixed UTC offset (minutes east). */
export function formatWithOffset(epochMs: number, offsetMinutes: number): string {
  const local = new Date(epochMs + offsetMinutes * 60_000);
  const date =
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  if (offsetMinutes === 0) return `${date}Z`;
  const sign = offsetMinutes > 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${date}${sign}${pad(Math.trunc(abs / 60))}:${pad(abs % 60)}`;
}

/** Add minutes to an RFC3339 instant, preserving its original offset. If the
 *  input carries no offset, the result is emitted in UTC (`Z`). */
export function addMinutes(iso: string, minutes: number): string {
  const epoch = Date.parse(iso);
  if (Number.isNaN(epoch)) throw new RangeError(`addMinutes: not a valid timestamp: ${iso}`);
  const offset = parseOffsetMinutes(iso);
  const shifted = epoch + minutes * 60_000;
  return offset === null ? new Date(shifted).toISOString() : formatWithOffset(shifted, offset);
}

/** Compute an end instant from a start and a duration in minutes. */
export function endFromDuration(start: string, durationMinutes: number): string {
  return addMinutes(start, durationMinutes);
}

/** Duration between two instants, in whole minutes. */
export function durationMinutes(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
}

/** Validate a canonical range: both endpoints parse and `end > start`. Throws
 *  `UnibookingError('INVALID_INPUT')` (client-side, before hitting the provider). */
export function assertValidRange(range: TimeRange, provider: ProviderId): void {
  const s = Date.parse(range.start);
  const e = Date.parse(range.end);
  if (Number.isNaN(s)) {
    throw new UnibookingError({
      provider,
      code: 'INVALID_INPUT',
      message: `range.start is not a valid timestamp: ${range.start}`,
    });
  }
  if (Number.isNaN(e)) {
    throw new UnibookingError({
      provider,
      code: 'INVALID_INPUT',
      message: `range.end is not a valid timestamp: ${range.end}`,
    });
  }
  // The canonical contract requires an explicit offset (Z or ±HH:MM). An
  // offset-less string parses fine but is interpreted host-locally by downstream
  // date math, so reject it here rather than forward an ambiguous instant.
  if (parseOffsetMinutes(range.start) === null) {
    throw new UnibookingError({
      provider,
      code: 'INVALID_INPUT',
      message: `range.start must carry an explicit UTC offset (e.g. Z or +02:00): ${range.start}`,
    });
  }
  if (parseOffsetMinutes(range.end) === null) {
    throw new UnibookingError({
      provider,
      code: 'INVALID_INPUT',
      message: `range.end must carry an explicit UTC offset (e.g. Z or +02:00): ${range.end}`,
    });
  }
  if (e <= s) {
    throw new UnibookingError({
      provider,
      code: 'INVALID_INPUT',
      message: `range.end must be after range.start (start=${range.start}, end=${range.end})`,
    });
  }
}

// --- Zoned wall-clock time --------------------------------------------------
// Forms and calendars speak in "10:00 on 21 Sep in Asia/Kolkata"; the canonical
// model speaks in instants. These convert between the two through the platform
// Intl zone database (IANA ids, plus the Windows ids Exchange emits).

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DAY_MS = 86_400_000;

function offsetAt(timeZone: string, epochMs: number): number {
  const off = zoneOffsetMinutes(timeZone, new Date(epochMs));
  if (off === null) throw new RangeError(`unknown time zone: ${timeZone}`);
  return off;
}

/**
 * A wall-clock `YYYY-MM-DDTHH:mm` (or `:ss`) in a zone → the RFC3339 instant,
 * written in that zone's offset at that moment:
 * `zonedToInstant('2026-09-21T10:00', 'Asia/Kolkata')` → `'2026-09-21T10:00:00+05:30'`.
 *
 * A time inside a DST gap resolves forward (02:30 on a spring-forward day is
 * 03:30); a time that happens twice in an overlap resolves to the earlier one.
 * Throws RangeError for malformed or impossible input or an unknown zone —
 * never falling back to UTC, which would silently move the event by hours.
 */
export function zonedToInstant(localDateTime: string, timeZone: string): string {
  const m = LOCAL_RE.exec(localDateTime);
  if (!m) throw new RangeError(`expected YYYY-MM-DDTHH:mm[:ss], got ${localDateTime}`);
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(guess);
  if (
    h > 23 ||
    mi > 59 ||
    s > 59 ||
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d
  ) {
    throw new RangeError(`not a real date-time: ${localDateTime}`);
  }
  // DST transitions are far more than 48h apart, so the offsets a day either
  // side bracket the only two readings this wall-clock time can have.
  const before = offsetAt(timeZone, guess - DAY_MS);
  const after = offsetAt(timeZone, guess + DAY_MS);
  const valid = [...new Set([before, after])]
    .map((off) => ({ off, epoch: guess - off * 60_000 }))
    .filter((c) => offsetAt(timeZone, c.epoch) === c.off)
    .map((c) => c.epoch);
  // No valid reading is a DST gap: reading it with the pre-transition offset
  // lands the same distance past the jump.
  const epoch = valid.length > 0 ? Math.min(...valid) : guess - before * 60_000;
  return formatWithOffset(epoch, offsetAt(timeZone, epoch));
}

/** An instant's wall clock in a zone as `YYYY-MM-DDTHH:mm:ss`, or undefined
 *  when the instant or the zone cannot be resolved. */
export function wallClockIn(instant: string, timeZone: string): string | undefined {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return undefined;
  const off = zoneOffsetMinutes(timeZone, new Date(ms));
  if (off === null) return undefined;
  return formatWithOffset(ms, off).slice(0, 19);
}

/** An instant → its wall-clock date and time in a zone:
 *  `instantToZoned('2026-09-21T04:30:00Z', 'Asia/Kolkata')` →
 *  `{ date: '2026-09-21', time: '10:00' }`. Throws RangeError for an invalid
 *  instant or an unknown zone. */
export function instantToZoned(instant: string, timeZone: string): { date: string; time: string } {
  if (Number.isNaN(Date.parse(instant))) throw new RangeError(`not a valid timestamp: ${instant}`);
  const local = wallClockIn(instant, timeZone);
  if (local === undefined) throw new RangeError(`unknown time zone: ${timeZone}`);
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

// --- All-day events ---------------------------------------------------------

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})T/;

/** The calendar dates of an all-day range, read as written in each endpoint's
 *  own offset (the caller's wall clock, never UTC — midnight +05:30 is still
 *  the 21st), end exclusive. A range whose end date is its start date covers no
 *  whole day and is rejected rather than rounded. */
export function allDayDates(
  range: TimeRange,
  provider: ProviderId,
): { start: string; end: string } {
  const start = DATE_PREFIX.exec(range.start)?.[1];
  const end = DATE_PREFIX.exec(range.end)?.[1];
  if (start === undefined || end === undefined) {
    throw new UnibookingError({
      provider,
      code: 'INVALID_INPUT',
      message: 'all-day range endpoints must be RFC3339 date-times',
    });
  }
  if (end <= start) {
    throw new UnibookingError({
      provider,
      code: 'INVALID_INPUT',
      message: `all-day end date must be after the start date (end is exclusive): ${start}..${end}`,
    });
  }
  return { start, end };
}

/** The canonical read form of an all-day date: UTC midnight of that date. */
export function allDayInstant(date: string): string {
  return `${date}T00:00:00Z`;
}

/** Switching between timed and all-day rewrites both endpoints, so an update
 *  that sets `allDay` has to supply them. */
export function assertAllDayInput(
  input: { allDay?: boolean; range?: TimeRange },
  provider: ProviderId,
): void {
  if (input.allDay !== undefined && input.range === undefined) {
    throw new UnibookingError({
      provider,
      code: 'INVALID_INPUT',
      message: 'changing allDay requires a range',
    });
  }
}
