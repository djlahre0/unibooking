import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as saveApp } from './oauth-app/[provider]/route';
import { GET as status } from './status/route';
import { __resetOAuthAppsCache } from '@/lib/calendar/oauth-apps';
import { __resetSessionSecretCache } from '@/lib/calendar/secret';
import { __resetRateLimit } from '@/lib/rate-limit';

const SECRET = 'k'.repeat(40);

/**
 * The route calls `readCalendarConfig()` and `writeOAuthApp()` with no
 * override, so both resolve their default path from `process.cwd()` -- point
 * that at a throwaway directory for the duration of each test, the same way
 * routes.test.ts's `withGeneratedSecret` does for `.session-secret`, so a
 * save here never touches this project's real `demo/.oauth-apps.json`.
 */
let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  __resetRateLimit();
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('GOOGLE_CLIENT_ID', '');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
  vi.stubEnv('MICROSOFT_CLIENT_ID', '');
  vi.stubEnv('MICROSOFT_CLIENT_SECRET', '');
  vi.stubEnv('APP_URL', '');
  tmpDir = mkdtempSync(join(tmpdir(), 'ub-oauth-app-route-test-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  __resetSessionSecretCache();
  __resetOAuthAppsCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  cwdSpy.mockRestore();
  __resetSessionSecretCache();
  __resetOAuthAppsCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

const params = (provider: string) => ({ params: Promise.resolve({ provider }) });

/**
 * `isLoopbackRequest` (lib/calendar/http.ts) reads the request's raw `Host`
 * header, not `req.url` -- confirmed against a real `next start` server, a
 * Route Handler's `req.url` is always this app's own configured origin
 * (e.g. always `http://localhost:3141`), independent of what a client
 * actually connected to. The bare `Request` constructor never populates a
 * `host` header from the URL on its own (confirmed directly too), so this
 * helper does it explicitly -- the same thing a real Next.js request always
 * carries -- and lets a test override it to simulate a spoofed Host from a
 * non-browser client.
 */
function post(
  url: string,
  body: unknown,
  init: { origin?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: init.origin ?? new URL(url).origin,
      host: new URL(url).host,
      ...(init.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

function savedFile(): { google?: { clientId: string; clientSecret: string; tenant?: string } } {
  return JSON.parse(readFileSync(join(tmpDir, '.oauth-apps.json'), 'utf8'));
}

describe('POST /api/calendar/oauth-app/[provider] -- operator setup, localhost only', () => {
  it('refuses a save from a non-loopback host', async () => {
    const res = await saveApp(
      post('https://demo.example.com/api/calendar/oauth-app/google', {
        clientId: 'cid',
        clientSecret: 'csecret',
      }),
      params('google'),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toMatch(/localhost/i);
  });

  it('a spoofed X-Forwarded-For: 127.0.0.1 does not grant access from a remote host', async () => {
    const res = await saveApp(
      post(
        'https://demo.example.com/api/calendar/oauth-app/google',
        { clientId: 'cid', clientSecret: 'csecret' },
        { headers: { 'x-forwarded-for': '127.0.0.1' } },
      ),
      params('google'),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('accepts and persists a save from loopback (localhost)', async () => {
    const res = await saveApp(
      post('http://localhost:3000/api/calendar/oauth-app/google', {
        clientId: 'cid',
        clientSecret: 'csecret',
      }),
      params('google'),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(savedFile().google).toEqual({ clientId: 'cid', clientSecret: 'csecret' });
  });

  it('refuses a save in production even from loopback -- Host is forgeable', async () => {
    // The loopback gate reads the `Host` header, which a non-browser client can
    // set to anything. On a reachable deployment that alone is not a boundary,
    // so setup is refused outright in production. NODE_ENV comes from the
    // server process, never from the request.
    // `vi.stubEnv` rather than a direct assignment: NODE_ENV is typed read-only,
    // and afterEach's `vi.unstubAllEnvs()` already restores it. A 403 here is
    // only reachable when the stub really took effect, so this cannot pass
    // vacuously.
    vi.stubEnv('NODE_ENV', 'production');
    const res = await saveApp(
      post('http://localhost:3000/api/calendar/oauth-app/google', {
        clientId: 'cid',
        clientSecret: 'csecret',
      }),
      params('google'),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
    // Nothing was persisted at all -- the file is never even created.
    expect(existsSync(join(tmpDir, '.oauth-apps.json'))).toBe(false);
  });

  it('127.0.0.1 and ::1 are accepted the same as localhost', async () => {
    for (const host of ['127.0.0.1', '[::1]']) {
      const res = await saveApp(
        post(`http://${host}:3000/api/calendar/oauth-app/outlook`, {
          clientId: 'cid',
          clientSecret: 'csecret',
        }),
        params('outlook'),
      );
      expect(res.status).toBe(200);
    }
  });

  it('refuses a cross-origin POST even from loopback', async () => {
    const res = await saveApp(
      post(
        'http://localhost:3000/api/calendar/oauth-app/google',
        { clientId: 'cid', clientSecret: 'csecret' },
        { origin: 'https://evil.example' },
      ),
      params('google'),
    );
    expect(res.status).toBe(403);
  });

  it('rejects a blank client id/secret with INVALID_INPUT', async () => {
    const blankId = await saveApp(
      post('http://localhost:3000/api/calendar/oauth-app/google', {
        clientId: '   ',
        clientSecret: 'csecret',
      }),
      params('google'),
    );
    expect(blankId.status).toBe(400);
    expect((await blankId.json()).error.code).toBe('INVALID_INPUT');

    const missing = await saveApp(
      post('http://localhost:3000/api/calendar/oauth-app/google', {}),
      params('google'),
    );
    expect(missing.status).toBe(400);
  });

  it('rejects an unknown provider', async () => {
    const res = await saveApp(
      post('http://localhost:3000/api/calendar/oauth-app/zoom', {
        clientId: 'cid',
        clientSecret: 'csecret',
      }),
      params('zoom'),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_INPUT');
  });

  it('rejects an invalid tenant value', async () => {
    const res = await saveApp(
      post('http://localhost:3000/api/calendar/oauth-app/outlook', {
        clientId: 'cid',
        clientSecret: 'csecret',
        tenant: '   ',
      }),
      params('outlook'),
    );
    expect(res.status).toBe(400);
  });

  it('saves an optional Microsoft tenant', async () => {
    const res = await saveApp(
      post('http://localhost:3000/api/calendar/oauth-app/outlook', {
        clientId: 'cid',
        clientSecret: 'csecret',
        tenant: 'my-directory-id',
      }),
      params('outlook'),
    );
    expect(res.status).toBe(200);
    const raw = JSON.parse(readFileSync(join(tmpDir, '.oauth-apps.json'), 'utf8'));
    expect(raw.outlook.tenant).toBe('my-directory-id');
  });

  it('never echoes the client secret back in the response body', async () => {
    const SEKRIT = 'sekrit-test-value-9f3-not-a-real-secret';
    const res = await saveApp(
      post('http://localhost:3000/api/calendar/oauth-app/google', {
        clientId: 'cid',
        clientSecret: SEKRIT,
      }),
      params('google'),
    );
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(SEKRIT);
  });

  it('the saved secret never appears in the status endpoint response, which reports the provider configured', async () => {
    const SEKRIT = 'sekrit-test-value-9f3-not-a-real-secret';
    await saveApp(
      post('http://localhost:3000/api/calendar/oauth-app/google', {
        clientId: 'my-client-id',
        clientSecret: SEKRIT,
      }),
      params('google'),
    );
    const statusRes = await status(new Request('http://localhost:3000/api/calendar/status'));
    const statusBody = await statusRes.json();
    expect(statusBody.data.providers.google).toBe(true);
    expect(JSON.stringify(statusBody)).not.toContain(SEKRIT);
    expect(JSON.stringify(statusBody)).not.toContain('my-client-id');
  });
});
