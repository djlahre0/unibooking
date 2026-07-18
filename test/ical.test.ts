import { describe, expect, it } from 'vitest';
import { buildICS, parseICS } from '../src/ical';

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
