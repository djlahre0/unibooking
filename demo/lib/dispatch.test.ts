import { describe, it, expect } from 'vitest';
import type { BookingClient } from 'unibooking';
import { dispatch } from './dispatch';

/**
 * Google's freeBusy endpoint returns busy intervals, not bookable slots, so
 * its adapter refuses an availability query without a positive
 * `durationMinutes` ("pass a positive durationMinutes to size each slot").
 * The demo never forwarded the field, so Search Availability against Google
 * could not succeed from the UI at all — it failed INVALID_INPUT every time.
 */
function capturing() {
  const seen: { query?: Record<string, unknown> } = {};
  const client = {
    id: 'google',
    searchAvailability: async (q: Record<string, unknown>) => {
      seen.query = q;
      return { slots: [] };
    },
  } as unknown as BookingClient;
  return { client, seen };
}

describe('dispatch: searchAvailability', () => {
  it('forwards a positive durationMinutes', async () => {
    const { client, seen } = capturing();
    await dispatch(client, 'searchAvailability', {
      start: '2026-09-22T00:00:00Z',
      end: '2026-09-23T00:00:00Z',
      durationMinutes: 30,
    });
    expect(seen.query).toMatchObject({ durationMinutes: 30 });
  });

  it('omits durationMinutes entirely when it is absent', async () => {
    const { client, seen } = capturing();
    await dispatch(client, 'searchAvailability', {
      start: '2026-09-22T00:00:00Z',
      end: '2026-09-23T00:00:00Z',
    });
    expect(seen.query).not.toHaveProperty('durationMinutes');
  });

  it('omits a non-positive or non-numeric duration rather than passing it on', async () => {
    // A blank form field arrives as '' and Number('') is 0; sending 0 would
    // trip the adapter's own "must be positive" guard with a confusing error.
    for (const bad of [0, -15, Number.NaN, 'abc']) {
      const { client, seen } = capturing();
      await dispatch(client, 'searchAvailability', {
        start: '2026-09-22T00:00:00Z',
        end: '2026-09-23T00:00:00Z',
        durationMinutes: bad,
      });
      expect(seen.query, `durationMinutes: ${String(bad)}`).not.toHaveProperty('durationMinutes');
    }
  });
});
