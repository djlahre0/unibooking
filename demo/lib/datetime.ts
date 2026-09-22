import { zonedToInstant } from 'unibooking';

/**
 * Turning what a visitor picked in a date/time control into the canonical
 * instant the library takes.
 *
 * The explorer used to ask people to hand-type RFC3339 strings, offset and
 * all, which is both hostile to type and impossible to get right for a zone
 * that observes DST. Native `<input type="date">` and `<input type="time">`
 * give a wall-clock date and time with no zone attached; this anchors that
 * pair in a named IANA zone via the library's own `zonedToInstant`, so the
 * demo never does offset arithmetic itself.
 */

/** The visitor's own IANA zone, or UTC when the browser will not say. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * `2026-09-22` + `10:00` + `Asia/Kolkata` → `2026-09-22T10:00:00+05:30`.
 *
 * A blank time means midnight. An unknown or unusable zone returns the plain
 * local string instead of throwing: this runs inside submit handlers, and a
 * provider rejecting an obviously zone-less value is far better than an
 * unhandled error taking the page down.
 */
export function toInstant(date: string, time: string, timeZone: string): string {
  if (!date) return '';
  const local = `${date}T${time || '00:00'}`;
  try {
    return zonedToInstant(local, timeZone);
  } catch {
    return `${local}:00`;
  }
}
