import { describe, it, expect, beforeEach } from 'vitest';
import { isUnibookingError } from 'unibooking';
import { sampleClient } from './client';
import { armFailure } from './failure';
import { loadSample, saveSample } from './store';

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

/** Codes are asserted through the public helper, never by string-matching a message. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (isUnibookingError(e)) return e.code;
    throw e;
  }
  throw new Error('expected a UnibookingError, but the call succeeded');
}

describe('sampleClient bookings', () => {
  let client: ReturnType<typeof sampleClient>;
  let storage: Storage;
  beforeEach(() => {
    armFailure(null);
    storage = fakeStorage();
    client = sampleClient({ storage, latencyMs: 0 });
  });

  it('declares itself with honest capabilities', () => {
    expect(client.capabilities.availability).toBe(true);
    expect(client.capabilities.serviceCatalogWrite).toBe(true);
    // No verifier exists for this provider, and it has one schedule, not many.
    expect(client.capabilities.webhooks).toBe(false);
    expect(client.capabilities.calendarList).toBe(false);
    expect(client.listCalendars).toBeUndefined();
  });

  it('creates a booking and reads it back', async () => {
    const created = await client.createBooking({
      title: 'Haircut: Test',
      range: { start: '2026-11-02T10:00:00-05:00', end: '2026-11-02T10:30:00-05:00' },
      staffId: 'stf_1',
      serviceId: 'svc_1',
    });
    expect(created.id).toMatch(/^bkg_/);
    expect(created.status).toBe('confirmed');
    expect(created.raw).toBeDefined();
    expect((await client.getBooking(created.id)).title).toBe('Haircut: Test');
  });

  it('persists a created booking across client instances', async () => {
    const storage = fakeStorage();
    const first = sampleClient({ storage, latencyMs: 0 });
    const created = await first.createBooking({
      title: 'Persisted',
      range: { start: '2026-11-03T10:00:00-05:00', end: '2026-11-03T10:30:00-05:00' },
      staffId: 'stf_1',
    });
    const second = sampleClient({ storage, latencyMs: 0 });
    expect((await second.getBooking(created.id)).title).toBe('Persisted');
  });

  it('rejects a range that ends before it starts, before mutating anything', async () => {
    // Reads the dataset directly rather than through listBookings, which does
    // not exist until Task 4 -- a test must never depend on code a later task
    // introduces.
    const before = loadSample(storage).bookings.length;
    expect(
      await codeOf(() =>
        client.createBooking({
          title: 'Backwards',
          range: { start: '2026-11-02T11:00:00-05:00', end: '2026-11-02T10:00:00-05:00' },
        }),
      ),
    ).toBe('INVALID_INPUT');
    expect(loadSample(storage).bookings).toHaveLength(before);
  });

  it('rejects an offset-less range, which the canonical contract forbids', async () => {
    expect(
      await codeOf(() =>
        client.createBooking({
          title: 'No offset',
          range: { start: '2026-11-02T10:00:00', end: '2026-11-02T10:30:00' },
        }),
      ),
    ).toBe('INVALID_INPUT');
  });

  it('rejects an empty title', async () => {
    expect(
      await codeOf(() =>
        client.createBooking({
          title: '   ',
          range: { start: '2026-11-02T10:00:00-05:00', end: '2026-11-02T10:30:00-05:00' },
        }),
      ),
    ).toBe('INVALID_INPUT');
  });

  it('rejects an unknown service or staff id', async () => {
    expect(
      await codeOf(() =>
        client.createBooking({
          title: 'Ghost staff',
          range: { start: '2026-11-02T10:00:00-05:00', end: '2026-11-02T10:30:00-05:00' },
          staffId: 'stf_nope',
        }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('reports CONFLICT when the same staff member is double-booked', async () => {
    const range = { start: '2026-11-04T10:00:00-05:00', end: '2026-11-04T10:30:00-05:00' };
    await client.createBooking({ title: 'First', range, staffId: 'stf_1' });
    expect(
      await codeOf(() =>
        client.createBooking({
          title: 'Overlapping',
          range: { start: '2026-11-04T10:15:00-05:00', end: '2026-11-04T10:45:00-05:00' },
          staffId: 'stf_1',
        }),
      ),
    ).toBe('CONFLICT');
  });

  it('allows the same time for a different staff member', async () => {
    const range = { start: '2026-11-05T10:00:00-05:00', end: '2026-11-05T10:30:00-05:00' };
    await client.createBooking({ title: 'Ava', range, staffId: 'stf_1' });
    await expect(
      client.createBooking({ title: 'Ben', range, staffId: 'stf_2' }),
    ).resolves.toBeDefined();
  });

  it('does not conflict with a cancelled booking', async () => {
    const range = { start: '2026-11-06T10:00:00-05:00', end: '2026-11-06T10:30:00-05:00' };
    const first = await client.createBooking({ title: 'Cancelled', range, staffId: 'stf_1' });
    await client.cancelBooking(first.id);
    await expect(
      client.createBooking({ title: 'Reuses the slot', range, staffId: 'stf_1' }),
    ).resolves.toBeDefined();
  });

  it('returns the original booking for a repeated idempotency key', async () => {
    const input = {
      title: 'Idempotent',
      range: { start: '2026-11-07T10:00:00-05:00', end: '2026-11-07T10:30:00-05:00' },
      staffId: 'stf_1',
      idempotencyKey: 'key-123',
    };
    const first = await client.createBooking(input);
    const second = await client.createBooking(input);
    expect(second.id).toBe(first.id);
  });

  it('reports NOT_FOUND for an unknown booking', async () => {
    expect(await codeOf(() => client.getBooking('bkg_nope'))).toBe('NOT_FOUND');
    expect(await codeOf(() => client.updateBooking('bkg_nope', { title: 'x' }))).toBe('NOT_FOUND');
    expect(await codeOf(() => client.cancelBooking('bkg_nope'))).toBe('NOT_FOUND');
  });

  it('patches only what it was given and bumps updatedAt', async () => {
    const created = await client.createBooking({
      title: 'Before',
      range: { start: '2026-11-08T10:00:00-05:00', end: '2026-11-08T10:30:00-05:00' },
      staffId: 'stf_1',
    });
    const updated = await client.updateBooking(created.id, { title: 'After' });
    expect(updated.title).toBe('After');
    expect(updated.range.start).toBe(created.range.start);
    expect(Date.parse(updated.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt!));
  });

  it('does not re-validate an unchanged schedule, so a title-only patch survives a pre-existing overlap', async () => {
    // Regression for the seeded-bookings-collide bug: assertFree used to run
    // unconditionally, so renaming a booking that happened to already overlap
    // another (as two seeded bookings did on some anchor weekdays) threw
    // CONFLICT forever, with no way to fix it short of cancelling. Neither
    // `range` nor `staffId` is in this patch, so nothing about the schedule
    // is moving -- there is nothing to re-validate.
    const range = { start: '2026-11-10T10:00:00-05:00', end: '2026-11-10T10:30:00-05:00' };
    const first = await client.createBooking({ title: 'First', range, staffId: 'stf_1' });
    // Force a same-staff overlap directly into storage: createBooking itself
    // would reject this, but a seed (or a real provider's import) can hand
    // back exactly this shape.
    const data = loadSample(storage);
    data.bookings.push({
      ...first,
      id: 'bkg_conflict',
      title: 'Conflicting',
      range: { start: '2026-11-10T10:15:00-05:00', end: '2026-11-10T10:45:00-05:00' },
    });
    saveSample(data, storage);

    const updated = await client.updateBooking(first.id, { title: 'Renamed' });
    expect(updated.title).toBe('Renamed');
  });

  it('still rejects an update that moves the schedule onto an existing conflict', async () => {
    const rangeA = { start: '2026-11-11T10:00:00-05:00', end: '2026-11-11T10:30:00-05:00' };
    const rangeB = { start: '2026-11-11T11:00:00-05:00', end: '2026-11-11T11:30:00-05:00' };
    await client.createBooking({ title: 'A', range: rangeA, staffId: 'stf_1' });
    const b = await client.createBooking({ title: 'B', range: rangeB, staffId: 'stf_1' });
    expect(await codeOf(() => client.updateBooking(b.id, { range: rangeA }))).toBe('CONFLICT');
  });

  it('clears description with an empty string, per the UpdateBookingInput contract', async () => {
    const created = await client.createBooking({
      title: 'Has notes',
      range: { start: '2026-11-08T11:00:00-05:00', end: '2026-11-08T11:30:00-05:00' },
      staffId: 'stf_1',
      description: 'Allergic to lavender',
    });
    expect(created.description).toBe('Allergic to lavender');
    const updated = await client.updateBooking(created.id, { description: '' });
    expect(updated.description).toBe('');
  });

  it('cancels without destroying the record', async () => {
    const created = await client.createBooking({
      title: 'To cancel',
      range: { start: '2026-11-09T10:00:00-05:00', end: '2026-11-09T10:30:00-05:00' },
      staffId: 'stf_1',
    });
    await client.cancelBooking(created.id);
    expect((await client.getBooking(created.id)).status).toBe('cancelled');
  });

  it('fires an armed failure exactly once', async () => {
    armFailure('RATE_LIMIT');
    expect(await codeOf(() => client.getBooking('bkg_1'))).toBe('RATE_LIMIT');
    await expect(client.getBooking('bkg_1')).resolves.toBeDefined();
  });
});
