import { describe, it, expect, beforeEach } from 'vitest';
import { loadSample, saveSample, resetSample, SAMPLE_KEY } from './store';
import { buildSeed } from './seed';

/** Minimal in-memory Storage, the same shape cred-storage.test.ts uses. */
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

function throwingStorage(): Storage {
  return {
    ...fakeStorage(),
    getItem: () => {
      throw new DOMException('blocked', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('blocked', 'SecurityError');
    },
  } as Storage;
}

describe('sample store', () => {
  let storage: Storage;
  beforeEach(() => {
    storage = fakeStorage();
  });

  it('seeds on first use and writes it back', () => {
    const data = loadSample(storage);
    expect(data.bookings.length).toBeGreaterThan(0);
    expect(storage.getItem(SAMPLE_KEY)).not.toBeNull();
  });

  it('returns the same dataset on the next load', () => {
    const first = loadSample(storage);
    expect(loadSample(storage)).toEqual(first);
  });

  it('round-trips a mutation', () => {
    const data = loadSample(storage);
    data.bookings[0]!.title = 'Edited';
    saveSample(data, storage);
    expect(loadSample(storage).bookings[0]!.title).toBe('Edited');
  });

  it('does not leak the in-memory fallback across independent storages', () => {
    const storageA = fakeStorage();
    const storageB = fakeStorage();

    const dataA = loadSample(storageA);
    dataA.bookings[0]!.title = 'From A';
    saveSample(dataA, storageA);

    // A brand-new, unrelated storage must seed and persist on its own, not
    // inherit whatever another Storage instance last put in module memory.
    const dataB = loadSample(storageB);
    expect(dataB.bookings[0]!.title).not.toBe('From A');
    expect(storageB.getItem(SAMPLE_KEY)).not.toBeNull();
  });

  it('re-seeds over corrupt JSON instead of throwing', () => {
    storage.setItem(SAMPLE_KEY, '{not json');
    expect(() => loadSample(storage)).not.toThrow();
    expect(loadSample(storage).bookings.length).toBeGreaterThan(0);
  });

  it('re-seeds when the stored shape is wrong', () => {
    storage.setItem(SAMPLE_KEY, JSON.stringify({ version: 99, bookings: 'nope' }));
    expect(loadSample(storage).version).toBe(1);
  });

  it('re-seeds when an element in the payload is structurally wrong', () => {
    // Top-level shape checks alone let a lone `{}` through; bookings, staff,
    // services and customers each need their own one-level check.
    const seeded = loadSample(storage);
    storage.setItem(
      SAMPLE_KEY,
      JSON.stringify({ ...seeded, bookings: [{}, ...seeded.bookings.slice(1)] }),
    );
    const reloaded = loadSample(storage);
    expect(reloaded.bookings.every((b) => typeof b.id === 'string')).toBe(true);
    expect(reloaded).toEqual(seeded);
  });

  it('falls back to memory when storage throws, without losing writes', () => {
    const blocked = throwingStorage();
    const data = loadSample(blocked);
    data.bookings[0]!.title = 'In memory';
    saveSample(data, blocked);
    expect(loadSample(blocked).bookings[0]!.title).toBe('In memory');
  });

  it('re-anchors to the day it is reset on', () => {
    loadSample(storage);
    const reset = resetSample('2026-12-25', 'America/New_York', storage);
    expect(reset.seededAt).toBe('2026-12-25');
    expect(loadSample(storage).seededAt).toBe('2026-12-25');
  });

  it('discards edits on reset', () => {
    const data = loadSample(storage);
    data.bookings = [];
    saveSample(data, storage);
    expect(resetSample('2026-12-25', 'America/New_York', storage).bookings.length).toBeGreaterThan(
      0,
    );
  });

  it('stores what buildSeed produced, unchanged', () => {
    const seeded = resetSample('2026-09-20', 'America/New_York', storage);
    expect(seeded).toEqual(buildSeed('2026-09-20', 'America/New_York'));
  });
});
