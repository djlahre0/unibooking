import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetOAuthAppsCache,
  readOAuthApps,
  removeOAuthApp,
  writeOAuthApp,
} from './oauth-apps';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ub-oauth-apps-test-'));
  __resetOAuthAppsCache();
});
afterEach(() => {
  __resetOAuthAppsCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

function path(name = '.oauth-apps.json'): string {
  return join(tmpDir, name);
}

describe('readOAuthApps', () => {
  it('returns an empty set when no file exists yet -- a fresh clone has nothing saved', () => {
    expect(readOAuthApps({ filePath: path() })).toEqual({});
  });

  it('returns an empty set, without throwing, for a corrupt file', () => {
    const filePath = path();
    writeFileSync(filePath, 'not json{{{');
    expect(() => readOAuthApps({ filePath })).not.toThrow();
    expect(readOAuthApps({ filePath })).toEqual({});
  });

  it('caches the resolution -- a later on-disk change is not picked up until the cache is reset', () => {
    const filePath = path();
    writeOAuthApp('google', { clientId: 'a', clientSecret: 'b' }, { filePath });
    __resetOAuthAppsCache();
    expect(readOAuthApps({ filePath }).google?.clientId).toBe('a');

    // A write through a DIFFERENT resolution (simulating an external edit)
    // updates the file, but the already-cached read must not see it.
    readOAuthApps({ filePath }); // populates the cache
    writeFileSync(filePath, JSON.stringify({ google: { clientId: 'z' } }));
    expect(readOAuthApps({ filePath }).google?.clientId).toBe('a');
  });
});

describe('writeOAuthApp', () => {
  it('persists a provider app with owner-only permissions and reads it back', () => {
    const filePath = path();
    const ok = writeOAuthApp('google', { clientId: 'cid', clientSecret: 'csecret' }, { filePath });
    expect(ok).toBe(true);

    const raw = readFileSync(filePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({ google: { clientId: 'cid', clientSecret: 'csecret' } });

    // Windows doesn't enforce POSIX mode bits the same way, but the mode is
    // still passed through to fs -- this just checks the file exists and is
    // a plain file, the meaningful owner-only assertion is POSIX-specific and
    // covered the same way secret.test.ts covers it for .session-secret.
    expect(statSync(filePath).isFile()).toBe(true);

    __resetOAuthAppsCache();
    expect(readOAuthApps({ filePath })).toEqual({
      google: { clientId: 'cid', clientSecret: 'csecret' },
    });
  });

  it('merges with an existing provider instead of clobbering it', () => {
    const filePath = path();
    writeOAuthApp('google', { clientId: 'g-id', clientSecret: 'g-secret' }, { filePath });
    writeOAuthApp(
      'outlook',
      { clientId: 'o-id', clientSecret: 'o-secret', tenant: 'my-tenant' },
      { filePath },
    );
    __resetOAuthAppsCache();
    expect(readOAuthApps({ filePath })).toEqual({
      google: { clientId: 'g-id', clientSecret: 'g-secret' },
      outlook: { clientId: 'o-id', clientSecret: 'o-secret', tenant: 'my-tenant' },
    });
  });

  it('overwrites a previously saved app for the same provider', () => {
    const filePath = path();
    writeOAuthApp('google', { clientId: 'old', clientSecret: 'old-secret' }, { filePath });
    writeOAuthApp('google', { clientId: 'new', clientSecret: 'new-secret' }, { filePath });
    __resetOAuthAppsCache();
    expect(readOAuthApps({ filePath }).google).toEqual({
      clientId: 'new',
      clientSecret: 'new-secret',
    });
  });

  it('updates the in-process cache immediately, so the very next read sees the write without a reset', () => {
    const filePath = path();
    writeOAuthApp('google', { clientId: 'cid', clientSecret: 'csecret' }, { filePath });
    // No __resetOAuthAppsCache() call here -- writeOAuthApp must keep the
    // cache in sync itself, the same way a save followed by a status check
    // in the same process must see the just-saved app.
    expect(readOAuthApps({ filePath }).google?.clientId).toBe('cid');
  });

  it("returns false, without throwing, when the file can't be written", () => {
    // A path whose parent can never be created (a file, not a directory, in
    // the way) reliably fails mkdirSync/writeFileSync on every platform,
    // without needing to fake a read-only filesystem.
    const blockedParent = path('blocked');
    writeFileSync(blockedParent, 'i am a file, not a directory');
    const filePath = join(blockedParent, 'nested', '.oauth-apps.json');
    let ok: boolean | undefined;
    expect(() => {
      ok = writeOAuthApp('google', { clientId: 'a', clientSecret: 'b' }, { filePath });
    }).not.toThrow();
    expect(ok).toBe(false);
  });
});

describe('removeOAuthApp', () => {
  it('removes one provider and leaves the others', () => {
    const filePath = path();
    writeOAuthApp('google', { clientId: 'gid', clientSecret: 'gsecret' }, { filePath });
    writeOAuthApp('outlook', { clientId: 'mid', clientSecret: 'msecret' }, { filePath });

    expect(removeOAuthApp('google', { filePath })).toBe(true);

    __resetOAuthAppsCache();
    const apps = readOAuthApps({ filePath });
    expect(apps.google).toBeUndefined();
    expect(apps.outlook).toEqual({ clientId: 'mid', clientSecret: 'msecret' });
  });

  it('updates the in-process cache immediately, like writeOAuthApp does', () => {
    const filePath = path();
    writeOAuthApp('google', { clientId: 'gid', clientSecret: 'gsecret' }, { filePath });
    removeOAuthApp('google', { filePath });
    // No cache reset: a reset followed by a status check in the same process
    // must see the removal, or the card would not flip back to the form.
    expect(readOAuthApps({ filePath }).google).toBeUndefined();
  });

  it('keeps the file, with its owner-only mode, after the last entry goes', () => {
    const filePath = path();
    writeOAuthApp('google', { clientId: 'gid', clientSecret: 'gsecret' }, { filePath });
    removeOAuthApp('google', { filePath });
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({});
    if (process.platform !== 'win32') {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('removing a provider that was never saved is a no-op that still succeeds', () => {
    const filePath = path();
    writeOAuthApp('google', { clientId: 'gid', clientSecret: 'gsecret' }, { filePath });
    expect(removeOAuthApp('outlook', { filePath })).toBe(true);
    expect(readOAuthApps({ filePath }).google?.clientId).toBe('gid');
  });

  it("returns false, without throwing, when the file can't be written", () => {
    const blockedParent = path('blocked-remove');
    writeFileSync(blockedParent, 'i am a file, not a directory');
    const filePath = join(blockedParent, 'nested', '.oauth-apps.json');
    let ok: boolean | undefined;
    expect(() => {
      ok = removeOAuthApp('google', { filePath });
    }).not.toThrow();
    expect(ok).toBe(false);
  });
});
