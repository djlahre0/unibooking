/**
 * Demo UI state: what you were doing, so a reload does not throw it away.
 *
 * SECURITY: this store NEVER holds a credential, token or secret. Those live
 * in cred-storage.ts behind its opt-in toggle. `PersistedForm` enforces that
 * at the source by refusing to serialize password/file controls, and the
 * webhook tab persists only its provider selection, never its HMAC fields.
 *
 * `storage` is injectable because vitest runs in the node environment, where
 * localStorage does not exist: the same idiom as cred-storage.ts and
 * sample/store.ts.
 */
export const UI_KEY = 'unibooking:demo:ui:v1';

/** Results are the only unbounded field; one larger than this is not stored. */
export const RESULT_MAX_BYTES = 64 * 1024;
export const TOO_LARGE = '__unibooking_result_too_large__';

export type Theme = 'system' | 'light' | 'dark';
export type SavedResult = { at: string; json: string };

export interface UiState {
  version: 1;
  activeTab: string;
  selectedProvider: string;
  env: string;
  baseUrl: string;
  /** Keyed "<tab>:<op>": a tab can hold several mutually exclusive forms. */
  forms: Record<string, Record<string, string>>;
  /** The webhook tab's PROVIDER only. Its fields are HMAC secrets; see R1. */
  webhookProvider: string;
  /** Keyed by tab. */
  results: Record<string, SavedResult>;
  theme: Theme;
}

export function defaultUiState(): UiState {
  return {
    version: 1,
    activeTab: 'connect',
    selectedProvider: '',
    env: 'prod',
    baseUrl: '',
    forms: {},
    webhookProvider: 'square',
    results: {},
    theme: 'system',
  };
}

/**
 * Cached parse, scoped to the Storage that produced it. `useSyncExternalStore`
 * requires a referentially stable snapshot or it re-renders forever, and the
 * scoping stops one Storage inheriting another's data (the Critical finding
 * from plan 1's Task 2).
 */
let cache: { store: Storage | null; state: UiState } | null = null;
/** Set once a write fails even after dropping results: degrade, never throw. */
let disabled = false;
const listeners = new Set<() => void>();
let storageBound = false;

/** Tests only: drops the cache, the disabled flag and the listener set. */
export function __resetUiState(): void {
  cache = null;
  disabled = false;
  listeners.clear();
}

export function persistenceEnabled(): boolean {
  return !disabled;
}

function resolve(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringMap(v: unknown): v is Record<string, string> {
  return isRecord(v) && Object.values(v).every((x) => typeof x === 'string');
}

function isSavedResult(v: unknown): v is SavedResult {
  return isRecord(v) && typeof v.at === 'string' && typeof v.json === 'string';
}

function isTheme(v: unknown): v is Theme {
  return v === 'system' || v === 'light' || v === 'dark';
}

/**
 * Field-by-field, because anything in localStorage is attacker-influenceable.
 * An unknown version is discarded wholesale; individually corrupt `forms` and
 * `results` entries are dropped without losing the rest.
 */
function parse(raw: string): UiState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1) return null;
  const base = defaultUiState();
  const forms: UiState['forms'] = {};
  if (isRecord(value.forms)) {
    for (const [key, entry] of Object.entries(value.forms)) {
      if (isStringMap(entry)) forms[key] = { ...entry };
    }
  }
  const results: UiState['results'] = {};
  if (isRecord(value.results)) {
    for (const [key, entry] of Object.entries(value.results)) {
      if (isSavedResult(entry)) results[key] = { at: entry.at, json: entry.json };
    }
  }
  return {
    version: 1,
    activeTab: typeof value.activeTab === 'string' ? value.activeTab : base.activeTab,
    selectedProvider:
      typeof value.selectedProvider === 'string' ? value.selectedProvider : base.selectedProvider,
    env: typeof value.env === 'string' ? value.env : base.env,
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : base.baseUrl,
    forms,
    webhookProvider:
      typeof value.webhookProvider === 'string' ? value.webhookProvider : base.webhookProvider,
    results,
    theme: isTheme(value.theme) ? value.theme : base.theme,
  };
}

export function loadUiState(storage?: Storage): UiState {
  const store = resolve(storage);
  if (cache && cache.store === store) return cache.state;
  let state = defaultUiState();
  if (store) {
    try {
      const raw = store.getItem(UI_KEY);
      if (raw) state = parse(raw) ?? state;
    } catch {
      // A throwing storage reads as "nothing saved".
    }
  }
  cache = { store, state };
  return state;
}

/**
 * Writes, degrading instead of throwing. Results are the only unbounded field,
 * so a quota failure drops them and retries once; if that still fails,
 * persistence is off for the session and the UI says so.
 * Returns the state actually persisted, which may have had results dropped.
 */
function write(next: UiState, store: Storage | null): UiState {
  if (!store || disabled) return next;
  const attempt = (state: UiState): boolean => {
    try {
      store.setItem(UI_KEY, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  };
  if (attempt(next)) return next;
  const trimmed: UiState = { ...next, results: {} };
  if (attempt(trimmed)) return trimmed;
  disabled = true;
  return next;
}

export function patchUiState(patch: Partial<UiState>, storage?: Storage): void {
  const store = resolve(storage);
  const next: UiState = { ...loadUiState(storage), ...patch, version: 1 };
  const persisted = write(next, store);
  // Keep the new state in memory even when nothing could be written, so the
  // session keeps working; it just will not survive a reload.
  cache = { store, state: persisted };
  notify();
}

export function clearUiState(storage?: Storage): void {
  const store = resolve(storage);
  try {
    store?.removeItem(UI_KEY);
  } catch {
    // Nothing more to do; the cache reset below still takes effect.
  }
  cache = { store, state: defaultUiState() };
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Local writes notify directly; the browser's `storage` event covers OTHER
 * tabs (it never fires in the tab that wrote). A null `key` means the whole
 * store was cleared, which also invalidates us.
 */
export function subscribeUiState(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageBound && typeof window !== 'undefined') {
    storageBound = true;
    window.addEventListener('storage', (e: StorageEvent) => {
      if (e.key !== null && e.key !== UI_KEY) return;
      cache = null; // force a re-read on the next snapshot
      notify();
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The server render has no localStorage, so it must not read one. A frozen
 * module-level default keeps the reference stable across calls.
 */
const SERVER_SNAPSHOT: UiState = Object.freeze(defaultUiState()) as UiState;
export function getServerUiSnapshot(): UiState {
  return SERVER_SNAPSHOT;
}

export function resultForStorage(json: string, now: () => Date = () => new Date()): SavedResult {
  const at = now().toISOString();
  // Bytes, not `.length`: this is a storage budget, and one non-ASCII
  // character is up to 4 bytes but as little as 1 UTF-16 code unit.
  const bytes = new TextEncoder().encode(json).length;
  return { at, json: bytes > RESULT_MAX_BYTES ? TOO_LARGE : json };
}

export function isTooLarge(r: SavedResult): boolean {
  return r.json === TOO_LARGE;
}
