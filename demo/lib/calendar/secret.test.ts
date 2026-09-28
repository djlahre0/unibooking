import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSessionSecretCache, resolveSessionSecret } from './secret';

// `state.throwOnWrite` lets individual tests simulate a read-only filesystem
// (EROFS) without touching real OS permissions -- which Windows CI can't
// exercise the same way as POSIX anyway. Every other test uses the real,
// unmocked write/read behaviour against a throwaway temp directory, so this
// stays a thin, targeted fault injector rather than a full fake filesystem.
// `vi.hoisted` is the documented way to share state into a `vi.mock` factory.
const state = vi.hoisted(() => ({ throwOnWrite: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const writeFileSync = vi.fn((...args: Parameters<typeof actual.writeFileSync>) => {
    if (state.throwOnWrite) throw new Error('EROFS: read-only file system');
    return actual.writeFileSync(...args);
  });
  return { ...actual, writeFileSync };
});

const mockedWriteFileSync = vi.mocked(writeFileSync);

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ub-secret-test-'));
  __resetSessionSecretCache();
  mockedWriteFileSync.mockClear();
  state.throwOnWrite = false;
});
afterEach(() => {
  __resetSessionSecretCache();
  state.throwOnWrite = false;
  rmSync(tmpDir, { recursive: true, force: true });
});

function path(name = '.session-secret'): string {
  return join(tmpDir, name);
}

describe('resolveSessionSecret', () => {
  it('generates and persists a key when none exists, ready for the next process to reuse', () => {
    const filePath = path();
    const first = resolveSessionSecret({ env: {}, filePath });
    expect(first.source).toBe('file');
    expect(first.secret.length).toBeGreaterThanOrEqual(32);

    // Simulate a fresh process: reset the in-memory cache so the second call
    // can only get the same value by actually reading it back off disk --
    // proving persistence, not just a cache hit.
    __resetSessionSecretCache();
    const second = resolveSessionSecret({ env: {}, filePath });
    expect(second.secret).toBe(first.secret);
    expect(second.source).toBe('file');
  });

  it('persists the generated key with owner-only permissions', () => {
    resolveSessionSecret({ env: {}, filePath: path() });
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      path(),
      expect.any(String),
      expect.objectContaining({ mode: 0o600 }),
    );
  });

  it('reuses an existing file verbatim instead of regenerating', () => {
    const filePath = path();
    const existing = 'z'.repeat(44); // a plausible base64url-encoded 32-byte key
    writeFileSync(filePath, existing);
    mockedWriteFileSync.mockClear();

    const resolved = resolveSessionSecret({ env: {}, filePath });
    expect(resolved).toEqual({ secret: existing, source: 'file' });
    // Reading back an already-valid file must never trigger a rewrite.
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it('prefers a valid env SESSION_SECRET over the persisted file, and never touches it', () => {
    const filePath = path();
    writeFileSync(filePath, 'f'.repeat(44));
    mockedWriteFileSync.mockClear();

    const envSecret = 'e'.repeat(40);
    const resolved = resolveSessionSecret({ env: { SESSION_SECRET: envSecret }, filePath });
    expect(resolved).toEqual({ secret: envSecret, source: 'env' });
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    // The file on disk is untouched -- still whatever was there before.
    expect(readFileSync(filePath, 'utf8')).toBe('f'.repeat(44));
  });

  it('ignores an env SESSION_SECRET shorter than 32 characters and falls back to the file', () => {
    const resolved = resolveSessionSecret({ env: { SESSION_SECRET: 'short' }, filePath: path() });
    expect(resolved.source).toBe('file');
    expect(resolved.secret).not.toBe('short');
  });

  it("falls back to an ephemeral in-memory key, without throwing, when the file can't be written", () => {
    state.throwOnWrite = true;
    const filePath = path();
    let resolved: ReturnType<typeof resolveSessionSecret> | undefined;
    expect(() => {
      resolved = resolveSessionSecret({ env: {}, filePath });
    }).not.toThrow();
    expect(resolved?.source).toBe('ephemeral');
    expect(resolved?.secret.length).toBeGreaterThanOrEqual(32);
  });

  it('caches the ephemeral fallback so every call in the process gets the SAME key', () => {
    state.throwOnWrite = true;
    const filePath = path();
    const first = resolveSessionSecret({ env: {}, filePath });
    const second = resolveSessionSecret({ env: {}, filePath });
    expect(second).toBe(first); // same cached object, not just an equal value
  });

  it('resolves once per process: a later call with different overrides still returns the cached result', () => {
    const first = resolveSessionSecret({ env: { SESSION_SECRET: 'a'.repeat(32) }, filePath: path() });
    const second = resolveSessionSecret({ env: { SESSION_SECRET: 'b'.repeat(32) }, filePath: path() });
    expect(second).toBe(first);
  });
});
