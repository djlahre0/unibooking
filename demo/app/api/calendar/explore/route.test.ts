import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as explore } from './route';
import { readCalendarConfig } from '@/lib/calendar/config';
import { sessionCookies, type CalendarSession } from '@/lib/calendar/session';
import { fakeFetch } from '@/lib/calendar/fake-fetch';
import { __resetRateLimit } from '@/lib/rate-limit';

/**
 * /api/calendar/explore is what call.ts's runSession() posts to: it lets the
 * explorer tabs (Bookings, Availability, ...) run dispatch()'s full op set --
 * not the My Calendar tab's narrower CALENDAR_OPS -- against a signed-in
 * Google/Outlook session, with no token ever reaching the browser. Guards
 * mirror ./call/route.ts, so these tests mirror the "call" describe block in
 * ../routes.test.ts and the cross-origin/rate-limit idiom in
 * app/api/call/route.test.ts.
 */
const APP = 'http://localhost:3000';
const GCAL = 'https://www.googleapis.com/calendar/v3/';
const SECRET = 'k'.repeat(40);

let net: ReturnType<typeof fakeFetch>;
beforeEach(() => {
  __resetRateLimit();
  net = fakeFetch();
  vi.stubGlobal('fetch', net.fn);
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'csecret');
  vi.stubEnv('MICROSOFT_CLIENT_ID', '');
  vi.stubEnv('MICROSOFT_CLIENT_SECRET', '');
  vi.stubEnv('APP_URL', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const GOOGLE_SESSION: CalendarSession = {
  provider: 'google',
  tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: '2099-01-01T00:00:00Z' },
  account: { email: 'jane@gmail.com' },
};

async function sessionCookie(session: CalendarSession): Promise<string> {
  const headers = await sessionCookies(session, readCalendarConfig(), {});
  return headers.map((c) => c.split(';')[0]).join('; ');
}

function post(body: unknown, init: { cookie?: string; origin?: string; ip?: string } = {}) {
  return explore(
    new Request(`${APP}/api/calendar/explore`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: init.origin ?? APP,
        'x-forwarded-for': init.ip ?? '10.1.0.1',
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/calendar/explore', () => {
  it('rejects a cross-origin request', async () => {
    const res = await post(
      { op: 'checkConnection', args: {} },
      { origin: 'https://evil.example', cookie: await sessionCookie(GOOGLE_SESSION) },
    );
    expect(res.status).toBe(403);
    expect(net.calls).toHaveLength(0);
  });

  it('rejects an unknown op', async () => {
    const res = await post(
      { op: 'dropAllBookings', args: {} },
      { cookie: await sessionCookie(GOOGLE_SESSION) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(net.calls).toHaveLength(0);
  });

  it('answers reconnect: true with no session', async () => {
    const res = await post({ op: 'checkConnection', args: {} });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, reconnect: true, error: { code: 'AUTH' } });
    expect(net.calls).toHaveLength(0);
  });

  it('runs an op with a session, via the full dispatch() set the My Calendar routes do not expose', async () => {
    net.on('GET', `${GCAL}users/me/calendarList`, { body: { items: [{ id: 'jane@gmail.com' }] } });
    const res = await post(
      { op: 'checkConnection', args: {} },
      { cookie: await sessionCookie(GOOGLE_SESSION) },
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ ok: true, account: { id: 'jane@gmail.com' } });
    expect(net.calls[0]!.headers.get('authorization')).toBe('Bearer at');
  });
});
