import { describe, it, expect, beforeEach } from 'vitest';
import { isUnibookingError } from 'unibooking';
import { sampleClient } from './client';
import { armFailure } from './failure';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
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

const YEAR = { start: '2020-01-01T00:00:00Z', end: '2030-01-01T00:00:00Z' };

describe('sampleClient listBookings', () => {
  let client: ReturnType<typeof sampleClient>;
  beforeEach(() => {
    armFailure(null);
    client = sampleClient({ storage: fakeStorage(), latencyMs: 0 });
  });

  it('returns the seeded bookings sorted by start', async () => {
    const { bookings } = await client.listBookings({ range: YEAR });
    expect(bookings.length).toBeGreaterThanOrEqual(20);
    const starts = bookings.map((b) => Date.parse(b.range.start));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('keeps only bookings that overlap the range', async () => {
    const { bookings } = await client.listBookings({ range: YEAR });
    const first = bookings[0]!;
    const narrow = await client.listBookings({
      range: { start: first.range.start, end: first.range.end },
    });
    expect(narrow.bookings.map((b) => b.id)).toContain(first.id);
    const empty = await client.listBookings({
      range: { start: '2019-01-01T00:00:00Z', end: '2019-02-01T00:00:00Z' },
    });
    expect(empty.bookings).toHaveLength(0);
  });

  it('filters by staff and by status', async () => {
    const byStaff = await client.listBookings({ range: YEAR, staffId: 'stf_1' });
    expect(byStaff.bookings.every((b) => b.staffId === 'stf_1')).toBe(true);
    expect(byStaff.bookings.length).toBeGreaterThan(0);

    const cancelled = await client.listBookings({ range: YEAR, status: 'cancelled' });
    expect(cancelled.bookings.every((b) => b.status === 'cancelled')).toBe(true);
    expect(cancelled.bookings.length).toBeGreaterThan(0);
  });

  it('pages through every booking exactly once', async () => {
    const all = (await client.listBookings({ range: YEAR })).bookings.map((b) => b.id);
    const seen: string[] = [];
    let token: string | undefined;
    let guard = 0;
    do {
      const page = await client.listBookings({
        range: YEAR,
        limit: 5,
        ...(token ? { pageToken: token } : {}),
      });
      expect(page.bookings.length).toBeLessThanOrEqual(5);
      seen.push(...page.bookings.map((b) => b.id));
      token = page.nextPageToken;
      guard += 1;
    } while (token && guard < 50);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('omits nextPageToken on the last page', async () => {
    const page = await client.listBookings({ range: YEAR, limit: 1000 });
    expect(page.nextPageToken).toBeUndefined();
  });

  it('treats limit: 0 as a real cap yielding an empty page, not "no limit"', async () => {
    // Matches capPage's contract (src/adapter-kit.ts:214): only undefined or a
    // negative limit means uncapped. 0 is falsy but is still a real limit.
    const page = await client.listBookings({ range: YEAR, limit: 0 });
    expect(page.bookings).toHaveLength(0);
    // An empty page can never advance the cursor, so it must not hand back a
    // token that would make a naive pager loop forever.
    expect(page.nextPageToken).toBeUndefined();
  });

  it('treats a negative limit as uncapped, same as omitting it', async () => {
    const all = await client.listBookings({ range: YEAR });
    const negative = await client.listBookings({ range: YEAR, limit: -1 });
    expect(negative.bookings.map((b) => b.id)).toEqual(all.bookings.map((b) => b.id));
    expect(negative.nextPageToken).toBeUndefined();
  });

  it('treats an omitted limit as uncapped', async () => {
    const { bookings, nextPageToken } = await client.listBookings({ range: YEAR });
    expect(bookings.length).toBeGreaterThanOrEqual(20);
    expect(nextPageToken).toBeUndefined();
  });

  it('rejects a malformed page token', async () => {
    try {
      await client.listBookings({ range: YEAR, pageToken: 'not-a-cursor' });
      throw new Error('expected a rejection');
    } catch (e) {
      expect(isUnibookingError(e) && e.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects a token whose index is not all digits, even if Number() would coerce it', async () => {
    // btoa('sample:') decodes to prefix "sample" and an empty index, and
    // Number('') is 0 -- without an explicit digits check that token would be
    // silently accepted as page 0 even though this provider never issued it.
    const blank = btoa('sample:');
    try {
      await client.listBookings({ range: YEAR, pageToken: blank });
      throw new Error('expected a rejection');
    } catch (e) {
      expect(isUnibookingError(e) && e.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects a backwards range before reading anything', async () => {
    try {
      await client.listBookings({
        range: { start: '2026-02-01T00:00:00Z', end: '2026-01-01T00:00:00Z' },
      });
      throw new Error('expected a rejection');
    } catch (e) {
      expect(isUnibookingError(e) && e.code).toBe('INVALID_INPUT');
    }
  });
});
