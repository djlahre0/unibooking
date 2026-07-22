import { describe, expect, it } from 'vitest';
import { buildICS, expandRecurrence, parseCalendarEntries, parseICS, patchICS } from '../src/ical';

function vcal(...lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join(
    '\r\n',
  );
}

describe('ical: TZID resolution', () => {
  it('resolves a Windows/Exchange TZID name to the correct instant without throwing', () => {
    // "Eastern Standard Time" is the Windows zone id for America/New_York, which
    // is EDT (UTC-4) in July, so 15:00 local -> 19:00Z.
    const ics = vcal(
      'UID:w1',
      'DTSTART;TZID=Eastern Standard Time:20260720T150000',
      'DTEND;TZID=Eastern Standard Time:20260720T154500',
    );
    const ev = parseICS(ics)[0]!;
    expect(ev.start).toBe('2026-07-20T19:00:00Z');
    expect(ev.end).toBe('2026-07-20T19:45:00Z');
  });

  it('does not throw on an unresolvable custom TZID (the whole list must survive)', () => {
    const ics = vcal(
      'UID:w2',
      'DTSTART;TZID=Customized Time Zone 1:20260720T150000',
      'DTEND;TZID=Customized Time Zone 1:20260720T160000',
    );
    expect(() => parseICS(ics)).not.toThrow();
    const ev = parseICS(ics)[0]!;
    expect(ev.start).toBeDefined();
    expect(ev.end).toBeDefined();
  });
});

describe('ical: all-day / missing DTEND defaults', () => {
  it('derives a +1 day end for an all-day event with no DTEND', () => {
    const ics = vcal('UID:ad1', 'DTSTART;VALUE=DATE:20260720');
    const ev = parseICS(ics)[0]!;
    expect(ev.start).toBe('2026-07-20T00:00:00Z');
    expect(ev.end).toBe('2026-07-21T00:00:00Z');
  });
});

describe('ical: DURATION forms', () => {
  it('derives DTEND from a timed DURATION (PT45M)', () => {
    const ics = vcal('UID:d1', 'DTSTART:20260720T220000Z', 'DURATION:PT45M');
    const ev = parseICS(ics)[0]!;
    expect(ev.end).toBe('2026-07-20T22:45:00Z');
  });

  it('handles the RFC5545 week form (P1W) instead of emitting a zero-length range', () => {
    const ics = vcal('UID:d2', 'DTSTART:20260720T220000Z', 'DURATION:P1W');
    const ev = parseICS(ics)[0]!;
    // 1 week = 7 days later, not end === start.
    expect(ev.end).toBe('2026-07-27T22:00:00Z');
    expect(ev.end).not.toBe(ev.start);
  });
});

describe('ical: nested components', () => {
  it('ignores VALARM properties instead of letting them overwrite the event', () => {
    // An EMAIL alarm legally carries its own SUMMARY/ATTENDEE/DURATION
    // (RFC5545 3.6.6). Reading them flat made the alarm's subject the booking
    // title, its recipient the customer, and its snooze the event's end.
    const ics = vcal(
      'UID:n1',
      'SUMMARY:Real appointment',
      'DTSTART:20260720T220000Z',
      'BEGIN:VALARM',
      'ACTION:EMAIL',
      'SUMMARY:Reminder alarm subject',
      'ATTENDEE:mailto:alarm-recipient@example.com',
      'DURATION:PT5M',
      'END:VALARM',
      'DTEND:20260720T224500Z',
    );
    const ev = parseICS(ics)[0]!;
    expect(ev.summary).toBe('Real appointment');
    expect(ev.attendee).toBeUndefined();
    expect(ev.end).toBe('2026-07-20T22:45:00Z');
  });

  it('exposes RECURRENCE-ID so expanded instances sharing an id can be told apart', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:series',
      'RECURRENCE-ID:20260720T090000Z',
      'DTSTART:20260720T090000Z',
      'DTEND:20260720T093000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:series',
      'RECURRENCE-ID:20260721T090000Z',
      'DTSTART:20260721T090000Z',
      'DTEND:20260721T093000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseICS(ics);
    expect(events.map((e) => e.recurrenceId)).toEqual(['20260720T090000Z', '20260721T090000Z']);
  });
});

describe('ical: multistatus XML decoding', () => {
  it('decodes numeric character references in calendar-data', () => {
    // sabre-based servers (Nextcloud, Baikal) escape the CR of a folded line as
    // &#13;. Leaving it encoded meant BEGIN:VEVENT never matched and the whole
    // listing came back empty.
    const xml =
      '<multistatus><response><href>/c/e1.ics</href><calendar-data>' +
      'BEGIN:VCALENDAR&#13;\nBEGIN:VEVENT&#13;\nUID:x1&#13;\n' +
      'DTSTART:20260720T220000Z&#13;\nDTEND:20260720T224500Z&#13;\n' +
      'END:VEVENT&#13;\nEND:VCALENDAR' +
      '</calendar-data></response></multistatus>';
    const entries = parseCalendarEntries(xml);
    expect(entries).toHaveLength(1);
    const ev = parseICS(entries[0]!.ics)[0];
    expect(ev?.uid).toBe('x1');
    expect(ev?.start).toBe('2026-07-20T22:00:00Z');
  });

  it('does not re-expand an escaped ampersand into the entity it encodes', () => {
    const xml =
      '<multistatus><response><calendar-data>' +
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x2\nSUMMARY:A &amp;#13; B\n' +
      'DTSTART:20260720T220000Z\nDTEND:20260720T224500Z\nEND:VEVENT\nEND:VCALENDAR' +
      '</calendar-data></response></multistatus>';
    const ev = parseICS(parseCalendarEntries(xml)[0]!.ics)[0]!;
    expect(ev.summary).toBe('A &#13; B');
  });
});

describe('ical: value sanitization', () => {
  // A CRLF in an opaque value (UID, CAL-ADDRESS) would end the content line and
  // start a new property line — letting a caller-supplied id rewrite the event.
  const injected = (ics: string): boolean => ics.split('\r\n').includes('SUMMARY:injected');

  it('does not let a newline in the UID inject an iCalendar property', () => {
    const ics = buildICS({
      uid: 'u1\r\nSUMMARY:injected',
      start: '2026-07-20T22:00:00Z',
      end: '2026-07-20T22:45:00Z',
      stamp: '2026-07-20T00:00:00Z',
      summary: 'Real title',
    });
    expect(injected(ics)).toBe(false);
    expect(parseICS(ics)[0]!.summary).toBe('Real title');
  });

  it('does not let a newline in the attendee email inject a property', () => {
    const ics = buildICS({
      uid: 'u2',
      start: '2026-07-20T22:00:00Z',
      end: '2026-07-20T22:45:00Z',
      stamp: '2026-07-20T00:00:00Z',
      summary: 'Real title',
      attendeeEmail: 'jane@example.com\r\nSUMMARY:injected',
    });
    expect(injected(ics)).toBe(false);
    expect(parseICS(ics)[0]!.summary).toBe('Real title');
  });
});

describe('ical: folding', () => {
  it('folds lines to <= 75 octets even for multibyte content', () => {
    const summary = '你'.repeat(100); // 100 CJK chars = 300 UTF-8 bytes
    const ics = buildICS({
      uid: 'f1',
      start: '2026-07-20T22:00:00Z',
      end: '2026-07-20T22:45:00Z',
      stamp: '2026-07-20T00:00:00Z',
      summary,
    });
    const enc = new TextEncoder();
    for (const line of ics.split('\r\n')) {
      expect(enc.encode(line).length).toBeLessThanOrEqual(75);
    }
    // …and it still round-trips through the parser.
    expect(parseICS(ics)[0]!.summary).toBe(summary);
  });
});

describe('ical: ATTENDEE CN escaping', () => {
  it('quotes a CN with special characters so the property still parses', () => {
    const ics = buildICS({
      uid: 'a1',
      start: '2026-07-20T22:00:00Z',
      end: '2026-07-20T22:45:00Z',
      stamp: '2026-07-20T00:00:00Z',
      attendeeEmail: 'jane@example.com',
      attendeeName: 'Doe, Jane: The "Great"',
    });
    const ev = parseICS(ics)[0]!;
    expect(ev.attendee?.email).toBe('jane@example.com');
    // Embedded DQUOTEs are dropped (not allowed in a quoted param); the colon
    // and comma survive.
    expect(ev.attendee?.name).toBe('Doe, Jane: The Great');
  });
});

// ---------------------------------------------------------------------------
// RFC 5545 section 3.3.11 TEXT escaping - regressions from the July 2026 audit
// ---------------------------------------------------------------------------
describe("ical TEXT escaping round-trip", () => {
  const BACKSLASH = String.fromCharCode(92);
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);

  function build(summary: string): string {
    return buildICS({
      uid: "u1",
      stamp: "2026-07-19T00:00:00Z",
      start: "2026-07-20T09:00:00Z",
      end: "2026-07-20T09:30:00Z",
      summary,
    });
  }

  it("round-trips a literal backslash followed by n", () => {
    // Unescaping the escaped-newline sequence before the escaped-backslash
    // sequence turned a literal backslash+n into a real line feed.
    const summary = "C:" + BACKSLASH + "new";
    const ev = parseICS(build(summary))[0]!;
    expect(ev.summary).toBe(summary);
    expect(ev.summary).not.toContain(LF);
  });

  it("round-trips every escape character RFC 5545 defines", () => {
    const summary = ["a", BACKSLASH, "b;c,d", LF, "e"].join("");
    expect(parseICS(build(summary))[0]!.summary).toBe(summary);
  });

  it("normalizes CRLF instead of emitting a bare CR", () => {
    const summary = "line1" + CR + LF + "line2";
    const ics = build(summary);
    // A raw CR in the value would re-split the content line and corrupt it.
    const line = ics.split(CR + LF).find((l) => l.startsWith("SUMMARY:"))!;
    expect(line).toBe("SUMMARY:line1" + BACKSLASH + "nline2");
    expect(parseICS(ics)[0]!.summary).toBe("line1" + LF + "line2");
  });
});

// ---------------------------------------------------------------------------
// patchICS must preserve TZID anchoring on recurring events
// ---------------------------------------------------------------------------
describe('patchICS TZID preservation', () => {
  const RECURRING = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTIMEZONE',
    'TZID:America/New_York',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:evt-weekly',
    'SUMMARY:Weekly sync',
    'DTSTAMP:20260101T000000Z',
    'DTSTART;TZID=America/New_York:20260720T090000',
    'DTEND;TZID=America/New_York:20260720T093000',
    'RRULE:FREQ=WEEKLY',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join(String.fromCharCode(13) + String.fromCharCode(10));

  it('keeps a recurring series anchored to its zone instead of flattening to UTC', () => {
    // 09:00 America/New_York on 2026-07-27 is 13:00Z (EDT). Rewriting DTSTART as
    // a bare UTC instant would pin the whole RRULE to 13:00Z, so every
    // occurrence after the DST change would land an hour off local 09:00.
    const out = patchICS(RECURRING, {
      stamp: '2026-07-19T00:00:00Z',
      start: '2026-07-27T13:00:00Z',
      end: '2026-07-27T13:30:00Z',
    });

    expect(out).toContain('DTSTART;TZID=America/New_York:20260727T090000');
    expect(out).toContain('DTEND;TZID=America/New_York:20260727T093000');
    expect(out).not.toContain('DTSTART:20260727T130000Z');
    // The RRULE and its VTIMEZONE must survive intact.
    expect(out).toContain('RRULE:FREQ=WEEKLY');
    expect(out).toContain('TZID:America/New_York');
  });

  it('keeps a DQUOTEd TZID anchored instead of flattening it to UTC', () => {
    // RFC5545 3.2 allows a quoted param value. Capturing the quotes with the
    // zone name made the lookup fail, silently dropping the TZID anchoring.
    const quoted = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:evt-quoted',
      'DTSTART;TZID="America/New_York":20260720T090000',
      'DTEND;TZID="America/New_York":20260720T093000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const out = patchICS(quoted, {
      stamp: '2026-07-19T00:00:00Z',
      start: '2026-07-27T13:00:00Z',
      end: '2026-07-27T13:30:00Z',
    });
    expect(out).toContain('DTSTART;TZID=America/New_York:20260727T090000');
    expect(out).not.toContain('DTSTART:20260727T130000Z');
  });

  it('drops DURATION when a reschedule writes a DTEND', () => {
    // RFC5545 3.6.1 forbids both in one VEVENT; leaving the stale DURATION gives
    // the event two conflicting ends.
    const durationEvent = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:evt-duration',
      'DTSTART:20260720T220000Z',
      'DURATION:PT45M',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const out = patchICS(durationEvent, {
      stamp: '2026-07-19T00:00:00Z',
      start: '2026-07-27T22:00:00Z',
      end: '2026-07-27T23:00:00Z',
    });
    expect(out).toContain('DTSTART:20260727T220000Z');
    expect(out).toContain('DTEND:20260727T230000Z');
    expect(out).not.toContain('DURATION');
  });

  it('patches the series master even when an override VEVENT comes first', () => {
    const overrideFirst = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:evt-series',
      'RECURRENCE-ID:20260721T090000Z',
      'DTSTART:20260721T100000Z',
      'DTEND:20260721T103000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:evt-series',
      'DTSTART:20260720T090000Z',
      'DTEND:20260720T093000Z',
      'RRULE:FREQ=DAILY',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const out = patchICS(overrideFirst, {
      stamp: '2026-07-19T00:00:00Z',
      start: '2026-07-20T11:00:00Z',
      end: '2026-07-20T11:30:00Z',
    });
    // The master moved; the override kept its own times.
    expect(out).toContain('DTSTART:20260720T110000Z');
    expect(out).toContain('DTSTART:20260721T100000Z');
    expect(out).not.toContain('DTSTART:20260720T090000Z');
  });

  it('still uses UTC when the original DTSTART was a UTC instant', () => {
    const utcEvent = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:evt-utc',
      'DTSTART:20260720T220000Z',
      'DTEND:20260720T224500Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join(String.fromCharCode(13) + String.fromCharCode(10));
    const out = patchICS(utcEvent, {
      stamp: '2026-07-19T00:00:00Z',
      start: '2026-07-27T22:00:00Z',
      end: '2026-07-27T22:45:00Z',
    });
    expect(out).toContain('DTSTART:20260727T220000Z');
    expect(out).not.toContain('TZID');
  });
});

// ---------------------------------------------------------------------------
// Client-side recurrence expansion (RRULE / EXDATE) — the CalDAV fallback for
// servers that ignore <C:expand>. Governing rule: an unsupported RRULE part
// must return the event UNCHANGED rather than emit wrong occurrences.
// ---------------------------------------------------------------------------
describe('ical: recurrence expansion', () => {
  const series = (...rrule: string[]): ReturnType<typeof parseICS>[number] =>
    parseICS(
      vcal('UID:rec', 'DTSTART:20260706T090000Z', 'DTEND:20260706T093000Z', ...rrule),
    )[0]!;

  it('parses RRULE and every EXDATE line onto the VEvent', () => {
    const ev = series(
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
      'EXDATE:20260708T090000Z',
      'EXDATE:20260713T090000Z,20260715T090000Z',
    );
    expect(ev.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    // Each EXDATE line's raw value is kept, comma-lists intact.
    expect(ev.exdate).toEqual(['20260708T090000Z', '20260713T090000Z,20260715T090000Z']);
  });

  it('expands a DAILY rule to one occurrence per day within the window', () => {
    const occ = expandRecurrence(series('RRULE:FREQ=DAILY'), '2026-07-06T00:00:00Z', '2026-07-09T00:00:00Z');
    expect(occ.map((e) => e.start)).toEqual([
      '2026-07-06T09:00:00Z',
      '2026-07-07T09:00:00Z',
      '2026-07-08T09:00:00Z',
    ]);
    // Duration is preserved, RRULE dropped, and a synthetic RECURRENCE-ID set to
    // the occurrence start so siblings sharing a booking id can be told apart.
    expect(occ[0]!.end).toBe('2026-07-06T09:30:00Z');
    expect(occ[0]!.rrule).toBeUndefined();
    expect(occ[0]!.recurrenceId).toBe('2026-07-06T09:00:00Z');
    // raw stays the master's raw (there is no per-occurrence server payload).
    expect(occ[0]!.raw).toContain('RRULE:FREQ=DAILY');
  });

  it('skips alternate weeks for WEEKLY;INTERVAL=2', () => {
    const occ = expandRecurrence(
      series('RRULE:FREQ=WEEKLY;INTERVAL=2'),
      '2026-07-06T00:00:00Z',
      '2026-08-04T00:00:00Z',
    );
    expect(occ.map((e) => e.start)).toEqual([
      '2026-07-06T09:00:00Z',
      '2026-07-20T09:00:00Z',
      '2026-08-03T09:00:00Z',
    ]);
  });

  it('limits the series to COUNT occurrences', () => {
    const occ = expandRecurrence(
      series('RRULE:FREQ=DAILY;COUNT=3'),
      '2026-07-01T00:00:00Z',
      '2026-08-01T00:00:00Z',
    );
    expect(occ.map((e) => e.start)).toEqual([
      '2026-07-06T09:00:00Z',
      '2026-07-07T09:00:00Z',
      '2026-07-08T09:00:00Z',
    ]);
  });

  it('stops the series at UNTIL (inclusive)', () => {
    const occ = expandRecurrence(
      series('RRULE:FREQ=DAILY;UNTIL=20260708T090000Z'),
      '2026-07-01T00:00:00Z',
      '2026-08-01T00:00:00Z',
    );
    expect(occ.map((e) => e.start)).toEqual([
      '2026-07-06T09:00:00Z',
      '2026-07-07T09:00:00Z',
      '2026-07-08T09:00:00Z',
    ]);
  });

  it('removes an EXDATE-listed occurrence (COUNT counts before the exclusion)', () => {
    const occ = expandRecurrence(
      series('RRULE:FREQ=DAILY;COUNT=4', 'EXDATE:20260707T090000Z'),
      '2026-07-01T00:00:00Z',
      '2026-08-01T00:00:00Z',
    );
    expect(occ.map((e) => e.start)).toEqual([
      '2026-07-06T09:00:00Z',
      '2026-07-08T09:00:00Z',
      '2026-07-09T09:00:00Z',
    ]);
  });

  it('yields only the listed weekdays for WEEKLY;BYDAY=MO,WE,FR', () => {
    // 2026-07-06 is a Monday.
    const occ = expandRecurrence(
      series('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'),
      '2026-07-06T00:00:00Z',
      '2026-07-13T00:00:00Z',
    );
    expect(occ.map((e) => e.start)).toEqual([
      '2026-07-06T09:00:00Z', // Mon
      '2026-07-08T09:00:00Z', // Wed
      '2026-07-10T09:00:00Z', // Fri
    ]);
  });

  it('returns the event UNCHANGED for an unsupported RRULE part (BYSETPOS)', () => {
    const ev = series('RRULE:FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO');
    const occ = expandRecurrence(ev, '2026-07-01T00:00:00Z', '2026-12-01T00:00:00Z');
    expect(occ).toHaveLength(1);
    expect(occ[0]).toBe(ev); // same reference: no expansion attempted
    expect(occ[0]!.rrule).toBe('FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO');
  });

  it('caps an unbounded DAILY rule at 1000 candidates over a huge window', () => {
    const ev = parseICS(
      vcal('UID:cap', 'DTSTART:20260101T090000Z', 'DTEND:20260101T093000Z', 'RRULE:FREQ=DAILY'),
    )[0]!;
    // ~30 years unbounded → thousands of occurrences without the hard cap.
    const occ = expandRecurrence(ev, '2026-01-01T00:00:00Z', '2056-01-01T00:00:00Z');
    expect(occ).toHaveLength(1000);
  });
});
