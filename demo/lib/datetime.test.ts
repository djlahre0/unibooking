import { describe, it, expect } from 'vitest';
import { browserZone, toInstant } from './datetime';

describe('toInstant', () => {
  it('combines a picked date and time into an RFC3339 instant in the chosen zone', () => {
    expect(toInstant('2026-09-22', '10:00', 'Asia/Kolkata')).toBe('2026-09-22T10:00:00+05:30');
    expect(toInstant('2026-09-22', '10:00', 'UTC')).toBe('2026-09-22T10:00:00Z');
  });

  it('defaults a blank time to midnight, so a date-only pick still works', () => {
    expect(toInstant('2026-09-22', '', 'UTC')).toBe('2026-09-22T00:00:00Z');
  });

  it('resolves a DST gap forward rather than throwing', () => {
    // 02:30 does not exist on this date in New York; the library pushes it.
    expect(toInstant('2026-03-08', '02:30', 'America/New_York')).toBe('2026-03-08T03:30:00-04:00');
  });

  it('falls back to a plain local string when the zone is unusable', () => {
    // Never throws into a submit handler: the provider then rejects a clearly
    // wrong value instead of the page dying on an unhandled error.
    expect(toInstant('2026-09-22', '10:00', 'Not/AZone')).toBe('2026-09-22T10:00:00');
  });

  it('returns an empty string for a missing date', () => {
    expect(toInstant('', '10:00', 'UTC')).toBe('');
  });
});

describe('browserZone', () => {
  it('returns a usable IANA zone', () => {
    const tz = browserZone();
    expect(typeof tz).toBe('string');
    expect(tz.length).toBeGreaterThan(0);
    // Whatever it returns must itself be resolvable.
    expect(toInstant('2026-09-22', '10:00', tz)).not.toBe('2026-09-22T10:00:00');
  });
});
