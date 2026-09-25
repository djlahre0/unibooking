import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OAuthProvider } from './types';

/**
 * The operator's own Google/Microsoft OAuth app registrations — SERVER ONLY,
 * and never returned to any page (see status/route.ts and the setup route:
 * a status endpoint may report only WHETHER a provider is configured).
 *
 * One app, configured once by whoever runs this deployment, used by every
 * later visitor who signs in with "Continue with Google/Microsoft" — the
 * standard OAuth model, replacing the old per-visitor "bring your own app"
 * paste flow (see CustomAppForm.tsx and connect/[provider]/route.ts's own
 * doc comment on why that POST endpoint is kept working regardless: it's a
 * different, still-supported code path, not this one).
 *
 * Persistence mirrors `./secret.ts` exactly (read once and cache; owner-only
 * file permissions; a read-only filesystem degrades to "not saved" instead of
 * throwing) — see that module's doc comment for the full rationale. The two
 * are separate files (default `demo/.oauth-apps.json` vs `demo/.session-secret`)
 * so a deployment that can't persist one can still persist the other.
 */

export interface StoredOAuthApp {
  clientId: string;
  clientSecret: string;
  /** Microsoft only — the operator's Entra app may be restricted to one
   *  directory. Absent means Microsoft's own `common` default applies. */
  tenant?: string;
}

export type OAuthApps = Partial<Record<OAuthProvider, StoredOAuthApp>>;

export interface OAuthAppsOverrides {
  filePath?: string;
}

const DEFAULT_PATH = (): string => join(process.cwd(), '.oauth-apps.json');

let cached: OAuthApps | undefined;

/** Read the persisted apps, or an empty set if the file doesn't exist yet or
 *  is unreadable/corrupt. Never throws — this is read on every status check,
 *  so a bad file must degrade to "nothing configured" rather than 500 the
 *  whole tab. */
function fromFile(filePath: string): OAuthApps {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as OAuthApps) : {};
  } catch {
    return {};
  }
}

/** The operator's saved apps for this process. Resolved once and cached —
 *  same rationale as `resolveSessionSecret`: re-reading the file on every
 *  request is unnecessary, and a write (below) keeps the cache in sync within
 *  this process so a save is visible to the very next status check. Tests
 *  that need an independent resolution call `__resetOAuthAppsCache()` first
 *  and pass their own `filePath` override so they never touch this project's
 *  real `.oauth-apps.json`. */
export function readOAuthApps(overrides: OAuthAppsOverrides = {}): OAuthApps {
  if (cached) return cached;
  cached = fromFile(overrides.filePath ?? DEFAULT_PATH());
  return cached;
}

/** Persists one provider's app, merged with whatever else is already stored.
 *  Returns false (never throws) on a read-only filesystem — the setup route
 *  turns that into an ordinary error response instead of a 500 crash. */
export function writeOAuthApp(
  provider: OAuthProvider,
  app: StoredOAuthApp,
  overrides: OAuthAppsOverrides = {},
): boolean {
  const filePath = overrides.filePath ?? DEFAULT_PATH();
  const next: OAuthApps = { ...readOAuthApps(overrides), [provider]: app };
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    // Owner read/write only — a real secret lives in this file.
    writeFileSync(filePath, JSON.stringify(next, null, 2), { mode: 0o600 });
    cached = next;
    return true;
  } catch {
    return false;
  }
}

/** Removes one provider's app, leaving any other provider's untouched, so the
 *  operator can register a different client id/secret without hand-editing
 *  the file. Returns false (never throws) on a read-only filesystem, exactly
 *  like `writeOAuthApp` — the caller turns that into an ordinary error
 *  response rather than a 500.
 *
 *  Removing the last entry rewrites `{}` rather than unlinking the file: the
 *  file's existence is not what makes a provider configured (`readOAuthApps`
 *  treats a missing and an empty file identically), and keeping it preserves
 *  the 0600 mode for the next write. */
export function removeOAuthApp(
  provider: OAuthProvider,
  overrides: OAuthAppsOverrides = {},
): boolean {
  const filePath = overrides.filePath ?? DEFAULT_PATH();
  const next: OAuthApps = { ...readOAuthApps(overrides) };
  delete next[provider];
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(next, null, 2), { mode: 0o600 });
    cached = next;
    return true;
  } catch {
    return false;
  }
}

/** Test hook — clears the cached resolution so the next call re-resolves
 *  from scratch. Mirrors `__resetSessionSecretCache` in ./secret.ts. */
export function __resetOAuthAppsCache(): void {
  cached = undefined;
}
