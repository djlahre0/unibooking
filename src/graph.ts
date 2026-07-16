import { formatWithOffset } from './time';
import { localToInstant } from './tz';

/**
 * Shared Microsoft Graph helpers (used by the Outlook and Microsoft Bookings
 * adapters). Graph represents times as `{ dateTime, timeZone }` where dateTime
 * has no offset. We always request UTC via the `Prefer: outlook.timezone`
 * header and convert to/from canonical RFC3339 instants here.
 */

/** Canonical instant → Graph `dateTimeTimeZone` (UTC). */
export function graphDateTime(instant: string): { dateTime: string; timeZone: string } {
  const utc = formatWithOffset(Date.parse(instant), 0); // e.g. 2026-07-20T22:00:00Z
  return { dateTime: utc.slice(0, -1), timeZone: 'UTC' };
}

/** Graph `dateTimeTimeZone` → canonical instant (UTC), or undefined if unusable. */
export function graphToInstant(dtz: any): string | undefined {
  if (!dtz || typeof dtz.dateTime !== 'string') return undefined;
  const raw: string = dtz.dateTime;
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (hasOffset) {
    const epoch = Date.parse(raw);
    return Number.isNaN(epoch) ? undefined : formatWithOffset(epoch, 0);
  }
  // No offset. We request UTC via `Prefer`, but not every Graph surface honors
  // it (e.g. Microsoft Bookings can return business-local times), so resolve
  // against the accompanying `timeZone` rather than blindly assuming UTC.
  const tz: string | undefined = typeof dtz.timeZone === 'string' ? dtz.timeZone : undefined;
  const local = raw.replace(/\.\d+$/, ''); // drop Graph's 7-digit fractional seconds
  if (tz && tz.toUpperCase() !== 'UTC') {
    return localToInstant(local, tz, (epochMs) => formatWithOffset(epochMs, 0));
  }
  const epoch = Date.parse(local + 'Z');
  return Number.isNaN(epoch) ? undefined : formatWithOffset(epoch, 0);
}

/** The full Graph `@odata.nextLink` URL, or undefined. Returning the whole URL
 *  (rather than just `$skiptoken`) lets the caller follow it verbatim, so
 *  `$skip`-based paging works too. */
export function nextLinkFrom(res: unknown): string | undefined {
  const link = (res as any)?.['@odata.nextLink'];
  return typeof link === 'string' && link ? link : undefined;
}

export function parseGraphError(
  _status: number,
  body: unknown,
): { providerCode?: string; message?: string } {
  const err = (body as any)?.error;
  if (!err) return {};
  return {
    ...(typeof err.message === 'string' ? { message: err.message } : {}),
    ...(typeof err.code === 'string' ? { providerCode: err.code } : {}),
  };
}

/** Prefer header so Graph returns times in UTC. */
export const PREFER_UTC = { prefer: 'outlook.timezone="UTC"' };
