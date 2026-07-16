import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { square } from '../src/adapters/square';
import { collectAll, isUnibookingError, listAll, withRetry } from '../src/index';

/**
 * Executable, assertion-backed mirror of the README "Quick start" walkthrough.
 * Runs every BookingClient operation against mocked Square HTTP so the example in
 * the docs is proven to compile and work, not just plausible. If you change the
 * README example, change this test to match.
 */

const ORIGIN = 'https://connect.squareup.com';
const JSON_HEADERS = { 'content-type': 'application/json' };

const pathname = (full: string): string => {
  const q = full.indexOf('?');
  return q === -1 ? full : full.slice(0, q);
};

// --- Mocked Square resources ------------------------------------------------
const BOOKING = {
  id: 'bk_1',
  start_at: '2026-07-20T15:00:00-07:00',
  status: 'ACCEPTED',
  customer_id: 'cust_1',
  appointment_segments: [
    { duration_minutes: 45, team_member_id: 'tm_1', service_variation_id: 'SERVICE_VARIATION_ID' },
  ],
};
const BOOKING_MOVED = {
  ...BOOKING,
  start_at: '2026-07-20T16:00:00-07:00',
  version: 6,
};
const BOOKING_PAGE2 = {
  id: 'bk_2',
  start_at: '2026-07-21T09:00:00-07:00',
  status: 'ACCEPTED',
  appointment_segments: [{ duration_minutes: 30 }],
};

describe('README quick-start walkthrough (mocked Square)', () => {
  let agent: MockAgent;
  let previous: Dispatcher;

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);

    const pool = agent.get(ORIGIN);
    const reply = (obj: unknown) => JSON.stringify(obj);

    // customers.findOrCreate: search (miss) then create.
    pool
      .intercept({ path: (p) => pathname(p) === '/v2/customers/search', method: 'POST' })
      .reply(200, reply({ customers: [] }), { headers: JSON_HEADERS });
    pool
      .intercept({ path: (p) => pathname(p) === '/v2/customers', method: 'POST' })
      .reply(200, reply({ customer: { id: 'cust_1' } }), { headers: JSON_HEADERS });

    // searchAvailability.
    pool
      .intercept({ path: (p) => pathname(p) === '/v2/bookings/availability/search', method: 'POST' })
      .reply(
        200,
        reply({
          availabilities: [
            {
              start_at: '2026-07-20T15:00:00-07:00',
              appointment_segments: [{ duration_minutes: 45, team_member_id: 'tm_1' }],
            },
          ],
        }),
        { headers: JSON_HEADERS },
      );

    // createBooking.
    pool
      .intercept({ path: (p) => pathname(p) === '/v2/bookings', method: 'POST' })
      .reply(200, reply({ booking: BOOKING }), { headers: JSON_HEADERS });

    // getBooking + updateBooking's version read (called more than once).
    pool
      .intercept({ path: (p) => pathname(p) === '/v2/bookings/bk_1', method: 'GET' })
      .reply(200, reply({ booking: { ...BOOKING, version: 5 } }), { headers: JSON_HEADERS })
      .persist();

    // updateBooking PUT.
    pool
      .intercept({ path: (p) => pathname(p) === '/v2/bookings/bk_1', method: 'PUT' })
      .reply(200, reply({ booking: BOOKING_MOVED }), { headers: JSON_HEADERS });

    // listBookings / listAll / collectAll — two pages driven by the cursor.
    pool
      .intercept({ path: (p) => pathname(p) === '/v2/bookings', method: 'GET' })
      .reply(200, (opts) => {
        const cursor = new URL('http://x' + opts.path).searchParams.get('cursor');
        return cursor === 'c2'
          ? reply({ bookings: [BOOKING_PAGE2] })
          : reply({ bookings: [BOOKING], cursor: 'c2' });
      }, { headers: JSON_HEADERS })
      .persist();

    // cancelBooking.
    pool
      .intercept({ path: (p) => pathname(p) === '/v2/bookings/bk_1/cancel', method: 'POST' })
      .reply(200, '{}', { headers: JSON_HEADERS });

    // The error-handling branch: a 404 → NOT_FOUND.
    pool
      .intercept({ path: (p) => pathname(p) === '/v2/bookings/does-not-exist', method: 'GET' })
      .reply(404, reply({ errors: [{ code: 'NOT_FOUND', detail: 'nope' }] }), { headers: JSON_HEADERS });
  });

  afterEach(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });

  it('runs the full lifecycle end to end', async () => {
    const client = square(
      () => ({ accessToken: 'sq_token', locationId: 'L1' }),
      { timeoutMs: 10_000 },
    );

    // capabilities — every one true for Square.
    expect(client.capabilities).toEqual({
      availability: true,
      staff: true,
      services: true,
      webhooks: true,
      idempotency: true,
      customers: true,
    });

    const serviceId = 'SERVICE_VARIATION_ID';

    // 1. customers.findOrCreate
    const customerId = await client.customers!.findOrCreate({
      name: 'Jane Doe',
      email: 'jane@example.com',
    });
    expect(customerId).toBe('cust_1');

    // 2. searchAvailability
    const slots = await client.searchAvailability({
      range: { start: '2026-07-20T00:00:00-07:00', end: '2026-07-21T00:00:00-07:00' },
      serviceId,
    });
    expect(slots).toHaveLength(1);
    const slot = slots[0]!;
    expect(slot.start).toBe('2026-07-20T15:00:00-07:00');
    expect(slot.end).toBe('2026-07-20T15:45:00-07:00');
    expect(slot.staffId).toBe('tm_1');

    // 3. createBooking
    const booking = await client.createBooking({
      title: 'Haircut — Jane',
      range: { start: slot.start, end: slot.end },
      serviceId,
      ...(slot.staffId ? { staffId: slot.staffId } : {}),
      customer: { id: customerId },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(booking.id).toBe('bk_1');
    expect(booking.range.end).toBe('2026-07-20T15:45:00-07:00');
    expect(Date.parse(booking.range.end)).toBeGreaterThan(Date.parse(booking.range.start));

    // 4. getBooking
    const fetched = await client.getBooking(booking.id);
    expect(fetched.id).toBe('bk_1');

    // 5. updateBooking (reschedule)
    const moved = await client.updateBooking(booking.id, {
      range: { start: '2026-07-20T16:00:00-07:00', end: '2026-07-20T16:45:00-07:00' },
    });
    expect(moved.range.start).toBe('2026-07-20T16:00:00-07:00');
    expect(moved.range.end).toBe('2026-07-20T16:45:00-07:00');

    // 6. listBookings (single page, with a nextPageToken)
    const page = await client.listBookings({
      range: { start: '2026-07-20T00:00:00-07:00', end: '2026-07-27T00:00:00-07:00' },
    });
    expect(page.bookings).toHaveLength(1);
    expect(page.nextPageToken).toBe('c2');

    // listAll auto-paginates across both pages.
    const seen: string[] = [];
    for await (const b of listAll(client, { range: page.bookings[0]!.range })) {
      seen.push(b.id);
    }
    expect(seen).toEqual(['bk_1', 'bk_2']);

    // collectAll is the array convenience.
    const everything = await collectAll(client, { range: moved.range });
    expect(everything.map((b) => b.id)).toEqual(['bk_1', 'bk_2']);

    // 7. cancelBooking (resolves void)
    await expect(
      client.cancelBooking(booking.id, { reason: 'Client rescheduled', notify: true }),
    ).resolves.toBeUndefined();

    // Typed error handling through withRetry (NOT_FOUND is not retried).
    const resilient = withRetry(client, { retries: 3 });
    const err = await resilient.getBooking('does-not-exist').catch((e) => e);
    expect(isUnibookingError(err) && err.code).toBe('NOT_FOUND');
  });
});
