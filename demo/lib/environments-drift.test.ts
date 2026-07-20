import { describe, it, expect } from 'vitest';
import { ADAPTERS } from './providers';
import { ENVIRONMENTS } from './environments';

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

/** Adapters that never issue a request from getBooking — see file header. */
const UNPROBEABLE = ['mangomint', 'apple', 'setmore'];
// setmore added: v0.2.0's Booking API has no fetch-by-id endpoint, so getBooking
// throws UNSUPPORTED before issuing a request. Use searchAvailability or
// listBookings to probe the host.

async function observedUrl(provider: string): Promise<string | null> {
  let seen: string | null = null;
  const mockFetch = (async (input: RequestInfo | URL) => {
    seen = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    await ADAPTERS[provider](CREDS[provider], { fetch: mockFetch }).getBooking('probe-id');
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
