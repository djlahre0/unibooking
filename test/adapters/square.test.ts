import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { square } from '../../src/adapters/square';
import { runConformance } from '../conformance';

const ORIGIN = 'https://connect.squareup.com';
const START = '2026-07-20T22:00:00Z';

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'B1',
    start_at: START,
    status: 'ACCEPTED',
    customer_id: 'CUST1',
    appointment_segments: [
      { duration_minutes: 30, team_member_id: 'tm1', service_variation_id: 'sv1' },
    ],
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-02T00:00:00Z',
    version: 3,
    ...overrides,
  };
}

const RANGE = { start: START, end: '2026-07-20T22:45:00Z' };

runConformance({
  provider: 'square',
  origin: ORIGIN,
  makeClient: () => square({ accessToken: 'token', locationId: 'LOC1' }),
  errorProbe: { method: 'GET', path: '/v2/bookings', run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking derives a real end from segment duration',
      method: 'POST',
      path: '/v2/bookings',
      reply: { booking: booking() },
      run: (c) =>
        c.createBooking({
          title: 'Cut',
          range: RANGE,
          customer: { id: 'CUST1' },
          staffId: 'tm1',
          serviceId: 'sv1',
          // Square requires this on every create; omitting it is a 400.
          providerOptions: { service_variation_version: 1 },
        }),
      check: (b) => {
        // The reference bug set end = start; here end = start + 30 minutes.
        expect(b.range.start).toBe(START);
        expect(b.range.end).toBe('2026-07-20T22:30:00Z');
        expect(Date.parse(b.range.end) > Date.parse(b.range.start)).toBe(true);
        expect(b.staffId).toBe('tm1');
        expect(b.serviceId).toBe('sv1');
      },
    },
    {
      name: 'getBooking maps status',
      method: 'GET',
      path: '/v2/bookings',
      reply: { booking: booking({ status: 'CANCELLED_BY_SELLER' }) },
      run: (c) => c.getBooking('B1'),
      check: (b) => expect(b.status).toBe('cancelled'),
    },
    {
      name: 'updateBooking with explicit version does a single PUT',
      method: 'PUT',
      path: '/v2/bookings',
      reply: { booking: booking() },
      run: (c) => c.updateBooking('B1', { range: RANGE, providerOptions: { version: 3 } }),
    },
    {
      name: 'cancelBooking posts to /cancel',
      method: 'POST',
      path: '/v2/bookings/B1/cancel',
      reply: { booking: booking({ status: 'CANCELLED_BY_SELLER' }) },
      run: (c) => c.cancelBooking('B1', { reason: 'client asked' }),
    },
    {
      name: 'listBookings returns bookings + cursor',
      method: 'GET',
      path: '/v2/bookings',
      reply: { bookings: [booking()], cursor: 'c2' },
      run: (c) => c.listBookings({ range: { start: START, end: '2026-07-21T00:00:00Z' } }),
      check: (r) => {
        expect(r.bookings).toHaveLength(1);
        expect(r.nextPageToken).toBe('c2');
      },
    },
    {
      name: 'searchAvailability derives slot end from duration',
      method: 'POST',
      path: '/v2/bookings/availability/search',
      reply: {
        availabilities: [
          {
            start_at: START,
            appointment_segments: [{ duration_minutes: 30, team_member_id: 'tm1' }],
          },
        ],
      },
      run: (c) =>
        c.searchAvailability({
          range: { start: START, end: '2026-07-21T00:00:00Z' },
          serviceId: 'sv1',
        }),
      check: (slots) => {
        expect(slots).toHaveLength(1);
        expect(slots[0].end).toBe('2026-07-20T22:30:00Z');
        expect(slots[0].staffId).toBe('tm1');
      },
    },
  ],
});

// --- Square-specific behavior not covered by the generic kit ---------------

describe('square: customer resolution + version fetch', () => {
  let agent: MockAgent;
  let previous: Dispatcher;

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    setGlobalDispatcher(previous);
    await agent.close();
  });

  it('createBooking with a customer email searches, then attaches the found id', async () => {
    const pool = agent.get(ORIGIN);
    const bodies: any[] = [];
    pool
      .intercept({ path: '/v2/customers/search', method: 'POST' })
      .reply(200, JSON.stringify({ customers: [{ id: 'CUST_FOUND' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/v2/bookings', method: 'POST' }).reply(
      200,
      (opts) => {
        bodies.push(JSON.parse(String(opts.body)));
        return JSON.stringify({ booking: booking({ customer_id: 'CUST_FOUND' }) });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    const b = await client.createBooking({
      title: 'Cut',
      range: RANGE,
      customer: { email: 'jane@example.com' },
      staffId: 'tm1',
      serviceId: 'sv1',
      providerOptions: { service_variation_version: 1 },
    });

    expect(b.customer?.id).toBe('CUST_FOUND');
    expect(bodies[0].booking.customer_id).toBe('CUST_FOUND');
    // An idempotency key is always sent, even when the caller omits one.
    expect(typeof bodies[0].idempotency_key).toBe('string');
    agent.assertNoPendingInterceptors();
  });

  it('createBooking puts providerOptions.service_variation_version on the segment', async () => {
    const pool = agent.get(ORIGIN);
    let body: any;
    pool.intercept({ path: '/v2/bookings', method: 'POST' }).reply(
      200,
      (opts) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify({ booking: booking() });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    await client.createBooking({
      title: 'Cut',
      range: RANGE,
      customer: { id: 'CUST1' },
      staffId: 'tm1',
      serviceId: 'sv1',
      providerOptions: { service_variation_version: 42 },
    });

    const seg = body.booking.appointment_segments[0];
    expect(seg.service_variation_version).toBe(42);
    expect(seg.service_variation_id).toBe('sv1');
    // version must NOT leak into the booking body as a top-level field
    expect(body.booking.service_variation_version).toBeUndefined();
    agent.assertNoPendingInterceptors();
  });

  it('updateBooking without a version first GETs to read it', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: '/v2/bookings/B1', method: 'GET' })
      .reply(200, JSON.stringify({ booking: booking({ version: 7 }) }), {
        headers: { 'content-type': 'application/json' },
      });
    let putBody: any;
    pool.intercept({ path: '/v2/bookings/B1', method: 'PUT' }).reply(
      200,
      (opts) => {
        putBody = JSON.parse(String(opts.body));
        return JSON.stringify({ booking: booking() });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    await client.updateBooking('B1', { range: RANGE });

    expect(putBody.booking.version).toBe(7);
    agent.assertNoPendingInterceptors();
  });

  it('updateBooking maps staffId/serviceId/title into the segment and note', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: '/v2/bookings/B1', method: 'GET' })
      .reply(200, JSON.stringify({ booking: booking({ version: 9 }) }), {
        headers: { 'content-type': 'application/json' },
      });
    let putBody: any;
    pool.intercept({ path: '/v2/bookings/B1', method: 'PUT' }).reply(
      200,
      (opts) => {
        putBody = JSON.parse(String(opts.body));
        return JSON.stringify({ booking: booking() });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    await client.updateBooking('B1', { staffId: 'tmNEW', serviceId: 'svNEW', title: 'VIP note' });

    const seg = putBody.booking.appointment_segments[0];
    expect(seg.team_member_id).toBe('tmNEW');
    expect(seg.service_variation_id).toBe('svNEW');
    // the untouched segment field is preserved from the current booking
    expect(seg.duration_minutes).toBe(30);
    expect(putBody.booking.customer_note).toBe('VIP note');
    expect(putBody.booking.version).toBe(9);
    agent.assertNoPendingInterceptors();
  });

  it('cancelBooking forwards booking_version for optimistic concurrency', async () => {
    const pool = agent.get(ORIGIN);
    let cancelBody: any;
    pool.intercept({ path: '/v2/bookings/B1/cancel', method: 'POST' }).reply(
      200,
      (opts) => {
        cancelBody = JSON.parse(String(opts.body));
        return JSON.stringify({ booking: booking({ status: 'CANCELLED_BY_SELLER' }) });
      },
      { headers: { 'content-type': 'application/json' } },
    );
    const client = square({ accessToken: 't', locationId: 'LOC1' });
    await client.cancelBooking('B1', { providerOptions: { booking_version: 5 } });
    expect(cancelBody.booking_version).toBe(5);
    expect(typeof cancelBody.idempotency_key).toBe('string');
    agent.assertNoPendingInterceptors();
  });

  it('searchAvailability requires a serviceId and rejects an inverted range', async () => {
    const client = square({ accessToken: 't', locationId: 'LOC1' });
    await expect(
      client.searchAvailability({ range: { start: START, end: '2026-07-21T00:00:00Z' } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      client.searchAvailability({
        range: { start: '2026-07-21T00:00:00Z', end: START },
        serviceId: 'sv1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a create Square would 400 on, naming the missing field', async () => {
    const client = square({ accessToken: 't', locationId: 'LOC1' });
    // NOTE: tsconfig sets `exactOptionalPropertyTypes`, so each case builds its
    // object literally — `{ ...base, staffId: undefined }` does not compile.
    const common = { title: 'Cut', range: RANGE, customer: { id: 'CUST1' } };

    await expect(
      client.createBooking({
        ...common,
        serviceId: 'sv1',
        providerOptions: { service_variation_version: 42 },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('staffId'),
    });

    await expect(
      client.createBooking({
        ...common,
        staffId: 'tm1',
        providerOptions: { service_variation_version: 42 },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('serviceId'),
    });

    await expect(
      client.createBooking({ ...common, staffId: 'tm1', serviceId: 'sv1' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('service_variation_version'),
    });

    // Nothing was sent — the guard is client-side.
    agent.assertNoPendingInterceptors();
  });

  it('skips the guard when the caller supplies appointment_segments wholesale', async () => {
    const pool = agent.get(ORIGIN);
    let body: any;
    pool.intercept({ path: '/v2/bookings', method: 'POST' }).reply(
      200,
      (opts) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify({ booking: booking() });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    // No staffId, no serviceId, no version — the caller has taken over the
    // segment, so the guard must not second-guess them.
    await client.createBooking({
      title: 'Cut',
      range: RANGE,
      customer: { id: 'CUST1' },
      providerOptions: {
        appointment_segments: [
          { team_member_id: 'tmX', service_variation_id: 'svX', service_variation_version: 7 },
        ],
      },
    });

    expect(body.booking.appointment_segments).toEqual([
      { team_member_id: 'tmX', service_variation_id: 'svX', service_variation_version: 7 },
    ]);
    agent.assertNoPendingInterceptors();
  });

  it('rejects a booking with no derivable duration instead of emitting a zero-length range', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: '/v2/bookings/B1', method: 'GET' })
      .reply(200, JSON.stringify({ booking: booking({ appointment_segments: [] }) }), {
        headers: { 'content-type': 'application/json' },
      });
    const client = square({ accessToken: 't', locationId: 'LOC1' });
    await expect(client.getBooking('B1')).rejects.toMatchObject({ code: 'UPSTREAM' });
  });

  it('createBooking with a name-only customer creates one and attaches its id', async () => {
    const pool = agent.get(ORIGIN);
    let createCustomerBody: any;
    let bookingBody: any;
    // name-only → findOrCreateCustomer skips the dedup search and creates straight away
    pool.intercept({ path: '/v2/customers', method: 'POST' }).reply(
      200,
      (opts) => {
        createCustomerBody = JSON.parse(String(opts.body));
        return JSON.stringify({ customer: { id: 'CUST_NAMED' } });
      },
      { headers: { 'content-type': 'application/json' } },
    );
    pool.intercept({ path: '/v2/bookings', method: 'POST' }).reply(
      200,
      (opts) => {
        bookingBody = JSON.parse(String(opts.body));
        return JSON.stringify({ booking: booking({ customer_id: 'CUST_NAMED' }) });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    const b = await client.createBooking({
      title: 'Cut',
      range: RANGE,
      customer: { name: 'Jane Doe' },
      staffId: 'tm1',
      serviceId: 'sv1',
      providerOptions: { service_variation_version: 1 },
    });

    expect(b.customer?.id).toBe('CUST_NAMED');
    expect(bookingBody.booking.customer_id).toBe('CUST_NAMED');
    expect(createCustomerBody.given_name).toBe('Jane');
    expect(createCustomerBody.family_name).toBe('Doe');
    agent.assertNoPendingInterceptors(); // no /customers/search happened
  });

  it('findOrCreate searches by phone when no email is given', async () => {
    const pool = agent.get(ORIGIN);
    let searchBody: any;
    pool.intercept({ path: '/v2/customers/search', method: 'POST' }).reply(
      200,
      (opts) => {
        searchBody = JSON.parse(String(opts.body));
        return JSON.stringify({ customers: [{ id: 'CUST_BY_PHONE' }] });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    const id = await client.customers!.findOrCreate({ phone: '555-0100' });

    expect(id).toBe('CUST_BY_PHONE');
    expect(searchBody.query.filter.phone_number).toBeTruthy();
    agent.assertNoPendingInterceptors(); // no POST /customers create happened
  });

  /**
   * Square's customer search index is eventually consistent: a customer created
   * now is not findable for a second or two (measured against live Square — a
   * miss at 0.9s, a hit at 2.3s). So two findOrCreate calls for the same person
   * in quick succession both miss the index and both reach the create.
   *
   * The create must therefore carry an idempotency key derived from the
   * identity, so Square collapses the second create instead of making a
   * duplicate customer.
   */
  it('findOrCreate derives a stable idempotency key so a lagging search index cannot duplicate a customer', async () => {
    const pool = agent.get(ORIGIN);
    const keys: string[] = [];
    // Both calls miss: this is exactly the index-lag window.
    for (let i = 0; i < 2; i++) {
      pool
        .intercept({ path: '/v2/customers/search', method: 'POST' })
        .reply(200, JSON.stringify({ customers: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      pool.intercept({ path: '/v2/customers', method: 'POST' }).reply(
        200,
        (opts) => {
          keys.push(JSON.parse(String(opts.body)).idempotency_key);
          return JSON.stringify({ customer: { id: 'CUST_1' } });
        },
        { headers: { 'content-type': 'application/json' } },
      );
    }

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    await client.customers!.findOrCreate({ name: 'Jane Doe', email: 'Jane@Example.com' });
    await client.customers!.findOrCreate({ name: 'Jane Doe', email: 'jane@example.com' });

    expect(keys).toHaveLength(2);
    // Same identity → same key, so Square returns the original customer rather
    // than creating a second one. Casing must not defeat it.
    expect(keys[0]).toBe(keys[1]);
    // Bounded length: Square rejects an idempotency key over 126 characters,
    // and an email is unbounded.
    expect(keys[0]!.length).toBeLessThanOrEqual(126);
    // The raw email must not ride along in the key.
    expect(keys[0]).not.toContain('example.com');
  });

  it('findOrCreate keys a phone-only customer on the phone, and distinctly from an email', async () => {
    const pool = agent.get(ORIGIN);
    const keys: string[] = [];
    for (let i = 0; i < 2; i++) {
      pool
        .intercept({ path: '/v2/customers/search', method: 'POST' })
        .reply(200, JSON.stringify({ customers: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      pool.intercept({ path: '/v2/customers', method: 'POST' }).reply(
        200,
        (opts) => {
          keys.push(JSON.parse(String(opts.body)).idempotency_key);
          return JSON.stringify({ customer: { id: 'CUST_1' } });
        },
        { headers: { 'content-type': 'application/json' } },
      );
    }

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    await client.customers!.findOrCreate({ phone: '+441134960000' });
    await client.customers!.findOrCreate({ email: '+441134960000' });

    // Two different people who happen to share a literal string must not
    // collapse onto one key.
    expect(keys[0]).not.toBe(keys[1]);
  });

  /**
   * Verbatim body from live Square (both a sandbox test account and a real
   * production seller) on every Bookings call when the merchant has no
   * Appointments subscription.
   */
  const NOT_ONBOARDED = {
    errors: [
      {
        category: 'AUTHENTICATION_ERROR',
        code: 'UNAUTHORIZED',
        detail: 'Merchant not onboarded to Appointments',
      },
    ],
  };

  it('classifies "not onboarded to Appointments" as UNSUPPORTED, not AUTH', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/v2/bookings'), method: 'GET' })
      .reply(401, JSON.stringify(NOT_ONBOARDED), {
        headers: { 'content-type': 'application/json' },
      })
      .times(1);

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    const err = await client
      .listBookings({ range: { start: START, end: '2026-07-21T22:00:00Z' } })
      .catch((e) => e);

    // AUTH is the code consumers watch for to tear down a connection and force
    // a re-auth. The token here is valid -- re-authing would not fix anything,
    // and the merchant's healthy integration would be disconnected for a
    // subscription they simply never bought.
    expect(err.code).toBe('UNSUPPORTED');
    expect(err.httpStatus).toBe(401);
    expect(err.providerCode).toBe('UNAUTHORIZED');
    // The remedy has to be in the message; the code alone doesn't say what to do.
    expect(err.message).toMatch(/Appointments/);
  });

  it('leaves a genuine 401 as AUTH', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/v2/bookings'), method: 'GET' })
      .reply(
        401,
        JSON.stringify({
          errors: [
            {
              category: 'AUTHENTICATION_ERROR',
              code: 'UNAUTHORIZED',
              detail: 'This request could not be authorized.',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    const client = square({ accessToken: 'bad', locationId: 'LOC1' });
    const err = await client
      .listBookings({ range: { start: START, end: '2026-07-21T22:00:00Z' } })
      .catch((e) => e);

    // A revoked or bogus token must still read as AUTH so the re-auth path fires.
    expect(err.code).toBe('AUTH');
  });

  it('findOrCreate does NOT key a name-only customer on the name', async () => {
    const pool = agent.get(ORIGIN);
    const keys: string[] = [];
    for (let i = 0; i < 2; i++) {
      pool.intercept({ path: '/v2/customers', method: 'POST' }).reply(
        200,
        (opts) => {
          keys.push(JSON.parse(String(opts.body)).idempotency_key);
          return JSON.stringify({ customer: { id: 'CUST_1' } });
        },
        { headers: { 'content-type': 'application/json' } },
      );
    }

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    await client.customers!.findOrCreate({ name: 'John Smith' });
    await client.customers!.findOrCreate({ name: 'John Smith' });

    // A name is not an identity. Collapsing two distinct walk-ins named "John
    // Smith" into one record would attach a booking to the wrong person, which
    // is worse than the duplicate a stable key would avoid.
    expect(keys[0]).not.toBe(keys[1]);
  });
});
