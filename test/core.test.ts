import { describe, expect, it, vi } from 'vitest';
import type { Booking, BookingClient, Capabilities } from '../src/types';
import { UnibookingError } from '../src/errors';
import { createRegistry } from '../src/registry';
import { withRetry } from '../src/retry';
import { collectAll, listAll } from '../src/paginate';
import { defineAdapter, probeConnection } from '../src/adapter-kit';
import { google } from '../src/adapters/google';
import { square } from '../src/adapters/square';

const CAPS: Capabilities = {
  availability: false,
  staff: false,
  services: false,
  webhooks: false,
  idempotency: false,
  customers: false,
  serviceCatalog: false,
  staffDirectory: false,
};

function fakeBooking(id: string): Booking {
  return {
    id,
    provider: 'square',
    title: 't',
    range: { start: '2026-07-20T00:00:00Z', end: '2026-07-20T01:00:00Z' },
    status: 'confirmed',
    raw: {},
  };
}

function fakeClient(overrides: Partial<BookingClient>): BookingClient {
  const base: BookingClient = {
    id: 'square',
    capabilities: CAPS,
    createBooking: async () => fakeBooking('new'),
    getBooking: async (id) => fakeBooking(id),
    updateBooking: async (id) => fakeBooking(id),
    cancelBooking: async () => {},
    listBookings: async () => ({ bookings: [] }),
    searchAvailability: async () => [],
    checkConnection: async () => ({ ok: true, raw: {} }),
  };
  return { ...base, ...overrides };
}

const rateLimit = (retryAfterMs?: number) =>
  new UnibookingError({
    provider: 'square',
    code: 'RATE_LIMIT',
    message: 'slow down',
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

describe('defineAdapter: canonical guarantees applied to every adapter', () => {
  const RANGE = { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' };

  const mixed = defineAdapter({
    id: 'square',
    capabilities: CAPS,
    baseUrl: 'https://example.invalid/',
    auth: () => ({ headers: {} }),
    build: () => ({
      createBooking: async () => fakeBooking('new'),
      getBooking: async (id) => fakeBooking(id),
      updateBooking: async (id) => fakeBooking(id),
      cancelBooking: async () => {},
      // A provider that cannot express a status filter upstream: it hands back
      // whatever it has, in whatever order it has it.
      listBookings: async () => ({
        bookings: [
          { ...fakeBooking('a'), status: 'confirmed' as const },
          { ...fakeBooking('b'), status: 'cancelled' as const },
          { ...fakeBooking('c'), status: 'confirmed' as const },
        ],
        nextPageToken: 'p2',
      }),
      searchAvailability: async () => [
        { start: '2026-07-20T14:00:00Z', end: '2026-07-20T15:00:00Z' },
        { start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:00:00Z' },
      ],
      checkConnection: async () => ({ ok: true, raw: {} }),
    }),
  });

  it('applies the status filter an adapter could not express upstream', async () => {
    const client = mixed({});
    const all = await client.listBookings({ range: RANGE });
    expect(all.bookings.map((b) => b.id)).toEqual(['a', 'b', 'c']);

    const confirmed = await client.listBookings({ range: RANGE, status: 'confirmed' });
    expect(confirmed.bookings.map((b) => b.id)).toEqual(['a', 'c']);
    // Filtering a page must not end pagination — the next page may hold matches.
    expect(confirmed.nextPageToken).toBe('p2');
  });

  it('sorts availability slots chronologically', async () => {
    const slots = await mixed({}).searchAvailability({ range: RANGE });
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T09:00:00Z', '2026-07-20T14:00:00Z']);
  });
});

describe('createRegistry', () => {
  it('dispatches by id and reports membership', () => {
    const reg = createRegistry([google, square]);
    expect(reg.has('google')).toBe(true);
    expect(reg.has('acuity')).toBe(false);
    expect(reg.ids().sort()).toEqual(['google', 'square']);
    expect(reg.get('square').id).toBe('square');
    expect(reg.tryGet('acuity')).toBeUndefined();
  });

  it('throws a helpful error for an unregistered id', () => {
    const reg = createRegistry([google]);
    expect(() => reg.get('square')).toThrowError(/no adapter registered for "square"/);
  });
});

describe('withRetry', () => {
  it('retries a retryable error then succeeds', async () => {
    let calls = 0;
    const client = fakeClient({
      listBookings: async () => {
        calls += 1;
        if (calls < 3) throw rateLimit();
        return { bookings: [fakeBooking('ok')] };
      },
    });
    const wrapped = withRetry(client, { sleep: async () => {}, jitter: false });
    const result = await wrapped.listBookings({ range: fakeBooking('x').range });
    expect(calls).toBe(3);
    expect(result.bookings[0]?.id).toBe('ok');
  });

  it('does NOT retry createBooking without an idempotency key', async () => {
    let calls = 0;
    const client = fakeClient({
      createBooking: async () => {
        calls += 1;
        throw rateLimit();
      },
    });
    const wrapped = withRetry(client, { sleep: async () => {} });
    await expect(
      wrapped.createBooking({ title: 't', range: fakeBooking('x').range }),
    ).rejects.toBeInstanceOf(UnibookingError);
    expect(calls).toBe(1);
  });

  it('retries createBooking when an idempotency key is present', async () => {
    let calls = 0;
    const client = fakeClient({
      createBooking: async () => {
        calls += 1;
        if (calls < 2) throw rateLimit();
        return fakeBooking('created');
      },
    });
    const wrapped = withRetry(client, { sleep: async () => {} });
    const b = await wrapped.createBooking({
      title: 't',
      range: fakeBooking('x').range,
      idempotencyKey: 'key-1',
    });
    expect(calls).toBe(2);
    expect(b.id).toBe('created');
  });

  it('honors retryAfterMs from the error', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const client = fakeClient({
      getBooking: async (id) => {
        calls += 1;
        if (calls < 2) throw rateLimit(1234);
        return fakeBooking(id);
      },
    });
    const wrapped = withRetry(client, { sleep });
    await wrapped.getBooking('B1');
    expect(sleep).toHaveBeenCalledWith(1234);
  });

  it('caps an oversized retryAfterMs at maxDelayMs', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const client = fakeClient({
      getBooking: async (id) => {
        calls += 1;
        if (calls < 2) throw rateLimit(3_600_000); // hostile Retry-After: 1h
        return fakeBooking(id);
      },
    });
    const wrapped = withRetry(client, { sleep, maxDelayMs: 10_000 });
    await wrapped.getBooking('B1');
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it('does NOT retry customers.findOrCreate (non-idempotent create risk)', async () => {
    let calls = 0;
    const client = fakeClient({
      customers: {
        findOrCreate: async () => {
          calls += 1;
          throw rateLimit();
        },
      },
    });
    const wrapped = withRetry(client, { sleep: async () => {} });
    await expect(wrapped.customers!.findOrCreate({ email: 'a@b.com' })).rejects.toBeInstanceOf(
      UnibookingError,
    );
    expect(calls).toBe(1);
  });
});

describe('listAll', () => {
  it('walks pages and stops at an absent token', async () => {
    const pages: Record<string, { bookings: Booking[]; nextPageToken?: string }> = {
      '': { bookings: [fakeBooking('a')], nextPageToken: 'p1' },
      p1: { bookings: [fakeBooking('b')], nextPageToken: 'p2' },
      p2: { bookings: [fakeBooking('c')] },
    };
    const client = fakeClient({
      listBookings: async (q) => pages[q.pageToken ?? ''] ?? { bookings: [] },
    });
    const ids = (await collectAll(client, { range: fakeBooking('x').range })).map((b) => b.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('guards against a non-advancing page token', async () => {
    const client = fakeClient({
      listBookings: async () => ({ bookings: [fakeBooking('a')], nextPageToken: 'same' }),
    });
    const seen: string[] = [];
    for await (const b of listAll(client, { range: fakeBooking('x').range, pageToken: 'same' })) {
      seen.push(b.id);
      if (seen.length > 5) break; // safety in case the guard fails
    }
    expect(seen).toEqual(['a']);
  });

  it('guards against a multi-step token cycle (p1 -> p2 -> p1)', async () => {
    const seq: Record<string, string> = { '': 'p1', p1: 'p2', p2: 'p1' };
    const client = fakeClient({
      listBookings: async (q) => {
        const next = seq[q.pageToken ?? ''];
        return {
          bookings: [fakeBooking(q.pageToken ?? 'start')],
          ...(next !== undefined ? { nextPageToken: next } : {}),
        };
      },
    });
    const seen: string[] = [];
    for await (const b of listAll(client, { range: fakeBooking('x').range })) {
      seen.push(b.id);
      if (seen.length > 10) break; // safety in case the guard fails
    }
    expect(seen).toEqual(['start', 'p1', 'p2']);
  });
});

describe('probeConnection', () => {
  it('reports a dead connection instead of throwing', async () => {
    for (const code of ['AUTH', 'FORBIDDEN', 'NOT_FOUND'] as const) {
      const status = await probeConnection('google', async () => {
        throw new UnibookingError({ provider: 'google', code, message: 'nope' });
      });
      expect(status.ok).toBe(false);
      expect(status.reason).toBe(code);
      expect(status.message).toContain('nope');
    }
  });

  it('rethrows faults that do not mean the credentials are bad', async () => {
    // A network blip is not evidence a salon revoked access. Mapping it to
    // ok:false would make consumers disconnect healthy integrations.
    for (const code of ['NETWORK', 'TIMEOUT', 'UPSTREAM', 'RATE_LIMIT'] as const) {
      await expect(
        probeConnection('google', async () => {
          throw new UnibookingError({ provider: 'google', code, message: 'blip' });
        }),
      ).rejects.toMatchObject({ code });
    }
  });

  it('passes through account identity on success', async () => {
    const status = await probeConnection('google', async () => ({
      account: { email: 'salon@example.com' },
      raw: { hello: 'world' },
    }));
    expect(status).toEqual({
      ok: true,
      account: { email: 'salon@example.com' },
      raw: { hello: 'world' },
    });
  });

  it('omits account entirely when the probe surfaces no identity', async () => {
    const status = await probeConnection('setmore', async () => ({ raw: {} }));
    expect(status.ok).toBe(true);
    expect('account' in status).toBe(false);
  });
});
