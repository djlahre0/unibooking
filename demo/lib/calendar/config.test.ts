import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appOrigin, oauthClient, readCalendarConfig, redirectUri, scopesFor } from './config';
import { __resetOAuthAppsCache, writeOAuthApp } from './oauth-apps';
import { __resetSessionSecretCache } from './secret';

const SECRET = 'x'.repeat(32);

// readCalendarConfig() without a (valid) env SESSION_SECRET falls back to a
// generated, persisted key (see secret.ts) -- these tests give it a
// throwaway temp directory rather than the real demo/.session-secret, and
// reset the process-wide cache so every test resolves independently instead
// of reusing whichever key an earlier test generated. The operator's saved
// OAuth apps (oauth-apps.ts) cache the same way -- reset alongside it, so a
// test that saves one doesn't leak into a test that doesn't.
const tmpDirs: string[] = [];
function freshFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ub-config-test-'));
  tmpDirs.push(dir);
  return join(dir, '.session-secret');
}
function freshOAuthAppsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ub-config-test-apps-'));
  tmpDirs.push(dir);
  return join(dir, '.oauth-apps.json');
}
/**
 * `readOAuthApps` defaults to `process.cwd()/.oauth-apps.json`, so any test
 * here that does NOT pass an explicit apps override would otherwise read the
 * REAL demo/.oauth-apps.json of whoever runs the suite. That file exists as
 * soon as someone uses the operator setup screen, and it then turns
 * `providers.google` (or outlook) true underneath tests asserting false --
 * a suite that passes only on machines where the feature was never used.
 * Pointing cwd at an empty temp directory makes the whole file hermetic by
 * construction, so a future test cannot forget the override; the same idiom
 * oauth-app.test.ts already uses.
 */
let cwdSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ub-config-test-cwd-'));
  tmpDirs.push(dir);
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  __resetOAuthAppsCache();
});
afterEach(() => {
  cwdSpy.mockRestore();
  __resetSessionSecretCache();
  __resetOAuthAppsCache();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readCalendarConfig', () => {
  it('is enabled without a SESSION_SECRET -- a key is generated instead of the tab going missing', () => {
    const c = readCalendarConfig({}, { filePath: freshFilePath() });
    expect(c.enabled).toBe(true);
    expect(c.problem).toBeUndefined();
    expect(c.sessionSecret.length).toBeGreaterThanOrEqual(32);
    // Apple needs nothing beyond a working session; Google/Outlook still need
    // either an env-configured app (below) or, at the route layer, a
    // visitor's own "bring your own OAuth app".
    expect(c.providers).toEqual({ google: false, outlook: false, apple: true });
  });

  it('rejects an explicit SESSION_SECRET that is too short, rather than silently falling back', () => {
    // Deliberately no filePath override: an explicit-but-invalid override is
    // the one case that still disables the feature, and disabled means the
    // fallback path in secret.ts is never reached -- so this never touches
    // any filesystem at all.
    const c = readCalendarConfig({ SESSION_SECRET: 'short' });
    expect(c.enabled).toBe(false);
    expect(c.problem).toMatch(/at least 32/);
    expect(c.providers).toEqual({ google: false, outlook: false, apple: false });
  });

  it('offers Google once both id and secret are present, with no env session secret at all', () => {
    const c = readCalendarConfig(
      { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' },
      { filePath: freshFilePath() },
    );
    expect(c.enabled).toBe(true);
    expect(c.providers.google).toBe(true);
  });

  it('keeps OAuth providers off when only one of id/secret is present', () => {
    const c = readCalendarConfig({
      SESSION_SECRET: SECRET,
      GOOGLE_CLIENT_ID: 'id',
      // no GOOGLE_CLIENT_SECRET
    });
    expect(c.providers.google).toBe(false);
  });

  it('enables apple with only a secret, OAuth providers only with id AND secret', () => {
    const c = readCalendarConfig({
      SESSION_SECRET: SECRET,
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 's',
      MICROSOFT_CLIENT_ID: 'id',
    });
    expect(c.providers).toEqual({ google: true, outlook: false, apple: true });
  });

  it('defaults the Microsoft tenant to common', () => {
    const c = readCalendarConfig({
      SESSION_SECRET: SECRET,
      MICROSOFT_CLIENT_ID: 'id',
      MICROSOFT_CLIENT_SECRET: 's',
    });
    expect(c.microsoft?.tenant).toBe('common');
  });
});

// The operator's one-time setup (lib/calendar/oauth-apps.ts, saved through
// the localhost-only POST route) is a lower-precedence source than env --
// this is what lets a deployer's env vars keep working as an override.
describe("readCalendarConfig: the operator's saved OAuth app", () => {
  it('offers Google once the operator has saved an app, with no env vars at all', () => {
    const appsPath = freshOAuthAppsPath();
    writeOAuthApp(
      'google',
      { clientId: 'saved-id', clientSecret: 'saved-secret' },
      { filePath: appsPath },
    );
    const c = readCalendarConfig({ SESSION_SECRET: SECRET }, {}, { filePath: appsPath });
    expect(c.providers.google).toBe(true);
    expect(c.google).toEqual({ clientId: 'saved-id', clientSecret: 'saved-secret' });
  });

  it('prefers env GOOGLE_CLIENT_ID/SECRET over a saved app when both are present', () => {
    const appsPath = freshOAuthAppsPath();
    writeOAuthApp(
      'google',
      { clientId: 'saved-id', clientSecret: 'saved-secret' },
      { filePath: appsPath },
    );
    const c = readCalendarConfig(
      { SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: 'env-id', GOOGLE_CLIENT_SECRET: 'env-secret' },
      {},
      { filePath: appsPath },
    );
    expect(c.google).toEqual({ clientId: 'env-id', clientSecret: 'env-secret' });
  });

  it('uses the saved Microsoft tenant when env does not override it', () => {
    const appsPath = freshOAuthAppsPath();
    writeOAuthApp(
      'outlook',
      { clientId: 'saved-id', clientSecret: 'saved-secret', tenant: 'saved-tenant' },
      { filePath: appsPath },
    );
    const c = readCalendarConfig({ SESSION_SECRET: SECRET }, {}, { filePath: appsPath });
    expect(c.microsoft).toEqual({
      clientId: 'saved-id',
      clientSecret: 'saved-secret',
      tenant: 'saved-tenant',
    });
  });

  it('does not report a provider as configured from a saved app missing its secret', () => {
    const appsPath = freshOAuthAppsPath();
    // writeOAuthApp always writes both fields together in normal use, but a
    // hand-edited file is still possible -- a clientId with no secret must
    // not be treated as configured.
    writeOAuthApp('google', { clientId: 'saved-id', clientSecret: '' }, { filePath: appsPath });
    const c = readCalendarConfig({ SESSION_SECRET: SECRET }, {}, { filePath: appsPath });
    expect(c.providers.google).toBe(false);
    expect(c.google).toBeUndefined();
  });
});

describe('origins, redirect URIs and scopes', () => {
  it('uses APP_URL when set, else the request origin', () => {
    const withUrl = readCalendarConfig({
      SESSION_SECRET: SECRET,
      APP_URL: 'https://demo.example.com/',
    });
    expect(appOrigin(new Request('http://internal:3000/x'), withUrl)).toBe(
      'https://demo.example.com',
    );
    const plain = readCalendarConfig({ SESSION_SECRET: SECRET });
    expect(appOrigin(new Request('http://localhost:3000/x?y=1'), plain)).toBe(
      'http://localhost:3000',
    );
  });

  it('builds the exact callback URI the provider must have registered', () => {
    expect(redirectUri('http://localhost:3000', 'google')).toBe(
      'http://localhost:3000/api/calendar/callback/google',
    );
  });

  it('asks Outlook for refresh and identity, Google for its calendar scopes', () => {
    expect(scopesFor('outlook')).toEqual(['offline_access', 'User.Read', 'Calendars.ReadWrite']);
    expect(scopesFor('google')).toContain('https://www.googleapis.com/auth/calendar');
  });

  it('builds a client only for a configured provider', () => {
    const c = readCalendarConfig({
      SESSION_SECRET: SECRET,
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 's',
    });
    expect(oauthClient(c, 'google', 'http://localhost:3000/cb').provider).toBe('google');
    expect(() => oauthClient(c, 'outlook', 'http://localhost:3000/cb')).toThrow(/not configured/);
  });
});
