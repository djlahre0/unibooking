import { formatWithOffset } from './time';
import { localToInstant } from './tz';

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

function unescapeText(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** Parse every VEVENT in an iCalendar document. */
export function parseICS(text: string): VEvent[] {
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r\n|\n|\r/);
  const events: VEvent[] = [];
  let cur:
    | (Partial<VEvent> & { _duration?: string; _allDayStart?: boolean; _rawLines: string[] })
    | null = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = { _rawLines: [line] };
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
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    cur._rawLines.push(line);

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

/** Apply an RFC5545 DURATION (e.g. `PT45M`, `PT1H`, `P1D`) to an instant. */
function applyDuration(start: string, dur: string): string | undefined {
  const m = /^([+-]?)P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(dur);
  if (!m) return undefined;
  const sign = m[1] === '-' ? -1 : 1;
  const mins =
    (Number(m[2] ?? 0) * 1440 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0) + Number(m[5] ?? 0) / 60) *
    sign;
  const epoch = Date.parse(start) + mins * 60_000;
  return formatWithOffset(epoch, 0);
}

/** Canonical instant → iCal UTC basic form (`20260720T220000Z`). */
export function instantToICalUTC(instant: string): string {
  const utc = formatWithOffset(Date.parse(instant), 0); // 2026-07-20T22:00:00Z
  return utc.replace(/[-:]/g, '').replace(/\.\d+/, '');
}

export interface BuildVEventInput {
  uid: string;
  start: string;
  end: string;
  stamp: string;
  summary?: string;
  status?: string;
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
    `UID:${e.uid}`,
    `DTSTAMP:${instantToICalUTC(e.stamp)}`,
    `DTSTART:${instantToICalUTC(e.start)}`,
    `DTEND:${instantToICalUTC(e.end)}`,
    ...(e.summary ? [`SUMMARY:${escapeText(e.summary)}`] : []),
    ...(e.status ? [`STATUS:${e.status}`] : []),
    ...(e.attendeeEmail
      ? [`ATTENDEE${e.attendeeName ? `;CN=${quoteParam(e.attendeeName)}` : ''}:mailto:${e.attendeeEmail}`]
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

/**
 * Patch a fetched VCALENDAR in place, replacing only the given properties on the
 * first VEVENT and preserving everything else (VTIMEZONE, RRULE, LOCATION,
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
  const out: string[] = [];
  const stack: string[] = [];
  let patchedEvent = false; // only the first VEVENT is patched
  let inTargetEvent = false;
  const seen = new Set<string>();

  for (const line of lines) {
    const begin = /^BEGIN:(.+)$/i.exec(line);
    if (begin) {
      const comp = begin[1]!.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT' && !patchedEvent) inTargetEvent = true;
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
        patchedEvent = true;
      }
      stack.pop();
      out.push(line);
      continue;
    }
    // Only rewrite top-level VEVENT properties — never lines inside a nested
    // VALARM, or a VTIMEZONE's STANDARD/DAYLIGHT (which also carry DTSTART).
    if (inTargetEvent && stack[stack.length - 1] === 'VEVENT') {
      const name = propertyName(line);
      const replacement = replacements[name];
      if (replacement !== undefined) {
        out.push(replacement);
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

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Extract the iCalendar payloads from a CalDAV multistatus response body. */
export function extractCalendarData(multistatusXml: string): string[] {
  const re = /<[a-z0-9]*:?calendar-data[^>]*>([\s\S]*?)<\/[a-z0-9]*:?calendar-data>/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(multistatusXml)) !== null) {
    if (m[1]) out.push(unescapeXml(m[1]).trim());
  }
  return out;
}
