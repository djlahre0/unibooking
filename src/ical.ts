import { formatWithOffset } from './time';
import { localToInstant, zoneOffsetMinutes } from './tz';

/**
 * Minimal, dependency-free iCalendar (RFC 5545) reader/writer — enough for the
 * CalDAV adapter's VEVENT round-trips. Handles line folding, the common DTSTART
 * forms (UTC `Z`, `TZID=`, `VALUE=DATE`, floating), and TZID → instant via the
 * platform `Intl` time-zone database.
 */

export interface VEvent {
  uid: string;
  summary?: string;
  status?: string;
  start?: string;
  end?: string;
  attendee?: { email?: string; name?: string };
  /** Present only on an overridden occurrence of a recurring series. Expanded
   *  instances of one series share a DAV resource (and so a booking id) — this
   *  is what tells them apart. */
  recurrenceId?: string;
  /** Raw RRULE value (e.g. `FREQ=WEEKLY;BYDAY=MO,WE`) of a recurring master.
   *  Consumed by `expandRecurrence` for the client-side expansion fallback. */
  rrule?: string;
  /** Raw value of each EXDATE property (one entry per line; a single line can
   *  itself be a comma-separated list). Excluded dates for a recurring master. */
  exdate?: string[];
  raw: string;
}

/** `20260720T150000` interpreted in `tzid` → canonical UTC instant. If the zone
 *  can't be resolved (a custom/unknown TZID), the value is treated as UTC so a
 *  single foreign-origin event can't take down a whole `listBookings`. */
function zonedToInstant(basic: string, tzid: string): string | undefined {
  const iso = basicToIsoLocal(basic);
  if (iso === undefined) return undefined;
  return localToInstant(iso, tzid, (epochMs) => formatWithOffset(epochMs, 0));
}

/** `20260720T150000` → `2026-07-20T15:00:00` (no offset). */
function basicToIsoLocal(basic: string): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(basic);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function icalDateToInstant(value: string, params: Record<string, string>): string | undefined {
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` : undefined;
  }
  if (value.endsWith('Z')) {
    const iso = basicToIsoLocal(value.slice(0, -1));
    return iso ? iso + 'Z' : undefined;
  }
  if (params.TZID) return zonedToInstant(value, params.TZID);
  // Floating time: no zone info — treat as UTC (documented limitation).
  const iso = basicToIsoLocal(value);
  return iso ? iso + 'Z' : undefined;
}

/** Split a content line at the first `:` that is not inside a DQUOTEd param
 *  value → `[left, value]`, or null if there is no value colon. */
function splitAtValueColon(line: string): [string, string] | null {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) return [line.slice(0, i), line.slice(i + 1)];
  }
  return null;
}

/** Split on `;` not inside DQUOTEs (property name + parameters). */
function splitParams(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
    } else if (ch === ';' && !inQuote) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function stripQuotes(v: string): string {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

/** DQUOTE-wrap a parameter value if it contains a char that would otherwise
 *  break parsing (`:`/`;`/`,`); embedded DQUOTEs/newlines are dropped (RFC5545
 *  forbids them inside a quoted string). */
function quoteParam(v: string): string {
  const cleaned = v.replace(/["\r\n]/g, '');
  return /[:;,]/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

/** An instant rendered as iCalendar local basic form (`YYYYMMDDTHHMMSS`, no `Z`)
 *  in `tz`. Returns undefined when the zone can't be resolved. */
function instantToICalLocal(instant: string, tz: string): string | undefined {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return undefined;
  const offset = zoneOffsetMinutes(tz, new Date(ms));
  if (offset === null) return undefined;
  const d = new Date(ms + offset * 60_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

function unescapeText(s: string): string {
  // Single pass. Sequential replaces expanded the `\n` *inside* an escaped
  // backslash first: the wire value `C:\\new` (correct encoding of `C:\new`)
  // decoded to `C:\` + LF + `ew`.
  return s.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

function escapeText(s: string): string {
  // RFC 5545 §3.3.11 defines no `\r` escape and TSAFE-CHAR excludes control
  // characters, so normalize line endings before escaping. Emitting a bare CR
  // re-splits the content line and corrupts the property.
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Parse every VEVENT in an iCalendar document. */
export function parseICS(text: string): VEvent[] {
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r\n|\n|\r/);
  const events: VEvent[] = [];
  let cur:
    | (Partial<VEvent> & { _duration?: string; _allDayStart?: boolean; _rawLines: string[] })
    | null = null;

  // Depth of components nested inside the current VEVENT (VALARM, and anything
  // else a server may embed). Their properties describe the sub-component, not
  // the event — an EMAIL VALARM carries its own SUMMARY/ATTENDEE/DURATION, which
  // would otherwise overwrite the booking's title, customer, and end time.
  let nested = 0;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = { _rawLines: [line] };
      nested = 0;
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur && cur.uid) {
        cur._rawLines.push(line);
        if (cur.end === undefined && cur.start !== undefined && cur._duration) {
          const derived = applyDuration(cur.start, cur._duration);
          if (derived !== undefined) cur.end = derived;
        }
        // RFC5545 default end when neither DTEND nor DURATION is present: an
        // all-day (DATE) event lasts one day; a timed event has zero duration.
        // A zero-length event therefore reports `end === start`, which canonical
        // *inputs* forbid — but reporting it truthfully beats inventing a
        // duration or dropping the event outright.
        if (cur.end === undefined && cur.start !== undefined) {
          cur.end = cur._allDayStart
            ? formatWithOffset(Date.parse(cur.start) + 86_400_000, 0)
            : cur.start;
        }
        events.push({
          uid: cur.uid,
          raw: cur._rawLines.join('\n'),
          ...(cur.summary !== undefined ? { summary: cur.summary } : {}),
          ...(cur.status !== undefined ? { status: cur.status } : {}),
          ...(cur.start !== undefined ? { start: cur.start } : {}),
          ...(cur.end !== undefined ? { end: cur.end } : {}),
          ...(cur.attendee !== undefined ? { attendee: cur.attendee } : {}),
          ...(cur.recurrenceId !== undefined ? { recurrenceId: cur.recurrenceId } : {}),
          ...(cur.rrule !== undefined ? { rrule: cur.rrule } : {}),
          ...(cur.exdate !== undefined ? { exdate: cur.exdate } : {}),
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    cur._rawLines.push(line);

    if (/^BEGIN:/i.test(line)) {
      nested++;
      continue;
    }
    if (/^END:/i.test(line)) {
      if (nested > 0) nested--;
      continue;
    }
    if (nested > 0) continue;

    const split = splitAtValueColon(line);
    if (!split) continue;
    const [left, value] = split;
    const [rawName, ...paramParts] = splitParams(left);
    const name = (rawName ?? '').toUpperCase();
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const eq = p.indexOf('=');
      if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = stripQuotes(p.slice(eq + 1));
    }

    switch (name) {
      case 'UID':
        cur.uid = value;
        break;
      case 'SUMMARY':
        cur.summary = unescapeText(value);
        break;
      case 'STATUS':
        cur.status = value.toUpperCase();
        break;
      case 'DTSTART': {
        cur._allDayStart = params.VALUE === 'DATE' || /^\d{8}$/.test(value);
        const s = icalDateToInstant(value, params);
        if (s !== undefined) cur.start = s;
        break;
      }
      case 'DTEND': {
        const e = icalDateToInstant(value, params);
        if (e !== undefined) cur.end = e;
        break;
      }
      case 'DURATION':
        cur._duration = value;
        break;
      case 'RECURRENCE-ID':
        cur.recurrenceId = value;
        break;
      case 'RRULE':
        cur.rrule = value;
        break;
      case 'EXDATE':
        (cur.exdate ??= []).push(value);
        break;
      case 'ATTENDEE': {
        // Keep the FIRST attendee (the canonical `customer` is a single person);
        // later ATTENDEE lines are preserved in `raw` and left untouched.
        if (cur.attendee === undefined) {
          const email = value.replace(/^mailto:/i, '');
          const name2 = params.CN;
          cur.attendee = { ...(email ? { email } : {}), ...(name2 ? { name: name2 } : {}) };
        }
        break;
      }
      default:
        break;
    }
  }
  return events;
}

/** Apply an RFC5545 DURATION (e.g. `PT45M`, `PT1H`, `P1D`, `P1W`) to an instant.
 *  The week form (`dur-week`, e.g. `P1W`) is a standalone RFC5545 alternative —
 *  omitting it made a valid week-long DURATION unparseable and collapse to a
 *  zero-length range. */
function applyDuration(start: string, dur: string): string | undefined {
  const m = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(dur);
  if (!m) return undefined;
  const sign = m[1] === '-' ? -1 : 1;
  const mins =
    (Number(m[2] ?? 0) * 10_080 + // weeks → minutes (7 * 1440)
      Number(m[3] ?? 0) * 1440 +
      Number(m[4] ?? 0) * 60 +
      Number(m[5] ?? 0) +
      Number(m[6] ?? 0) / 60) *
    sign;
  const epoch = Date.parse(start) + mins * 60_000;
  return formatWithOffset(epoch, 0);
}

// ---------------------------------------------------------------------------
// Client-side recurrence expansion (RFC 5545 §3.8.5.3 RRULE / §3.8.5.1 EXDATE)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Guards a runaway RRULE (e.g. unbounded DAILY over a decade-wide window) from
 *  hanging: never generate more than this many candidate occurrences. Hitting it
 *  stops generation — a partial result is acceptable for this fallback. */
const RECURRENCE_HARD_CAP = 1000;

/** iCalendar two-letter weekday → JS UTC day-of-week (Sun=0 … Sat=6). */
const WEEKDAY_TO_DOW: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/** RRULE parts this fallback models. Any other part (BYSETPOS, BYMONTHDAY,
 *  BYMONTH, BYWEEKNO, BYYEARDAY, BYHOUR, …) forces the safe fallback. */
const SUPPORTED_RRULE_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST']);

function daysInMonthUTC(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Add `months` calendar months to a UTC instant, keeping the day-of-month and
 *  time-of-day. Returns undefined when the target month has no such day (e.g.
 *  the 31st of a 30-day month, or Feb 29 in a common year) — RFC 5545 says such
 *  invalid recurrence instances are ignored rather than rolled over. */
function addMonthsUTC(baseMs: number, months: number): number | undefined {
  const d = new Date(baseMs);
  const total = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const day = d.getUTCDate();
  if (day > daysInMonthUTC(year, month)) return undefined;
  return Date.UTC(
    year,
    month,
    day,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** All EXDATE instants (in epoch-ms) an occurrence start may match. TZID-anchored
 *  EXDATEs are read as UTC/floating here — the same DST/local limitation the rest
 *  of the fallback carries; UTC-anchored series (the common no-expand case) match
 *  exactly. */
function exdateInstants(exdate: string[] | undefined): Set<number> {
  const out = new Set<number>();
  if (!exdate) return out;
  for (const line of exdate) {
    for (const token of line.split(',')) {
      const inst = icalDateToInstant(token.trim(), {});
      if (inst === undefined) continue;
      const ms = Date.parse(inst);
      if (!Number.isNaN(ms)) out.add(ms);
    }
  }
  return out;
}

/** Shallow-clone the master as a concrete occurrence: DTSTART/DTEND set to this
 *  instant (duration preserved), RRULE dropped, and a synthetic RECURRENCE-ID at
 *  the occurrence start so expanded siblings sharing a booking id can be told
 *  apart. `raw` stays the master's raw — there is no per-occurrence server raw. */
function toOccurrence(master: VEvent, startMs: number, durationMs: number): VEvent {
  const start = formatWithOffset(startMs, 0);
  const occ: VEvent = { ...master, start, end: formatWithOffset(startMs + durationMs, 0), recurrenceId: start };
  delete occ.rrule;
  return occ;
}

/**
 * Expand a recurring VEVENT into its concrete in-window occurrences — a bounded,
 * correct SUBSET of RFC 5545 recurrence, used ONLY as a client-side fallback when
 * a CalDAV server ignores `<C:expand>` and returns the unexpanded master (its
 * original DTSTART plus an RRULE). iCloud expands server-side; Fastmail and
 * Nextcloud/Baïkal may not.
 *
 * GOVERNING PRINCIPLE — never make output worse. When the RRULE uses any feature
 * this does not model, the event is returned UNCHANGED (`[event]`, today's
 * behavior) rather than emitting occurrences at the wrong times.
 *
 * SUPPORTED: FREQ ∈ DAILY|WEEKLY|MONTHLY|YEARLY; INTERVAL (default 1); COUNT;
 * UNTIL; WKST; and BYDAY as a plain weekday list (MO,TU,…,SU) for WEEKLY only.
 * FALLS BACK on any other part — BYSETPOS, BYMONTHDAY, BYMONTH, BYWEEKNO,
 * BYYEARDAY, BYHOUR/BYMINUTE/BYSECOND, numeric-prefixed BYDAY (e.g. 2MO), BYDAY
 * on a non-WEEKLY frequency, an unrecognized/invalid part, or an unusable value.
 *
 * Weekday and interval math run against the UTC day-of-week; local-weekday and
 * DST subtleties are NOT modeled (acceptable — the server-side expand is primary).
 */
export function expandRecurrence(event: VEvent, windowStart: string, windowEnd: string): VEvent[] {
  // Not a series master we can expand: no RRULE, an already-concrete override, or
  // missing endpoints. Pass through unchanged (today's behavior).
  if (
    event.rrule === undefined ||
    event.recurrenceId !== undefined ||
    event.start === undefined ||
    event.end === undefined
  ) {
    return [event];
  }

  const startMs = Date.parse(event.start);
  const endMs = Date.parse(event.end);
  const winStartMs = Date.parse(windowStart);
  const winEndMs = Date.parse(windowEnd);
  if ([startMs, endMs, winStartMs, winEndMs].some((n) => Number.isNaN(n))) return [event];
  const durationMs = endMs - startMs;

  // Parse the RRULE into parts; bail on any part outside the supported subset.
  const parts: Record<string, string> = {};
  for (const seg of event.rrule.split(';')) {
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    parts[seg.slice(0, eq).trim().toUpperCase()] = seg.slice(eq + 1).trim();
  }
  for (const key of Object.keys(parts)) {
    if (!SUPPORTED_RRULE_PARTS.has(key)) return [event];
  }

  const freq = parts.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    return [event];
  }

  const interval = parts.INTERVAL === undefined ? 1 : Number(parts.INTERVAL);
  if (!Number.isInteger(interval) || interval < 1) return [event];

  let count: number | undefined;
  if (parts.COUNT !== undefined) {
    count = Number(parts.COUNT);
    if (!Number.isInteger(count) || count < 1) return [event];
  }

  let untilMs: number | undefined;
  if (parts.UNTIL !== undefined) {
    const untilInstant = icalDateToInstant(parts.UNTIL, {});
    const ms = untilInstant === undefined ? NaN : Date.parse(untilInstant);
    if (Number.isNaN(ms)) return [event];
    untilMs = ms;
  }

  // WKST is only meaningful for WEEKLY+BYDAY with INTERVAL>1, but validate it
  // whenever present so a bad value falls back rather than silently misbehaving.
  const wkstDow = parts.WKST === undefined ? 1 : WEEKDAY_TO_DOW[parts.WKST.toUpperCase()];
  if (wkstDow === undefined) return [event];

  // BYDAY: supported only as a plain weekday list on a WEEKLY rule.
  let byday: number[] | undefined;
  if (parts.BYDAY !== undefined) {
    if (freq !== 'WEEKLY') return [event];
    const dows: number[] = [];
    for (const tok of parts.BYDAY.split(',')) {
      const dow = WEEKDAY_TO_DOW[tok.trim().toUpperCase()];
      if (dow === undefined) return [event]; // numeric-prefixed (2MO) or garbage
      dows.push(dow);
    }
    byday = dows;
  }

  // Candidate starts are generated in non-decreasing order and bounded by COUNT,
  // UNTIL, the window's far edge, and the hard cap — so the loops always halt.
  const candidates: number[] = [];
  let occCount = 0;

  if (byday !== undefined) {
    // WEEKLY + BYDAY: walk active weeks (every `interval`-th week from the week
    // containing DTSTART, per WKST), emitting the requested weekdays in order.
    const weekPos = (dow: number): number => (dow - wkstDow + 7) % 7;
    const sortedDays = [...new Set(byday)].sort((a, b) => weekPos(a) - weekPos(b));
    const startDayIndex = Math.floor(startMs / DAY_MS);
    const timeOfDayMs = startMs - startDayIndex * DAY_MS;
    const startDow = new Date(startDayIndex * DAY_MS).getUTCDay();
    const weekStartDayIndex = startDayIndex - weekPos(startDow);

    outer: for (let week = 0; week <= RECURRENCE_HARD_CAP; week++) {
      const weekBase = weekStartDayIndex + week * interval * 7;
      for (const dow of sortedDays) {
        const s = (weekBase + weekPos(dow)) * DAY_MS + timeOfDayMs;
        if (s < startMs) continue; // first week: days before DTSTART don't count
        if (untilMs !== undefined && s > untilMs) break outer;
        if (s >= winEndMs) break outer; // monotonic: nothing later can overlap
        candidates.push(s);
        occCount++;
        if (count !== undefined && occCount >= count) break outer;
        if (candidates.length >= RECURRENCE_HARD_CAP) break outer;
      }
    }
  } else {
    // One occurrence per step: DAILY / WEEKLY (DTSTART's weekday) / MONTHLY /
    // YEARLY. MONTHLY/YEARLY skip invalid calendar dates (e.g. Feb 31 / Feb 29).
    for (let n = 0; candidates.length < RECURRENCE_HARD_CAP && n <= RECURRENCE_HARD_CAP * 2; n++) {
      let s: number | undefined;
      if (freq === 'DAILY') s = startMs + n * interval * DAY_MS;
      else if (freq === 'WEEKLY') s = startMs + n * interval * 7 * DAY_MS;
      else if (freq === 'MONTHLY') s = addMonthsUTC(startMs, n * interval);
      else s = addMonthsUTC(startMs, n * interval * 12); // YEARLY
      if (s === undefined) continue; // invalid calendar date — ignored per RFC
      if (untilMs !== undefined && s > untilMs) break;
      if (s >= winEndMs) break; // monotonic: nothing later can overlap
      candidates.push(s);
      occCount++;
      if (count !== undefined && occCount >= count) break;
    }
  }

  // Apply EXDATE, then keep only occurrences overlapping [windowStart, windowEnd).
  const excluded = exdateInstants(event.exdate);
  const occs = candidates.filter(
    (s) => !excluded.has(s) && s + durationMs > winStartMs && s < winEndMs,
  );
  return occs.map((s) => toOccurrence(event, s, durationMs));
}

/** Canonical instant → iCal UTC basic form (`20260720T220000Z`). */
export function instantToICalUTC(instant: string): string {
  const utc = formatWithOffset(Date.parse(instant), 0); // 2026-07-20T22:00:00Z
  return utc.replace(/[-:]/g, '');
}

/** Drop characters that would break out of a content line (CR/LF and other C0
 *  controls). UID and CAL-ADDRESS are opaque tokens rather than TEXT values, so
 *  they are sanitized rather than backslash-escaped — escaping them would not
 *  round-trip, and a raw newline would let a caller-supplied id inject
 *  arbitrary iCalendar properties. */
function sanitizeValue(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && cp !== 0x7f) out += ch;
  }
  return out;
}

export interface BuildVEventInput {
  uid: string;
  start: string;
  end: string;
  stamp: string;
  summary?: string;
  attendeeEmail?: string;
  attendeeName?: string;
}

/** Serialize a single-VEVENT VCALENDAR document. */
export function buildICS(e: BuildVEventInput): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//unibooking//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${sanitizeValue(e.uid)}`,
    `DTSTAMP:${instantToICalUTC(e.stamp)}`,
    `DTSTART:${instantToICalUTC(e.start)}`,
    `DTEND:${instantToICalUTC(e.end)}`,
    ...(e.summary ? [`SUMMARY:${escapeText(e.summary)}`] : []),
    ...(e.attendeeEmail
      ? [
          `ATTENDEE${e.attendeeName ? `;CN=${quoteParam(e.attendeeName)}` : ''}` +
            `:mailto:${sanitizeValue(e.attendeeEmail)}`,
        ]
      : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export interface PatchVEventInput {
  stamp: string;
  /** Canonical instant; replaces DTSTART (as a UTC value). */
  start?: string;
  /** Canonical instant; replaces DTEND (as a UTC value). */
  end?: string;
  summary?: string;
  /** iCal STATUS value (e.g. `CONFIRMED`). */
  status?: string;
}

/** Property name of a content line (`DTSTART;TZID=...:...` → `DTSTART`). */
function propertyName(line: string): string {
  const colon = line.indexOf(':');
  const semi = line.indexOf(';');
  let cut = colon;
  if (semi !== -1 && (colon === -1 || semi < colon)) cut = semi;
  return (cut === -1 ? line : line.slice(0, cut)).toUpperCase();
}

/** Ordinal of the VEVENT that represents the series master: the first one with
 *  no RECURRENCE-ID. RFC5545 does not require the master to precede its
 *  overrides, so "the first VEVENT" can be an overridden occurrence — editing
 *  that would silently change one instance instead of the series. */
function masterEventOrdinal(lines: string[]): number {
  const overridden: boolean[] = [];
  const stack: string[] = [];
  let ordinal = -1;
  for (const line of lines) {
    const begin = /^BEGIN:(.+)$/i.exec(line);
    if (begin) {
      const comp = begin[1]!.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT') overridden[++ordinal] = false;
      continue;
    }
    if (/^END:/i.test(line)) {
      stack.pop();
      continue;
    }
    if (ordinal >= 0 && stack[stack.length - 1] === 'VEVENT' && propertyName(line) === 'RECURRENCE-ID') {
      overridden[ordinal] = true;
    }
  }
  const master = overridden.indexOf(false);
  return master === -1 ? 0 : master;
}

/**
 * Patch a fetched VCALENDAR in place, replacing only the given properties on the
 * series master VEVENT and preserving everything else (VTIMEZONE, RRULE, LOCATION,
 * DESCRIPTION, extra ATTENDEEs, VALARMs, X- props). This is what `updateBooking`
 * uses instead of rebuilding from the lean model, so a round-trip can't silently
 * drop event data. DTSTAMP is always refreshed; a property that is set but absent
 * is inserted before END:VEVENT.
 */
export function patchICS(raw: string, changes: PatchVEventInput): string {
  const unfolded = raw.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r\n|\n|\r/);
  const replacements: Record<string, string | undefined> = {
    DTSTAMP: `DTSTAMP:${instantToICalUTC(changes.stamp)}`,
    ...(changes.start !== undefined ? { DTSTART: `DTSTART:${instantToICalUTC(changes.start)}` } : {}),
    ...(changes.end !== undefined ? { DTEND: `DTEND:${instantToICalUTC(changes.end)}` } : {}),
    ...(changes.summary !== undefined ? { SUMMARY: `SUMMARY:${escapeText(changes.summary)}` } : {}),
    ...(changes.status !== undefined ? { STATUS: `STATUS:${changes.status}` } : {}),
  };

  /** Rewrite DTSTART/DTEND while keeping the property's original TZID anchoring.
   *  Flattening a `DTSTART;TZID=…` to a UTC instant turns a recurring
   *  wall-clock series into a fixed-offset one, which then drifts by an hour at
   *  every DST transition (and orphans the VTIMEZONE). */
  function retimed(existing: string, name: 'DTSTART' | 'DTEND', instant: string): string {
    // The TZID param may be DQUOTEd (`TZID="America/New_York"`, legal per
    // RFC5545 §3.2); keeping the quotes would fail zone resolution and silently
    // flatten the property to UTC.
    const tzid = stripQuotes(/^[^:]*;(?:[^:]*;)*TZID=("[^"]*"|[^;:]+)/i.exec(existing)?.[1] ?? '');
    if (tzid) {
      const local = instantToICalLocal(instant, tzid);
      if (local !== undefined) return `${name};TZID=${quoteParam(tzid)}:${local}`;
    }
    return `${name}:${instantToICalUTC(instant)}`;
  }
  const out: string[] = [];
  const stack: string[] = [];
  const target = masterEventOrdinal(lines); // only the master VEVENT is patched
  let ordinal = -1;
  let inTargetEvent = false;
  const seen = new Set<string>();

  for (const line of lines) {
    const begin = /^BEGIN:(.+)$/i.exec(line);
    if (begin) {
      const comp = begin[1]!.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT' && ++ordinal === target) inTargetEvent = true;
      out.push(line);
      continue;
    }
    const end = /^END:(.+)$/i.exec(line);
    if (end) {
      const comp = end[1]!.trim().toUpperCase();
      if (comp === 'VEVENT' && inTargetEvent) {
        for (const key of ['DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'STATUS']) {
          if (replacements[key] !== undefined && !seen.has(key)) out.push(replacements[key]!);
        }
        inTargetEvent = false;
      }
      stack.pop();
      out.push(line);
      continue;
    }
    // Only rewrite top-level VEVENT properties — never lines inside a nested
    // VALARM, or a VTIMEZONE's STANDARD/DAYLIGHT (which also carry DTSTART).
    if (inTargetEvent && stack[stack.length - 1] === 'VEVENT') {
      const name = propertyName(line);
      // RFC5545 §3.6.1 forbids DTEND and DURATION in one VEVENT. When a
      // reschedule writes a DTEND, an existing DURATION must go — otherwise the
      // object carries two conflicting ends and a server may reject it or pick
      // the stale one.
      if (name === 'DURATION' && changes.end !== undefined) continue;
      const replacement = replacements[name];
      if (replacement !== undefined) {
        if (name === 'DTSTART' && changes.start !== undefined) {
          out.push(retimed(line, 'DTSTART', changes.start));
        } else if (name === 'DTEND' && changes.end !== undefined) {
          out.push(retimed(line, 'DTEND', changes.end));
        } else {
          out.push(replacement);
        }
        seen.add(name);
        continue;
      }
    }
    out.push(line);
  }
  return out.map(foldLine).join('\r\n') + '\r\n';
}

/** A CalDAV multistatus entry: the resource href plus its iCalendar payload. */
export interface CalendarEntry {
  href?: string;
  ics: string;
}

/** Parse `<response>` blocks from a CalDAV multistatus, pairing each resource
 *  href with its calendar-data. The href is what `getBooking`/`updateBooking`/
 *  `cancelBooking` need to address a resource whose name isn't its UID. */
export function parseCalendarEntries(multistatusXml: string): CalendarEntry[] {
  const respRe = /<[a-z0-9]*:?response[\s>][\s\S]*?<\/[a-z0-9]*:?response>/gi;
  const hrefRe = /<[a-z0-9]*:?href[^>]*>([\s\S]*?)<\/[a-z0-9]*:?href>/i;
  const dataRe = /<[a-z0-9]*:?calendar-data[^>]*>([\s\S]*?)<\/[a-z0-9]*:?calendar-data>/i;
  const out: CalendarEntry[] = [];
  const blocks = multistatusXml.match(respRe);
  if (!blocks) {
    // No <response> wrappers (or a non-standard body): fall back to bare
    // calendar-data extraction so listBookings still works.
    return extractCalendarData(multistatusXml).map((ics) => ({ ics }));
  }
  for (const block of blocks) {
    const data = dataRe.exec(block);
    if (!data?.[1]) continue;
    const href = hrefRe.exec(block)?.[1];
    out.push({
      ics: unescapeXml(data[1]).trim(),
      ...(href ? { href: unescapeXml(href).trim() } : {}),
    });
  }
  return out;
}

const UTF8 = new TextEncoder();
function utf8Len(s: string): number {
  return UTF8.encode(s).length;
}

/** RFC5545 folding: split lines longer than 75 octets, never splitting a
 *  character. Continuation lines start with a space (which counts toward the
 *  75-octet budget). Unfolding just strips CRLF + the leading space. */
function foldLine(line: string): string {
  if (utf8Len(line) <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let first = true;
  for (const ch of line) {
    // iterate by code point so surrogate pairs / multibyte chars stay intact
    const chBytes = utf8Len(ch);
    const budget = first ? 75 : 74; // continuation reserves 1 octet for the space
    if (curBytes > 0 && curBytes + chBytes > budget) {
      out.push(first ? cur : ' ' + cur);
      first = false;
      cur = ch;
      curBytes = chBytes;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  if (cur) out.push(first ? cur : ' ' + cur);
  return out.join('\r\n');
}

const XML_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
};

/** Decode XML character data. Numeric character references matter as much as the
 *  named entities: sabre-based servers (Nextcloud, Baïkal, …) routinely escape
 *  the CR in folded calendar-data as `&#13;`, and leaving it encoded made every
 *  ICS line end in a literal `&#13;` — so `BEGIN:VEVENT` never matched and
 *  `listBookings` silently returned nothing. Single pass, so an escaped `&amp;`
 *  can't be re-expanded into the entity it encodes. */
function unescapeXml(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = hex ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return match;
      return String.fromCodePoint(cp);
    }
    return XML_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Extract the iCalendar payloads from a CalDAV multistatus response body. */
function extractCalendarData(multistatusXml: string): string[] {
  const re = /<[a-z0-9]*:?calendar-data[^>]*>([\s\S]*?)<\/[a-z0-9]*:?calendar-data>/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(multistatusXml)) !== null) {
    if (m[1]) out.push(unescapeXml(m[1]).trim());
  }
  return out;
}
