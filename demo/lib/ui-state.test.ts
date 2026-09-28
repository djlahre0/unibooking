import { describe, it, expect, beforeEach } from 'vitest';
import {
  UI_KEY,
  TOO_LARGE,
  RESULT_MAX_BYTES,
  defaultUiState,
  loadUiState,
  patchUiState,
  clearUiState,
  subscribeUiState,
  persistenceEnabled,
  resultForStorage,
  isTooLarge,
  __resetUiState,
} from './ui-state';

/** A minimal in-memory Storage; `failOn` makes setItem throw like a full quota. */
function memStorage(failOn?: (key: string, value: string) => boolean): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failOn?.(k, v)) {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
  } as Storage;
}

beforeEach(() => {
  __resetUiState();
});

describe('ui-state', () => {
  it('returns defaults when nothing is stored', () => {
    const s = memStorage();
    expect(loadUiState(s)).toEqual(defaultUiState());
  });

  it('round-trips a patch through storage', () => {
    const s = memStorage();
    patchUiState({ activeTab: 'bookings', selectedProvider: 'sample' }, s);
    __resetUiState(); // drop the cache so this re-reads from storage
    const loaded = loadUiState(s);
    expect(loaded.activeTab).toBe('bookings');
    expect(loaded.selectedProvider).toBe('sample');
    expect(loaded.version).toBe(1);
  });

  it('returns a referentially stable snapshot (useSyncExternalStore requires it)', () => {
    const s = memStorage();
    expect(loadUiState(s)).toBe(loadUiState(s));
  });

  it('gives a NEW reference after a patch, so React re-renders', () => {
    const s = memStorage();
    const before = loadUiState(s);
    patchUiState({ activeTab: 'catalog' }, s);
    expect(loadUiState(s)).not.toBe(before);
  });

  it('discards corrupt JSON and a wrong-shaped payload', () => {
    const bad = memStorage();
    bad.setItem(UI_KEY, '{not json');
    expect(loadUiState(bad)).toEqual(defaultUiState());
    __resetUiState();
    const wrong = memStorage();
    wrong.setItem(UI_KEY, JSON.stringify({ version: 99 }));
    expect(loadUiState(wrong)).toEqual(defaultUiState());
  });

  it('drops individually corrupt form entries instead of wiping everything', () => {
    const s = memStorage();
    s.setItem(
      UI_KEY,
      JSON.stringify({
        ...defaultUiState(),
        forms: { 'bookings:create': { title: 'ok' }, 'bad:one': { n: 5 }, 'bad:two': 'nope' },
      }),
    );
    const loaded = loadUiState(s);
    expect(loaded.forms['bookings:create']).toEqual({ title: 'ok' });
    expect(loaded.forms['bad:one']).toBeUndefined();
    expect(loaded.forms['bad:two']).toBeUndefined();
  });

  it('stores an oversized result as a marker, not as its JSON', () => {
    const big = 'x'.repeat(RESULT_MAX_BYTES + 1);
    const r = resultForStorage(big);
    expect(r.json).toBe(TOO_LARGE);
    expect(isTooLarge(r)).toBe(true);
    const small = resultForStorage('{"ok":true}');
    expect(small.json).toBe('{"ok":true}');
    expect(isTooLarge(small)).toBe(false);
  });

  it('measures the 64KB cap in BYTES, not UTF-16 code units', () => {
    // 'é' is 1 code unit but 2 UTF-8 bytes, so this is under the cap by
    // .length and over it by byte count. The cap is a storage budget.
    const s = 'é'.repeat(RESULT_MAX_BYTES / 2 + 1);
    expect(s.length).toBeLessThan(RESULT_MAX_BYTES);
    expect(resultForStorage(s).json).toBe(TOO_LARGE);
  });

  it('on quota failure drops saved results and retries once', () => {
    // Fail only while the payload still carries results.
    const s = memStorage((_k, v) => v.includes('"results":{"bookings"'));
    patchUiState({ results: { bookings: { at: 'now', json: '{"a":1}' } } }, s);
    expect(persistenceEnabled()).toBe(true);
    const persisted = JSON.parse(s.getItem(UI_KEY)!);
    expect(persisted.results).toEqual({});
  });

  it('disables persistence for the session when even the trimmed retry fails', () => {
    const s = memStorage(() => true);
    patchUiState({ activeTab: 'bookings' }, s);
    expect(persistenceEnabled()).toBe(false);
    expect(s.getItem(UI_KEY)).toBeNull();
    // The UI still works for this session, from memory.
    expect(loadUiState(s).activeTab).toBe('bookings');
  });

  it('keeps working with no storage at all (SSR / blocked)', () => {
    patchUiState({ activeTab: 'catalog' }, undefined);
    expect(loadUiState(undefined).activeTab).toBe('catalog');
  });

  it('scopes its in-memory fallback to the Storage that produced it', () => {
    // The plan-1 Task 2 Critical finding: unscoped module state hands one
    // caller's data to an unrelated Storage.
    const a = memStorage(() => true);
    patchUiState({ selectedProvider: 'square' }, a);
    const b = memStorage();
    expect(loadUiState(b)).toEqual(defaultUiState());
  });

  it('notifies subscribers on a patch and stops after unsubscribe', () => {
    const s = memStorage();
    let calls = 0;
    const off = subscribeUiState(() => {
      calls++;
    });
    patchUiState({ activeTab: 'bookings' }, s);
    expect(calls).toBe(1);
    off();
    patchUiState({ activeTab: 'catalog' }, s);
    expect(calls).toBe(1);
  });

  it('clearUiState removes the key and returns to defaults', () => {
    const s = memStorage();
    patchUiState({ activeTab: 'bookings' }, s);
    clearUiState(s);
    expect(s.getItem(UI_KEY)).toBeNull();
    expect(loadUiState(s)).toEqual(defaultUiState());
  });

  it('never persists a field it does not declare', () => {
    const s = memStorage();
    patchUiState({ activeTab: 'bookings' }, s);
    const keys = Object.keys(JSON.parse(s.getItem(UI_KEY)!)).sort();
    expect(keys).toEqual([
      'activeTab',
      'baseUrl',
      'env',
      'forms',
      'results',
      'selectedProvider',
      'theme',
      'version',
      'webhookProvider',
    ]);
  });
});
