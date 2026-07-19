import { describe, expect, it } from 'vitest';
import { buildICS, parseICS, patchICS } from '../src/ical';

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
