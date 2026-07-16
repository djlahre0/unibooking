import type { ProviderId, TimeRange } from './types';
import { UnibookingError } from './errors';

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
