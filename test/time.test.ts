import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  allDayDates,
  assertAllDayInput,
  assertValidRange,
  durationMinutes,
  endFromDuration,
  formatWithOffset,
  isInstant,
  instantToZoned,
  parseOffsetMinutes,
  wallClockIn,
  zonedToInstant,
} from '../src/time';
import { isUnibookingError } from '../src/errors';

describe('time', () => {
  it('addMinutes preserves a negative offset', () => {
    expect(addMinutes('2026-07-20T15:00:00-07:00', 45)).toBe('2026-07-20T15:45:00-07:00');
  });

  it('addMinutes preserves Z', () => {
    expect(addMinutes('2026-07-20T22:00:00Z', 30)).toBe('2026-07-20T22:30:00Z');
  });

  it('addMinutes rolls the hour within the same offset', () => {
    expect(addMinutes('2026-07-20T15:45:00-07:00', 30)).toBe('2026-07-20T16:15:00-07:00');
  });

  it('addMinutes uses fixed-offset math (not zone/DST aware) by design', () => {
    // Across the US spring-forward, a fixed -08:00 offset stays -08:00 — the
    // result is the correct absolute instant, not a zone-shifted wall clock.
    expect(addMinutes('2026-03-08T01:30:00-08:00', 60)).toBe('2026-03-08T02:30:00-08:00');
  });

  it('endFromDuration + durationMinutes round-trip', () => {
    const start = '2026-07-20T09:00:00+02:00';
    const end = endFromDuration(start, 90);
    expect(end).toBe('2026-07-20T10:30:00+02:00');
    expect(durationMinutes(start, end)).toBe(90);
  });

  it('parseOffsetMinutes', () => {
    expect(parseOffsetMinutes('2026-07-20T15:00:00Z')).toBe(0);
    expect(parseOffsetMinutes('2026-07-20T15:00:00-07:00')).toBe(-420);
    expect(parseOffsetMinutes('2026-07-20T15:00:00+05:30')).toBe(330);
    expect(parseOffsetMinutes('2026-07-20T15:00:00')).toBeNull();
  });

  it('formatWithOffset', () => {
    const epoch = Date.parse('2026-07-20T22:00:00Z');
    expect(formatWithOffset(epoch, 0)).toBe('2026-07-20T22:00:00Z');
    expect(formatWithOffset(epoch, -420)).toBe('2026-07-20T15:00:00-07:00');
    expect(formatWithOffset(epoch, 330)).toBe('2026-07-21T03:30:00+05:30');
  });

  it('isInstant requires an explicit offset', () => {
    expect(isInstant('2026-07-20T15:00:00-07:00')).toBe(true);
    expect(isInstant('2026-07-20T15:00:00Z')).toBe(true);
    expect(isInstant('2026-07-20T15:00:00')).toBe(false);
    expect(isInstant('not a date')).toBe(false);
  });

  it('assertValidRange rejects end <= start and bad timestamps', () => {
    expect(() =>
      assertValidRange({ start: '2026-07-20T15:00:00Z', end: '2026-07-20T14:00:00Z' }, 'google'),
    ).toThrowError();
    const err = (() => {
      try {
        assertValidRange({ start: 'nope', end: '2026-07-20T15:00:00Z' }, 'google');
      } catch (e) {
        return e;
      }
    })();
    expect(isUnibookingError(err) && err.code).toBe('INVALID_INPUT');
  });

  it('assertValidRange accepts a valid range', () => {
    expect(() =>
      assertValidRange({ start: '2026-07-20T15:00:00Z', end: '2026-07-20T16:00:00Z' }, 'google'),
    ).not.toThrow();
  });

  it('assertValidRange rejects offset-less timestamps (ambiguous instants)', () => {
    // The canonical contract requires RFC3339 WITH an offset. An offset-less
    // string parses fine but is interpreted host-locally downstream, so the
    // guard must reject it client-side rather than forward the ambiguity.
    for (const bad of [
      { start: '2026-07-20T15:00:00', end: '2026-07-20T16:00:00Z' },
      { start: '2026-07-20T15:00:00Z', end: '2026-07-20T16:00:00' },
    ]) {
      const err = (() => {
        try {
          assertValidRange(bad, 'google');
        } catch (e) {
          return e;
        }
      })();
      expect(isUnibookingError(err) && err.code).toBe('INVALID_INPUT');
    }
  });
});

describe('zonedToInstant', () => {
  it('writes the instant in the zone offset in force at that moment', () => {
    expect(zonedToInstant('2026-09-21T10:00', 'Asia/Kolkata')).toBe('2026-09-21T10:00:00+05:30');
    expect(zonedToInstant('2026-01-15T09:30:15', 'America/New_York')).toBe(
      '2026-01-15T09:30:15-05:00',
    );
    expect(zonedToInstant('2026-07-15T09:30', 'America/New_York')).toBe(
      '2026-07-15T09:30:00-04:00',
    );
    expect(zonedToInstant('2026-07-15T09:30', 'UTC')).toBe('2026-07-15T09:30:00Z');
  });

  it('resolves a wall-clock time inside a DST gap forward', () => {
    // 02:30 does not exist on 2026-03-08 in New York: clocks jump 02:00 -> 03:00.
    expect(zonedToInstant('2026-03-08T02:30', 'America/New_York')).toBe(
      '2026-03-08T03:30:00-04:00',
    );
  });

  it('resolves an ambiguous time in a DST overlap to the earlier instant', () => {
    // 01:30 happens twice on 2026-11-01 in New York; the first is still EDT.
    expect(zonedToInstant('2026-11-01T01:30', 'America/New_York')).toBe(
      '2026-11-01T01:30:00-04:00',
    );
  });

  it('accepts Windows zone ids', () => {
    expect(zonedToInstant('2026-01-15T09:00', 'Eastern Standard Time')).toBe(
      '2026-01-15T09:00:00-05:00',
    );
  });

  it('throws RangeError for an unknown zone or malformed/impossible input', () => {
    expect(() => zonedToInstant('2026-09-21T10:00', 'Mars/Olympus')).toThrow(RangeError);
    expect(() => zonedToInstant('2026-09-21 10:00', 'UTC')).toThrow(RangeError);
    expect(() => zonedToInstant('2026-02-30T10:00', 'UTC')).toThrow(RangeError);
    expect(() => zonedToInstant('2026-09-21T24:00', 'UTC')).toThrow(RangeError);
  });
});

describe('instantToZoned / wallClockIn', () => {
  it('renders the wall-clock date and time in a zone', () => {
    expect(instantToZoned('2026-09-21T04:30:00Z', 'Asia/Kolkata')).toEqual({
      date: '2026-09-21',
      time: '10:00',
    });
    expect(instantToZoned('2026-09-21T02:00:00Z', 'America/Los_Angeles')).toEqual({
      date: '2026-09-20',
      time: '19:00',
    });
    expect(wallClockIn('2026-09-21T04:30:15Z', 'Asia/Kolkata')).toBe('2026-09-21T10:00:15');
  });

  it('throws RangeError for a bad instant or zone; wallClockIn returns undefined', () => {
    expect(() => instantToZoned('nope', 'UTC')).toThrow(RangeError);
    expect(() => instantToZoned('2026-09-21T04:30:00Z', 'Nope/Zone')).toThrow(RangeError);
    expect(wallClockIn('2026-09-21T04:30:00Z', 'Nope/Zone')).toBeUndefined();
  });

  it('round-trips with zonedToInstant', () => {
    const instant = zonedToInstant('2026-12-31T23:45', 'Pacific/Auckland');
    expect(instantToZoned(instant, 'Pacific/Auckland')).toEqual({
      date: '2026-12-31',
      time: '23:45',
    });
  });
});

describe('allDayDates / assertAllDayInput', () => {
  it('takes the dates as written in the caller offset, end exclusive', () => {
    expect(
      allDayDates(
        { start: '2026-09-21T00:00:00+05:30', end: '2026-09-23T00:00:00+05:30' },
        'google',
      ),
    ).toEqual({ start: '2026-09-21', end: '2026-09-23' });
  });

  it('rejects an end date that is not after the start date', () => {
    const err = (() => {
      try {
        allDayDates({ start: '2026-09-21T00:00:00Z', end: '2026-09-21T23:00:00Z' }, 'google');
      } catch (e) {
        return e;
      }
    })();
    expect(isUnibookingError(err) && err.code).toBe('INVALID_INPUT');
    expect(String((err as Error).message)).toMatch(/all-day end date must be after the start date/);
  });

  it('requires a range whenever allDay is given on an update', () => {
    expect(() => assertAllDayInput({ allDay: true }, 'google')).toThrow(/requires a range/);
    expect(() => assertAllDayInput({ allDay: false }, 'google')).toThrow(/requires a range/);
    expect(() => assertAllDayInput({}, 'google')).not.toThrow();
  });
});
