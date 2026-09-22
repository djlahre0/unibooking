import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Resolves the key that seals My Calendar's cookies — SERVER ONLY.
 *
 * The demo needs zero environment variables to run. Precedence:
 *
 *   1. `process.env.SESSION_SECRET`, if set and >= 32 chars. An optional
 *      override, kept for multi-instance hosting: every instance must derive
 *      the SAME key, and a generated-per-instance key (path 2 below) can't
 *      guarantee that on a platform with a read-only filesystem and many
 *      short-lived instances (see demo/README.md's serverless caveat).
 *   2. A key persisted at `filePath` (default `demo/.session-secret`, which
 *      is git-ignored — see .gitignore before this file ever writes to it).
 *      Read it back if it already exists; otherwise generate 32 random bytes
 *      and write them there with owner-only permissions, so this process and
 *      every later one reuse the SAME key instead of signing everyone out on
 *      every restart.
 *   3. If the filesystem can't be read or written (serverless, read-only —
 *      or just a transient error), generate an in-memory key for this
 *      process only and mark it `ephemeral`. A transient fault must not
 *      crash the request, so every fs call here is wrapped and falls
 *      through rather than throwing.
 *
 * Resolved once per process and cached: regenerating per request would seal
 * each new cookie under a different key than the one before it, silently
 * invalidating every session. The cache is unconditional (matches
 * `__resetRateLimit`'s pattern elsewhere in this app) — tests that need an
 * independent resolution call `__resetSessionSecretCache()` first and pass
 * their own `filePath` override so they never touch this project's real
 * `.session-secret` file.
 */

const MIN_SECRET = 32;
const DEFAULT_PATH = (): string => join(process.cwd(), '.session-secret');

export interface ResolvedSecret {
  secret: string;
  source: 'env' | 'file' | 'ephemeral';
}

export interface SecretOverrides {
  env?: Record<string, string | undefined>;
  filePath?: string;
}

let cached: ResolvedSecret | undefined;

/** Read the persisted key, or generate + persist one. Never throws — a
 *  write failure (read-only fs) degrades to an in-memory key instead of
 *  failing the request. */
function fromFile(filePath: string): ResolvedSecret {
  try {
    const existing = readFileSync(filePath, 'utf8').trim();
    if (existing.length >= MIN_SECRET) return { secret: existing, source: 'file' };
    // A shorter-than-expected file is treated as absent/corrupt and
    // regenerated below, rather than sealing cookies under a weak key.
  } catch {
    // Doesn't exist yet (first run) or unreadable — fall through and create it.
  }

  // Never logged, never returned in any response — this is a real secret.
  const generated = randomBytes(32).toString('base64url');
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    // Owner read/write only: the key must not be world-readable on a shared host.
    writeFileSync(filePath, generated, { mode: 0o600 });
    return { secret: generated, source: 'file' };
  } catch {
    return { secret: generated, source: 'ephemeral' };
  }
}

/** The cookie-sealing key for this process. See the module doc comment for
 *  precedence and the caching rationale. */
export function resolveSessionSecret(overrides: SecretOverrides = {}): ResolvedSecret {
  if (cached) return cached;

  const env = overrides.env ?? process.env;
  const filePath = overrides.filePath ?? DEFAULT_PATH();
  const fromEnv = env.SESSION_SECRET?.trim();

  cached =
    fromEnv && fromEnv.length >= MIN_SECRET ? { secret: fromEnv, source: 'env' } : fromFile(filePath);
  return cached;
}

/** Test hook — clears the cached resolution so the next call re-resolves
 *  from scratch. Mirrors `__resetRateLimit` in lib/rate-limit.ts. */
export function __resetSessionSecretCache(): void {
  cached = undefined;
}
