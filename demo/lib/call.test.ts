import { describe, it, expect, vi, afterEach } from 'vitest';
import { callGetBooking } from './call';
import type { Connection } from './result';

/**
 * `run()` in call.ts is the single point both transports (direct + proxy) pass
 * through, so this is where a baseUrl override must be validated for the 7
 * "direct" providers too — they never touch the demo's server, so the proxy
 * route's guard can't help them. These tests exercise `run()` via a direct
 * provider (google, phorest) end-to-end; a real network call would mean the
 * guard didn't fire, so fetch is always stubbed, per the idiom in
 * demo/app/api/call/route.test.ts.
 */
let outbound: string | null = null;

function stubFetch(response: unknown): void {
  outbound = null;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    outbound = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Shaped like a real Google Calendar `events.get` response so the adapter's
// parsing succeeds end-to-end.
const FAKE_GOOGLE_EVENT = {
  id: 'evt1',
  status: 'confirmed',
  start: { dateTime: '2026-07-20T10:00:00Z' },
  end: { dateTime: '2026-07-20T10:45:00Z' },
};

// Shaped like a real Phorest appointment response.
const FAKE_PHOREST_APPOINTMENT = {
  appointmentId: 'A1',
  appointmentDate: '2026-07-20',
  startTime: '10:00:00',
  endTime: '10:45:00',
  activationState: 'ACTIVE',
  confirmed: true,
};

describe('run() — baseUrl guard shared by direct and proxy transports', () => {
  it('rejects a disallowed base URL for a direct provider without ever calling fetch', async () => {
    // Never stub with data that would resolve — fetch must not be reached at all.
    stubFetch(FAKE_GOOGLE_EVENT);
    const conn: Connection = {
      creds: { accessToken: 'tok', calendarId: 'primary' },
      baseUrl: 'https://evil.example/',
    };
    const result = await callGetBooking('google', conn, 'evt1');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/not permitted/i);
    expect(outbound).toBeNull();
  });

  it('permits an allowed sandbox host through for a direct provider', async () => {
    stubFetch(FAKE_PHOREST_APPOINTMENT);
    const conn: Connection = {
      creds: {
        username: 'global/api@salon.com',
        password: 'secret',
        businessId: 'biz1',
        branchId: 'branch1',
      },
      // Phorest's sandbox host — a genuinely separate hostname from prod.
      baseUrl: 'https://api-gateway-dev.phorest.com/third-party-api-server/api/',
    };
    const result = await callGetBooking('phorest', conn, 'A1');
    expect(outbound).toBeTruthy();
    expect(outbound).toContain('api-gateway-dev.phorest.com');
    expect(result.ok).toBe(true);
  });

  it('still works with no base URL override for a direct provider', async () => {
    stubFetch(FAKE_GOOGLE_EVENT);
    const conn: Connection = { creds: { accessToken: 'tok', calendarId: 'primary' } };
    const result = await callGetBooking('google', conn, 'evt1');
    expect(outbound).toBeTruthy();
    expect(outbound).toContain('googleapis.com');
    expect(result.ok).toBe(true);
  });
});
