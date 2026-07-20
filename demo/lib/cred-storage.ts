/**
 * Opt-in credential persistence for the demo's Connect tab.
 *
 * Everything lives under ONE versioned key so writes are atomic, clear-all is a
 * single removeItem, and a future shape change can be discarded wholesale
 * instead of crashing on stale JSON.
 *
 * `storage` is injectable because vitest runs in the node environment, where
 * localStorage does not exist — the same idiom the library uses for `fetch`.
 *
 * SECURITY: localStorage is readable by any script on this origin. That is the
 * accepted cost of the feature; the opt-in default and the UI's warning banner
 * are the mitigation, not encryption (a passphrase-derived key stored in the
 * same browser as the ciphertext would be theatre).
 */
export const STORAGE_KEY = 'unibooking:demo:v1';

export type SavedProvider = {
  creds: Record<string, string>;
  /** 'prod' | 'sandbox' | a region key | 'custom' */
  env: string;
  /** Present for region and custom selections. */
  baseUrl?: string;
};

export type SavedState = {
  remember: boolean;
  providers: Record<string, SavedProvider>;
};

/** A fresh empty state, never shared — callers may mutate `.providers` freely. */
function emptyState(): SavedState {
  return { remember: false, providers: {} };
}

/** Resolve the store, tolerating SSR and environments without localStorage. */
function resolve(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Structural shape only; `providers` entries are validated individually below. */
function isState(v: unknown): v is { remember: boolean; providers: Record<string, unknown> } {
  return isPlainObject(v) && typeof v.remember === 'boolean' && isPlainObject(v.providers);
}

/** A provider entry parsed from localStorage — attacker-influenceable, so checked field-by-field. */
function isSavedProvider(v: unknown): v is SavedProvider {
  return isPlainObject(v) && isPlainObject(v.creds) && typeof v.env === 'string';
}

/** Never throws. Any failure — absent, corrupt, blocked — yields empty state. */
export function loadState(storage?: Storage): SavedState {
  const s = resolve(storage);
  if (!s) return emptyState();
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed: unknown = JSON.parse(raw);
    if (!isState(parsed)) return emptyState();
    // Drop individually-corrupt provider entries rather than wiping everything.
    const providers: Record<string, SavedProvider> = {};
    for (const [name, entry] of Object.entries(parsed.providers)) {
      if (isSavedProvider(entry)) providers[name] = entry;
    }
    return { remember: parsed.remember, providers };
  } catch {
    return emptyState();
  }
}

/** Never throws; a blocked store silently degrades to in-memory-only. */
function write(state: SavedState, storage?: Storage): void {
  const s = resolve(storage);
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded or storage disabled — the UI keeps working in memory.
  }
}

export function saveProvider(provider: string, data: SavedProvider, storage?: Storage): void {
  const state = loadState(storage);
  if (!state.remember) return; // The opt-in is a real gate.
  state.providers[provider] = data;
  write(state, storage);
}

export function clearProvider(provider: string, storage?: Storage): void {
  const state = loadState(storage);
  delete state.providers[provider];
  write(state, storage);
}

export function clearAll(storage?: Storage): void {
  const state = loadState(storage);
  state.providers = {};
  write(state, storage);
}

/**
 * Whether persistence can actually work here. The UI uses this to warn that
 * "Remember" will not survive a reload rather than silently doing nothing.
 * Probes with a real write because Safari private mode exposes a localStorage
 * object that throws only on setItem.
 */
export function storageAvailable(storage?: Storage): boolean {
  const s = resolve(storage);
  if (!s) return false;
  const probe = `${STORAGE_KEY}:probe`;
  try {
    s.setItem(probe, '1');
    return true;
  } catch {
    return false;
  } finally {
    // Best-effort cleanup — a throwing removeItem must not mask the result above.
    try {
      s.removeItem(probe);
    } catch {
      // Nothing more we can do; the probe key may linger.
    }
  }
}

/** Turning remember OFF deletes what was already saved, not just future writes. */
export function setRemember(on: boolean, storage?: Storage): SavedState {
  const state = loadState(storage);
  state.remember = on;
  if (!on) state.providers = {};
  write(state, storage);
  return state;
}
