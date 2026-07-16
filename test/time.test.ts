import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  assertValidRange,
  durationMinutes,
  endFromDuration,
  formatWithOffset,
  isInstant,
  parseOffsetMinutes,
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
