import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as status } from './status/route';
import { GET as connect, POST as connectCustom } from './connect/[provider]/route';
import { GET as callback } from './callback/[provider]/route';
import { POST as appleConnect } from './apple/route';
import { POST as call } from './call/route';
import { POST as disconnect } from './disconnect/route';
import { readCalendarConfig } from '@/lib/calendar/config';
import { parseCookies, sessionCookies, type CalendarSession } from '@/lib/calendar/session';
import { __resetSessionSecretCache, resolveSessionSecret } from '@/lib/calendar/secret';
import { fakeFetch } from '@/lib/calendar/fake-fetch';
import { __resetRateLimit } from '@/lib/rate-limit';

const APP = 'http://localhost:3000';
const GCAL = 'https://www.googleapis.com/calendar/v3/';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
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

/**
 * The route handlers call `readCalendarConfig()` with no arguments, so a
 * test can't inject a temp `filePath` the way lib/calendar/config.test.ts
 * and secret.test.ts do. The only way to exercise "no valid SESSION_SECRET"
 * through the real routes without ever touching this project's real
 * `demo/.session-secret` is to point `process.cwd()` -- which secret.ts's
 * default path is built from -- at a throwaway temp directory for the
 * duration of one test, and reset the process-wide secret cache so it
 * neither leaks into, nor is contaminated by, any other test in this file.
 */
async function withGeneratedSecret<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'ub-routes-test-'));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  __resetSessionSecretCache();
  try {
    return await fn();
  } finally {
    cwdSpy.mockRestore();
    __resetSessionSecretCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

const params = (provider: string) => ({ params: Promise.resolve({ provider }) });

/** The `name=value` pairs a response set, as a request Cookie header. */
function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

function post(path: string, body: unknown, init: { cookie?: string; origin?: string } = {}) {
  return new Request(`${APP}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: init.origin ?? APP,
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function sessionCookie(session: CalendarSession): Promise<string> {
  const headers = await sessionCookies(session, readCalendarConfig(), {});
  return headers.map((c) => c.split(';')[0]).join('; ');
}

const GOOGLE_SESSION: CalendarSession = {
  provider: 'google',
  tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: '2099-01-01T00:00:00Z' },
  account: { email: 'jane@gmail.com' },
};

describe('status', () => {
  it('is enabled without a SESSION_SECRET -- a key is generated instead of the tab going missing', async () => {
    vi.stubEnv('SESSION_SECRET', '');
    await withGeneratedSecret(async () => {
      const body = await (await status(new Request(`${APP}/api/calendar/status`))).json();
      expect(body.data).toMatchObject({ enabled: true, connection: null });
      expect(body.data.problem).toBeUndefined();
    });
  });

  it('rejects an explicit SESSION_SECRET that is too short, and never mentions tokens', async () => {
    vi.stubEnv('SESSION_SECRET', 'short');
    const body = await (await status(new Request(`${APP}/api/calendar/status`))).json();
    expect(body.data).toMatchObject({ enabled: false, connection: null });
    expect(body.data.problem).toMatch(/SESSION_SECRET/);
  });

  it('never leaks the generated key in the status or connect response bodies', async () => {
    vi.stubEnv('SESSION_SECRET', '');
    await withGeneratedSecret(async () => {
      const statusRes = await status(new Request(`${APP}/api/calendar/status`));
      const statusBody = await statusRes.json();
      const connectRes = await connectCustom(
        post('/api/calendar/connect/google', {
          clientId: 'leak-check-cid',
          clientSecret: 'leak-check-secret',
        }),
        params('google'),
      );
      const connectBody = await connectRes.json();

      // Whatever key the routes just resolved and cached -- fetched the same
      // way config.ts does, so this is the actual key sealing every cookie
      // above, not a value the test invented itself.
      const generated = resolveSessionSecret().secret;
      expect(generated.length).toBeGreaterThanOrEqual(32);

      expect(JSON.stringify(statusBody)).not.toContain(generated);
      expect(JSON.stringify(connectBody)).not.toContain(generated);
      expect(statusRes.headers.getSetCookie().join('\n')).not.toContain(generated);
      expect(connectRes.headers.getSetCookie().join('\n')).not.toContain(generated);
    });
  });

  it('reports configured providers and the connected account', async () => {
    const res = await status(
      new Request(`${APP}/api/calendar/status`, {
        headers: { cookie: await sessionCookie(GOOGLE_SESSION) },
      }),
    );
    const { data } = await res.json();
    expect(data.providers).toEqual({ google: true, outlook: false, apple: true });
    expect(data.connection).toEqual({ provider: 'google', account: { email: 'jane@gmail.com' } });
    expect(JSON.stringify(data)).not.toMatch(/accessToken|refreshToken|"at"|"rt"/);
  });

  it('reports isLocalhost true when the request itself was made to localhost', async () => {
    // isLoopbackRequest reads the request's raw Host header (confirmed
    // against a real `next start` server that req.url itself does not carry
    // this -- see its doc comment on lib/calendar/http.ts), which the bare
    // Request constructor never populates from the URL on its own, so it's
    // set explicitly here to match what a real request actually carries.
    const res = await status(
      new Request(`${APP}/api/calendar/status`, { headers: { host: 'localhost:3000' } }),
    );
    expect((await res.json()).data.isLocalhost).toBe(true);
  });

  it('reports isLocalhost false for a remote host, even with a spoofed X-Forwarded-For: 127.0.0.1', async () => {
    const res = await status(
      new Request('https://demo.example.com/api/calendar/status', {
        headers: { host: 'demo.example.com', 'x-forwarded-for': '127.0.0.1' },
      }),
    );
    expect((await res.json()).data.isLocalhost).toBe(false);
  });
});

describe('OAuth connect + callback', () => {
  it('redirects to Google with PKCE and seals the flow state', async () => {
    const res = await connect(new Request(`${APP}/api/calendar/connect/google`), params('google'));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin).toBe('https://accounts.google.com');
    expect(to.searchParams.get('client_id')).toBe('cid');
    expect(to.searchParams.get('redirect_uri')).toBe(`${APP}/api/calendar/callback/google`);
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(to.searchParams.get('state')).toBeTruthy();
    expect(res.headers.getSetCookie()[0]).toMatch(/^ub_oauth\.0=v1\..+HttpOnly; SameSite=Lax/);
  });

  it('sends an unconfigured provider back with not_configured', async () => {
    const res = await connect(
      new Request(`${APP}/api/calendar/connect/outlook`),
      params('outlook'),
    );
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('not_configured');
  });

  it('refuses a callback whose state does not match, without any token request', async () => {
    const start = await connect(
      new Request(`${APP}/api/calendar/connect/google`),
      params('google'),
    );
    const res = await callback(
      new Request(`${APP}/api/calendar/callback/google?code=c&state=forged`, {
        headers: { cookie: cookieHeader(start) },
      }),
      params('google'),
    );
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('state_mismatch');
    expect(net.calls).toHaveLength(0);
  });

  it('reports a declined consent as access_denied', async () => {
    const res = await callback(
      new Request(`${APP}/api/calendar/callback/google?error=access_denied`),
      params('google'),
    );
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  /** Every Set-Cookie the flow-cookie-clearing helper adds, so each OAuth
   *  error test below can assert the flow cookie was cleared without
   *  repeating the match. */
  function flowCookieCleared(res: Response): boolean {
    return res.headers
      .getSetCookie()
      .some((c) => c.startsWith('ub_oauth.0=;') && c.includes('Max-Age=0'));
  }

  /** Starts a real flow (so a flow cookie actually exists to be cleared --
   *  `writeCookie` only emits a clearing Set-Cookie for cookie names the
   *  request carried, same as the "refuses a callback whose state does not
   *  match" test above) and returns the Cookie header for the callback. */
  async function startedFlow(): Promise<string> {
    const start = await connect(
      new Request(`${APP}/api/calendar/connect/google`),
      params('google'),
    );
    return cookieHeader(start);
  }

  it('forwards each standard OAuth error CODE unchanged, with the provider, so the tab can give honest per-code guidance', async () => {
    // The CODE (RFC 6749 §4.1.2.1, §5.2) is fixed and spec-defined, unlike
    // error_description below -- forwarding it verbatim is what lets
    // CalendarTab.tsx map each one to its own distinct message.
    const codes = [
      'access_denied',
      'invalid_client',
      'unauthorized_client',
      'redirect_uri_mismatch',
      'invalid_scope',
      'admin_policy_enforced',
      'org_internal',
      'disallowed_useragent',
      'server_error',
      'temporarily_unavailable',
      'invalid_request',
    ];
    for (const code of codes) {
      const cookie = await startedFlow();
      const res = await callback(
        new Request(`${APP}/api/calendar/callback/google?error=${code}`, { headers: { cookie } }),
        params('google'),
      );
      const location = new URL(res.headers.get('location')!);
      expect(location.searchParams.get('error')).toBe(code);
      // The provider rides along too -- CalendarTab.tsx needs it to compute
      // the exact redirect URL to show for redirect_uri_mismatch.
      expect(location.searchParams.get('provider')).toBe('google');
      expect(flowCookieCleared(res)).toBe(true);
    }
  });

  it('forwards an unrecognised but well-formed error code unchanged rather than swallowing it', async () => {
    const cookie = await startedFlow();
    const res = await callback(
      new Request(`${APP}/api/calendar/callback/google?error=consent_required`, {
        headers: { cookie },
      }),
      params('google'),
    );
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('consent_required');
    expect(flowCookieCleared(res)).toBe(true);
  });

  it('never reflects a malformed or hostile error value into the redirect', async () => {
    const hostile = [
      '<script>alert(1)</script>',
      'a'.repeat(500),
      'invalid client', // space -- not [a-z_]
      'Invalid_Client', // uppercase -- not [a-z_]
      'ünïcödé_error', // non-ASCII
    ];
    for (const value of hostile) {
      const cookie = await startedFlow();
      const res = await callback(
        new Request(`${APP}/api/calendar/callback/google?error=${encodeURIComponent(value)}`, {
          headers: { cookie },
        }),
        params('google'),
      );
      const location = new URL(res.headers.get('location')!);
      // Collapsed to the fixed fallback code -- none of the hostile text
      // itself ever reaches the redirect.
      expect(location.searchParams.get('error')).toBe('oauth_error');
      expect(location.toString()).not.toContain('script');
      expect(location.toString()).not.toContain('alert');
      expect(flowCookieCleared(res)).toBe(true);
    }
  });

  it('never forwards error_description, regardless of what the provider sent', async () => {
    const cookie = await startedFlow();
    const res = await callback(
      new Request(
        `${APP}/api/calendar/callback/google?error=access_denied&error_description=${encodeURIComponent(
          'denied because <script>steal()</script>, client_secret=abc123',
        )}`,
        { headers: { cookie } },
      ),
      params('google'),
    );
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.has('error_description')).toBe(false);
    expect(location.toString()).not.toContain('script');
    expect(location.toString()).not.toContain('abc123');
    expect(flowCookieCleared(res)).toBe(true);
  });

  it('exchanges the code, identifies the account and seals the session', async () => {
    const start = await connect(
      new Request(`${APP}/api/calendar/connect/google`),
      params('google'),
    );
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    net
      .on('POST', TOKEN_URL, {
        body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'calendar' },
      })
      .on('GET', `${GCAL}users/me/calendarList`, { body: { items: [{ id: 'jane@gmail.com' }] } })
      .on('GET', `${GCAL}users/me/calendarList`, {
        body: {
          items: [{ id: 'jane@gmail.com', summary: 'Jane', primary: true, accessRole: 'owner' }],
        },
      });

    const res = await callback(
      new Request(`${APP}/api/calendar/callback/google?code=authcode&state=${state}`, {
        headers: { cookie: cookieHeader(start) },
      }),
      params('google'),
    );
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('connected')).toBe('google');
    // The PKCE verifier from the flow cookie reached the token endpoint.
    expect(new URLSearchParams(net.calls[0]!.body).get('code_verifier')).toBeTruthy();
    const set = res.headers.getSetCookie();
    expect(set.some((c) => c.startsWith('ub_cal.0=v1.'))).toBe(true);
    expect(set.some((c) => c.startsWith('ub_oauth.0=;') && c.includes('Max-Age=0'))).toBe(true);

    const after = await (
      await status(
        new Request(`${APP}/api/calendar/status`, { headers: { cookie: cookieHeader(res) } }),
      )
    ).json();
    expect(after.data.connection.account.email).toBe('jane@gmail.com');
  });
});

describe('bring your own OAuth app', () => {
  // A distinctive value, never a realistic-looking secret, so a stray match
  // anywhere in a response body is unambiguous rather than a coincidence.
  const SEKRIT = 'sekrit-test-value-9f3-not-a-real-secret';

  it('rejects a missing or blank client id/secret with INVALID_INPUT', async () => {
    const blankId = await connectCustom(
      post('/api/calendar/connect/google', { clientId: '   ', clientSecret: SEKRIT }),
      params('google'),
    );
    expect(blankId.status).toBe(400);
    const blankIdBody = await blankId.json();
    expect(blankIdBody.error.code).toBe('INVALID_INPUT');
    expect(JSON.stringify(blankIdBody)).not.toContain(SEKRIT);

    const missing = await connectCustom(post('/api/calendar/connect/google', {}), params('google'));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('INVALID_INPUT');
  });

  it('refuses a cross-origin POST', async () => {
    const res = await connectCustom(
      post(
        '/api/calendar/connect/google',
        { clientId: 'my-own-cid', clientSecret: SEKRIT },
        { origin: 'https://evil.example' },
      ),
      params('google'),
    );
    expect(res.status).toBe(403);
  });

  it('still completes bring-your-own sign-in without any SESSION_SECRET, using a generated key', async () => {
    vi.stubEnv('SESSION_SECRET', '');
    await withGeneratedSecret(async () => {
      const res = await connectCustom(
        post('/api/calendar/connect/google', { clientId: 'my-own-cid', clientSecret: SEKRIT }),
        params('google'),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    });
  });

  it('rejects an explicit SESSION_SECRET that is too short -- sealing needs a real key', async () => {
    vi.stubEnv('SESSION_SECRET', 'short');
    const res = await connectCustom(
      post('/api/calendar/connect/google', { clientId: 'my-own-cid', clientSecret: SEKRIT }),
      params('google'),
    );
    expect(res.status).toBe(503);
  });

  it('seals the visitor’s app into the flow cookie and returns a consent URL, never the secret', async () => {
    const res = await connectCustom(
      post('/api/calendar/connect/google', { clientId: 'my-own-cid', clientSecret: SEKRIT }),
      params('google'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const url = new URL(body.data.url);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe('my-own-cid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(JSON.stringify(body)).not.toContain(SEKRIT);
    expect(res.headers.getSetCookie()[0]).toMatch(/^ub_oauth\.0=v1\..+HttpOnly; SameSite=Lax/);
  });

  it('works even when the deployer has not configured this provider', async () => {
    // MICROSOFT_CLIENT_ID/SECRET are unset in this file's beforeEach.
    const res = await connectCustom(
      post('/api/calendar/connect/outlook', { clientId: 'cid', clientSecret: SEKRIT }),
      params('outlook'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(new URL(body.data.url).host).toBe('login.microsoftonline.com');
  });

  it('defaults an omitted Microsoft tenant to common, and honors a supplied one', async () => {
    const defaulted = await connectCustom(
      post('/api/calendar/connect/outlook', { clientId: 'cid', clientSecret: SEKRIT }),
      params('outlook'),
    );
    const defaultedUrl = new URL((await defaulted.json()).data.url);
    expect(defaultedUrl.pathname.split('/')[1]).toBe('common');

    const tenanted = await connectCustom(
      post('/api/calendar/connect/outlook', {
        clientId: 'cid',
        clientSecret: SEKRIT,
        tenant: 'my-directory-id',
      }),
      params('outlook'),
    );
    const tenantedUrl = new URL((await tenanted.json()).data.url);
    expect(tenantedUrl.pathname.split('/')[1]).toBe('my-directory-id');
  });

  it('rejects an invalid tenant value', async () => {
    const res = await connectCustom(
      post('/api/calendar/connect/outlook', {
        clientId: 'cid',
        clientSecret: SEKRIT,
        tenant: '   ',
      }),
      params('outlook'),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_INPUT');
  });

  it('refuses a callback with a mismatched state, without any token request', async () => {
    const start = await connectCustom(
      post('/api/calendar/connect/google', { clientId: 'my-own-cid', clientSecret: SEKRIT }),
      params('google'),
    );
    const res = await callback(
      new Request(`${APP}/api/calendar/callback/google?code=c&state=forged`, {
        headers: { cookie: cookieHeader(start) },
      }),
      params('google'),
    );
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('state_mismatch');
    expect(net.calls).toHaveLength(0);
  });

  it('completes sign-in with the visitor’s own app, sealing the client id/secret into the session -- never returning the secret to status or the callback redirect', async () => {
    const start = await connectCustom(
      post('/api/calendar/connect/google', { clientId: 'my-own-cid', clientSecret: SEKRIT }),
      params('google'),
    );
    const state = new URL((await start.json()).data.url).searchParams.get('state')!;
    net
      .on('POST', TOKEN_URL, {
        body: { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 },
      })
      // checkConnection()'s health probe, then identify()'s own listCalendars
      // read -- same two-call shape as the deployer-app flow test above.
      .on('GET', `${GCAL}users/me/calendarList`, { body: { items: [{ id: 'byo@gmail.com' }] } })
      .on('GET', `${GCAL}users/me/calendarList`, {
        body: {
          items: [{ id: 'byo@gmail.com', summary: 'BYO', primary: true, accessRole: 'owner' }],
        },
      });

    const res = await callback(
      new Request(`${APP}/api/calendar/callback/google?code=authcode&state=${state}`, {
        headers: { cookie: cookieHeader(start) },
      }),
      params('google'),
    );
    // The token endpoint legitimately receives the secret -- that's the
    // provider's own fixed token URL, not a page response.
    expect(new URLSearchParams(net.calls[0]!.body).get('client_secret')).toBe(SEKRIT);
    // Nothing sent back to the browser does: not the redirect location, and
    // not the sealed (encrypted) cookie value either.
    expect(res.headers.get('location')).not.toContain(SEKRIT);
    expect(res.headers.getSetCookie().join('\n')).not.toContain(SEKRIT);

    const statusBody = await (
      await status(
        new Request(`${APP}/api/calendar/status`, { headers: { cookie: cookieHeader(res) } }),
      )
    ).json();
    expect(JSON.stringify(statusBody)).not.toContain(SEKRIT);
    expect(statusBody.data.connection).toMatchObject({ provider: 'google', custom: true });
    expect(statusBody.data.connection.account.email).toBe('byo@gmail.com');
  });
});

describe('call', () => {
  it('requires a session', async () => {
    const res = await call(post('/api/calendar/call', { op: 'listCalendars', args: {} }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, reconnect: true, error: { code: 'AUTH' } });
  });

  it('refuses a cross-origin POST', async () => {
    const res = await call(
      post(
        '/api/calendar/call',
        { op: 'listCalendars', args: {} },
        { origin: 'https://evil.example' },
      ),
    );
    expect(res.status).toBe(403);
  });

  it('rejects an unknown op', async () => {
    const res = await call(
      post(
        '/api/calendar/call',
        { op: 'dropAll', args: {} },
        { cookie: await sessionCookie(GOOGLE_SESSION) },
      ),
    );
    expect(res.status).toBe(400);
  });

  it('runs an op against the session provider', async () => {
    net.on('GET', `${GCAL}users/me/calendarList`, {
      body: {
        items: [{ id: 'jane@gmail.com', summary: 'Jane', primary: true, accessRole: 'owner' }],
      },
    });
    const res = await call(
      post(
        '/api/calendar/call',
        { op: 'listCalendars', args: {} },
        { cookie: await sessionCookie(GOOGLE_SESSION) },
      ),
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.calendars[0]).toMatchObject({ id: 'jane@gmail.com', primary: true });
    expect(net.calls[0]!.headers.get('authorization')).toBe('Bearer at');
  });

  it('re-seals the cookie when the token was refreshed', async () => {
    const expired = {
      ...GOOGLE_SESSION,
      tokens: { ...GOOGLE_SESSION.tokens, expiresAt: '2000-01-01T00:00:00Z' },
    };
    net
      .on('POST', TOKEN_URL, { body: { access_token: 'fresh', expires_in: 3600 } })
      .on('GET', `${GCAL}users/me/calendarList`, { body: { items: [] } });
    const res = await call(
      post(
        '/api/calendar/call',
        { op: 'listCalendars', args: {} },
        { cookie: await sessionCookie(expired) },
      ),
    );
    expect((await res.json()).ok).toBe(true);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('ub_cal.0=v1.'))).toBe(true);
  });

  it('clears the session and asks to reconnect when the refresh is refused', async () => {
    const expired = {
      ...GOOGLE_SESSION,
      tokens: { ...GOOGLE_SESSION.tokens, expiresAt: '2000-01-01T00:00:00Z' },
    };
    net.on('POST', TOKEN_URL, { status: 400, body: { error: 'invalid_grant' } });
    const res = await call(
      post(
        '/api/calendar/call',
        { op: 'listCalendars', args: {} },
        { cookie: await sessionCookie(expired) },
      ),
    );
    expect(await res.json()).toMatchObject({ ok: false, reconnect: true });
    expect(res.headers.getSetCookie().some((c) => c.startsWith('ub_cal.0=;'))).toBe(true);
  });

  it('refuses an Apple calendar id outside iCloud', async () => {
    const appleSession: CalendarSession = {
      provider: 'apple',
      apple: { username: 'jane@icloud.com', appPassword: 'p' },
      account: { email: 'jane@icloud.com' },
    };
    const res = await call(
      post(
        '/api/calendar/call',
        {
          op: 'listEvents',
          args: { calendarId: 'https://evil.example/cal/', start: 'a', end: 'b' },
        },
        { cookie: await sessionCookie(appleSession) },
      ),
    );
    expect(res.status).toBe(400);
    expect(net.calls).toHaveLength(0);
  });
});

describe('apple connect', () => {
  it('requires both fields', async () => {
    const res = await appleConnect(
      post('/api/calendar/apple', { appleId: 'jane@icloud.com', appPassword: ' ' }),
    );
    expect(res.status).toBe(400);
  });

  it('explains a rejected app-specific password', async () => {
    net.on('PROPFIND', 'https://caldav.icloud.com/', { status: 401, body: '' });
    const res = await appleConnect(
      post('/api/calendar/apple', { appleId: 'jane@icloud.com', appPassword: 'bad' }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toMatch(/app-specific password/);
  });
});

describe('disconnect', () => {
  it('clears the session and revokes the Google grant', async () => {
    net.on('POST', 'https://oauth2.googleapis.com/revoke', { body: {} });
    const res = await disconnect(
      post('/api/calendar/disconnect', {}, { cookie: await sessionCookie(GOOGLE_SESSION) }),
    );
    expect((await res.json()).ok).toBe(true);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('ub_cal.0=;'))).toBe(true);
    expect(net.calls[0]!.body).toContain('token=rt');
    expect(parseCookies(cookieHeader(res))['ub_cal.0']).toBe('');
  });
});
