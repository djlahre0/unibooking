import { describe, it, expect, vi, afterEach } from 'vitest';
import { POST } from './route';

/**
 * The route builds its adapter with the global fetch and has no injection
 * point, so any request that PASSES the guard would otherwise make a real
 * network call to the provider. Stubbing the global both keeps the suite
 * offline and lets us assert the outbound host — which is the assertion that
 * matters: it proves baseUrl reached the adapter instead of being dropped.
 */
let outbound: string | null = null;

function stubFetch(): void {
  outbound = null;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    outbound = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The route reads x-forwarded-for for rate limiting; vary it to avoid the cap. */
function post(body: unknown, ip: string): Promise<Response> {
  return POST(
    new Request('http://localhost/api/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/call — baseUrl guard', () => {
  it('rejects a base URL that is not on the provider allowlist', async () => {
    const res = await post(
      {
        provider: 'square',
        op: 'getBooking',
        creds: { accessToken: 'x', locationId: 'L1' },
        baseUrl: 'https://evil.com/v2/',
        args: { bookingId: 'b1' },
      },
      '10.0.0.1',
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.message).toMatch(/not permitted/i);
  });

  it('rejects the credential-in-URL trick', async () => {
    const res = await post(
      {
        provider: 'square',
        op: 'getBooking',
        creds: { accessToken: 'x', locationId: 'L1' },
        baseUrl: 'https://connect.squareup.com@evil.com/',
        args: { bookingId: 'b1' },
      },
      '10.0.0.2',
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/not permitted/i);
  });

  it('rejects a plaintext http base URL', async () => {
    const res = await post(
      {
        provider: 'square',
        op: 'getBooking',
        creds: { accessToken: 'x', locationId: 'L1' },
        baseUrl: 'http://connect.squareup.com/v2/',
        args: { bookingId: 'b1' },
      },
      '10.0.0.3',
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/https/i);
  });

  it('forwards an allowlisted sandbox host to the adapter', async () => {
    stubFetch();
    await post(
      {
        provider: 'square',
        op: 'getBooking',
        creds: { accessToken: 'x', locationId: 'L1' },
        baseUrl: 'https://connect.squareupsandbox.com/v2/',
        args: { bookingId: 'b1' },
      },
      '10.0.0.4',
    );
    // The whole point of the feature: the override actually reached the client.
    expect(outbound).toBeTruthy();
    expect(outbound).toContain('connect.squareupsandbox.com');
  });

  it('uses the adapter default when no baseUrl is supplied', async () => {
    stubFetch();
    await post(
      {
        provider: 'square',
        op: 'getBooking',
        creds: { accessToken: 'x', locationId: 'L1' },
        args: { bookingId: 'b1' },
      },
      '10.0.0.5',
    );
    expect(outbound).toBeTruthy();
    expect(outbound).toContain('connect.squareup.com');
    expect(outbound).not.toContain('squareupsandbox');
  });
});
