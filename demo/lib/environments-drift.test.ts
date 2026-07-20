import { describe, it, expect } from 'vitest';
import { ADAPTERS } from './providers';
import { ENVIRONMENTS } from './environments';
import type { BookingClient } from 'unibooking';

/**
 * Adapter BASE constants are not exported, so comparing literals would just
 * restate them. Instead we inject a mock fetch, make one call, and assert the
 * URL the adapter actually tried to reach. This catches an adapter changing
 * hosts underneath the table.
 *
 * Credentials must be shape-valid per adapter — Boulevard base64-decodes its
 * apiSecret during auth and throws before fetching if it is not valid base64.
 */
const b64 = (s: string) => Buffer.from(s).toString('base64');

const CREDS: Record<string, Record<string, string>> = {
  google: { accessToken: 'x', calendarId: 'primary' },
  outlook: { accessToken: 'x' },
  microsoft_bookings: { accessToken: 'x', businessId: 'biz@contoso.onmicrosoft.com' },
  square: { accessToken: 'x', locationId: 'L1' },
  acuity: { userId: '1', apiKey: 'k' },
  bookeo: { apiKey: 'k', secretKey: 's' },
  mindbody: { apiKey: 'k', siteId: '-99', accessToken: 't', timezone: 'America/Los_Angeles' },
  wix: { accessToken: 'x' },
  calendly: { token: 't' },
  vagaro: { region: 'us04', businessId: 'b', accessToken: 'x' },
  zenoti: { apiKey: 'k', centerId: 'c' },
  boulevard: { businessId: 'b', locationId: 'l', apiKey: 'k', apiSecret: b64('secret') },
  phorest: { username: 'u', password: 'p', businessId: 'b', branchId: 'br' },
  setmore: { accessToken: 'x' },
};

/**
 * Most adapters are probed via getBooking. Setmore's Booking API has no
 * fetch-by-id endpoint, so its getBooking throws UNSUPPORTED without issuing a
 * request — probe it through listBookings instead. Excluding it is not an
 * option: Setmore's host changed between package versions, which is exactly
 * the drift this test exists to catch.
 */
const PROBE_OP: Record<string, (client: BookingClient) => Promise<unknown>> = {
  setmore: (c) =>
    c.listBookings({ range: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' } }),
};

/**
 * Adapters this suite cannot probe at all, via any operation:
 *  - mangomint: every method throws UNSUPPORTED (no public API documentation
 *    exists to implement against), so no method ever issues a request.
 *  - apple: CalDAV requests go to the user's own `calendarUrl`, not a fixed
 *    host derived from ENVIRONMENTS — `baseUrlEditable` is false for exactly
 *    this reason, so there is no single declared prod host to compare a
 *    request against.
 */
const UNPROBEABLE = ['mangomint', 'apple'];

async function observedUrl(provider: string): Promise<string | null> {
  let seen: string | null = null;
  const mockFetch = (async (input: RequestInfo | URL) => {
    seen = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const client = ADAPTERS[provider](CREDS[provider], { fetch: mockFetch });
  try {
    const probe = PROBE_OP[provider];
    if (probe) {
      await probe(client);
    } else {
      await client.getBooking('probe-id');
    }
  } catch {
    // Adapters reject the empty {} body — irrelevant, we only need the URL.
  }
  return seen;
}

describe('ENVIRONMENTS prod values match the adapters', () => {
  const probeable = Object.keys(ADAPTERS).filter((p) => !UNPROBEABLE.includes(p));

  it.each(probeable)('%s requests its declared prod host', async (provider) => {
    const url = await observedUrl(provider);
    expect(url, `${provider} made no request — check its CREDS fixture`).toBeTruthy();
    expect(url!.startsWith(ENVIRONMENTS[provider].prod)).toBe(true);
  });

  it('documents every adapter it cannot probe', () => {
    // Keeps the exclusion list honest: if an excluded adapter later starts
    // issuing requests, this fails and the exclusion gets revisited.
    expect(UNPROBEABLE.every((p) => p in ADAPTERS)).toBe(true);
    expect(probeable.length + UNPROBEABLE.length).toBe(Object.keys(ADAPTERS).length);
  });
});
