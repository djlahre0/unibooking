import { describe, expect, it, vi } from 'vitest';
import type { Booking, BookingClient, Capabilities } from '../src/types';
import { UnibookingError } from '../src/errors';
import { createRegistry } from '../src/registry';
import { withRetry } from '../src/retry';
import { collectAll, listAll } from '../src/paginate';
import { google } from '../src/adapters/google';
import { square } from '../src/adapters/square';

const CAPS: Capabilities = {
  availability: false,
  staff: false,
  services: false,
  webhooks: false,
  idempotency: false,
  customers: false,
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
