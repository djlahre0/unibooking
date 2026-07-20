import { describe, it, expect, beforeEach } from 'vitest';
import {
  STORAGE_KEY,
  loadState,
  saveProvider,
  clearProvider,
  clearAll,
  setRemember,
  storageAvailable,
} from './cred-storage';

/** Minimal in-memory Storage — vitest runs in node, where localStorage is absent. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

/** A Storage that throws on every access, like Safari private mode. */
function hostileStorage(): Storage {
  const boom = () => {
    throw new DOMException('denied', 'SecurityError');
  };
  return {
    get length(): number {
      return boom();
    },
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  } as unknown as Storage;
}

/** A Storage whose setItem succeeds but whose removeItem always throws. */
function removeItemThrowsStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: () => {
      throw new DOMException('denied', 'SecurityError');
    },
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

let s: Storage;
beforeEach(() => {
  s = fakeStorage();
});

describe('loadState', () => {
  it('returns empty state when nothing is stored', () => {
    expect(loadState(s)).toEqual({ remember: false, providers: {} });
  });

  it('discards corrupt JSON rather than throwing', () => {
    const bad = fakeStorage({ [STORAGE_KEY]: '{not json' });
    expect(loadState(bad)).toEqual({ remember: false, providers: {} });
  });

  it('discards a structurally wrong payload', () => {
    const bad = fakeStorage({ [STORAGE_KEY]: '["an","array"]' });
    expect(loadState(bad)).toEqual({ remember: false, providers: {} });
  });

  it('degrades to empty state when storage throws', () => {
    expect(loadState(hostileStorage())).toEqual({ remember: false, providers: {} });
  });

  it('does not share a providers reference across separate empty loads', () => {
    // Regression: loadState used to return `{ ...EMPTY }`, a shallow copy that
    // aliased the same module-level `providers` object on every empty/failure path.
    const a = loadState(fakeStorage());
    const b = loadState(fakeStorage());
    expect(a.providers).not.toBe(b.providers);
    a.providers.square = { creds: { accessToken: 'leaked' }, env: 'prod' };
    expect(b.providers).toEqual({});
  });

  it('drops a provider entry that is not an object', () => {
    const bad = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({
        remember: true,
        providers: { square: 'not-an-object' },
      }),
    });
    expect(loadState(bad)).toEqual({ remember: true, providers: {} });
  });

  it('drops a provider entry missing creds', () => {
    const bad = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({
        remember: true,
        providers: { square: { env: 'prod' } },
      }),
    });
    expect(loadState(bad)).toEqual({ remember: true, providers: {} });
  });

  it('drops a provider entry whose env is not a string', () => {
    const bad = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({
        remember: true,
        providers: { square: { creds: { accessToken: 'a' }, env: 42 } },
      }),
    });
    expect(loadState(bad)).toEqual({ remember: true, providers: {} });
  });

  it('drops only the corrupt entry, keeping valid siblings', () => {
    const mixed = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({
        remember: true,
        providers: {
          square: 'not-an-object',
          acuity: { creds: { apiKey: 'b' }, env: 'prod' },
        },
      }),
    });
    expect(loadState(mixed)).toEqual({
      remember: true,
      providers: { acuity: { creds: { apiKey: 'b' }, env: 'prod' } },
    });
  });
});

describe('saveProvider', () => {
  it('round-trips a provider entry', () => {
    setRemember(true, s);
    saveProvider('square', { creds: { accessToken: 'tok' }, env: 'sandbox' }, s);
    expect(loadState(s).providers.square).toEqual({
      creds: { accessToken: 'tok' },
      env: 'sandbox',
    });
  });

  it('keeps providers isolated from each other', () => {
    setRemember(true, s);
    saveProvider('square', { creds: { accessToken: 'a' }, env: 'prod' }, s);
    saveProvider('acuity', { creds: { apiKey: 'b' }, env: 'prod' }, s);
    const st = loadState(s);
    expect(st.providers.square.creds.accessToken).toBe('a');
    expect(st.providers.acuity.creds.apiKey).toBe('b');
  });

  it('persists a custom baseUrl alongside the creds', () => {
    setRemember(true, s);
    saveProvider(
      'phorest',
      { creds: { username: 'u' }, env: 'us-aus', baseUrl: 'https://platform-us.phorest.com/x/' },
      s,
    );
    expect(loadState(s).providers.phorest.baseUrl).toBe('https://platform-us.phorest.com/x/');
  });

  it('does not write when remember is off', () => {
    // The opt-in is a real gate, not just a UI affordance.
    saveProvider('square', { creds: { accessToken: 'tok' }, env: 'prod' }, s);
    expect(loadState(s).providers.square).toBeUndefined();
  });

  it('does not throw when the write itself throws', () => {
    // remember must already be true in the *stored* state — using hostileStorage
    // here would make getItem throw too, so loadState would report
    // remember: false and saveProvider would short-circuit before ever calling
    // write(), passing even if write()'s try/catch were deleted.
    const seeded = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({ remember: true, providers: {} }),
    });
    const throwsOnWrite: Storage = {
      ...seeded,
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    expect(() =>
      saveProvider('square', { creds: { a: 'b' }, env: 'prod' }, throwsOnWrite),
    ).not.toThrow();
  });
});

describe('clearProvider', () => {
  it('removes one provider and leaves the rest', () => {
    setRemember(true, s);
    saveProvider('square', { creds: { accessToken: 'a' }, env: 'prod' }, s);
    saveProvider('acuity', { creds: { apiKey: 'b' }, env: 'prod' }, s);
    clearProvider('square', s);
    const st = loadState(s);
    expect(st.providers.square).toBeUndefined();
    expect(st.providers.acuity).toBeDefined();
  });

  it('does not throw when storage throws', () => {
    expect(() => clearProvider('square', hostileStorage())).not.toThrow();
  });
});

describe('clearAll', () => {
  it('removes every provider but keeps the remember preference', () => {
    setRemember(true, s);
    saveProvider('square', { creds: { accessToken: 'a' }, env: 'prod' }, s);
    clearAll(s);
    const st = loadState(s);
    expect(st.providers).toEqual({});
    expect(st.remember).toBe(true);
  });

  it('does not throw when storage throws', () => {
    expect(() => clearAll(hostileStorage())).not.toThrow();
  });
});

describe('storageAvailable', () => {
  it('is true for a working store', () => {
    expect(storageAvailable(s)).toBe(true);
  });

  it('is false when the store throws', () => {
    // Safari private mode and policy-disabled storage both look like this.
    expect(storageAvailable(hostileStorage())).toBe(false);
  });

  it('leaves no probe key behind', () => {
    storageAvailable(s);
    expect(s.length).toBe(0);
  });

  it('returns a boolean and does not throw when removeItem throws after a successful setItem', () => {
    let result: boolean | undefined;
    expect(() => {
      result = storageAvailable(removeItemThrowsStorage());
    }).not.toThrow();
    expect(result).toBe(true);
  });
});

describe('setRemember', () => {
  it('wipes persisted credentials when turned off', () => {
    // Revoking consent must delete the data, not merely stop future writes.
    setRemember(true, s);
    saveProvider('square', { creds: { accessToken: 'a' }, env: 'prod' }, s);
    const after = setRemember(false, s);
    expect(after.remember).toBe(false);
    expect(after.providers).toEqual({});
    expect(loadState(s).providers).toEqual({});
  });

  it('returns the resulting state', () => {
    expect(setRemember(true, s)).toEqual({ remember: true, providers: {} });
  });

  it('does not throw when storage throws', () => {
    expect(() => setRemember(true, hostileStorage())).not.toThrow();
  });
});
