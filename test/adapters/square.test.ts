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
          { start_at: START, appointment_segments: [{ duration_minutes: 30, team_member_id: 'tm1' }] },
        ],
      },
      run: (c) => c.searchAvailability({ range: { start: START, end: '2026-07-21T00:00:00Z' }, serviceId: 'sv1' }),
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
    pool
      .intercept({ path: '/v2/bookings', method: 'POST' })
      .reply(200, (opts) => {
        bodies.push(JSON.parse(String(opts.body)));
        return JSON.stringify({ booking: booking({ customer_id: 'CUST_FOUND' }) });
      }, { headers: { 'content-type': 'application/json' } });

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    const b = await client.createBooking({
      title: 'Cut',
      range: RANGE,
      customer: { email: 'jane@example.com' },
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
    pool
      .intercept({ path: '/v2/bookings', method: 'POST' })
      .reply(200, (opts) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify({ booking: booking() });
      }, { headers: { 'content-type': 'application/json' } });

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
    pool
      .intercept({ path: '/v2/bookings/B1', method: 'PUT' })
      .reply(200, (opts) => {
        putBody = JSON.parse(String(opts.body));
        return JSON.stringify({ booking: booking() });
      }, { headers: { 'content-type': 'application/json' } });

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
    pool
      .intercept({ path: '/v2/bookings/B1', method: 'PUT' })
      .reply(200, (opts) => {
        putBody = JSON.parse(String(opts.body));
        return JSON.stringify({ booking: booking() });
      }, { headers: { 'content-type': 'application/json' } });

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

  it('searchAvailability requires a serviceId and rejects an inverted range', async () => {
    const client = square({ accessToken: 't', locationId: 'LOC1' });
    await expect(
      client.searchAvailability({ range: { start: START, end: '2026-07-21T00:00:00Z' } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      client.searchAvailability({ range: { start: '2026-07-21T00:00:00Z', end: START }, serviceId: 'sv1' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
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
    pool
      .intercept({ path: '/v2/customers', method: 'POST' })
      .reply(200, (opts) => {
        createCustomerBody = JSON.parse(String(opts.body));
        return JSON.stringify({ customer: { id: 'CUST_NAMED' } });
      }, { headers: { 'content-type': 'application/json' } });
    pool
      .intercept({ path: '/v2/bookings', method: 'POST' })
      .reply(200, (opts) => {
        bookingBody = JSON.parse(String(opts.body));
        return JSON.stringify({ booking: booking({ customer_id: 'CUST_NAMED' }) });
      }, { headers: { 'content-type': 'application/json' } });

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    const b = await client.createBooking({
      title: 'Cut',
      range: RANGE,
      customer: { name: 'Jane Doe' },
      staffId: 'tm1',
      serviceId: 'sv1',
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
    pool
      .intercept({ path: '/v2/customers/search', method: 'POST' })
      .reply(200, (opts) => {
        searchBody = JSON.parse(String(opts.body));
        return JSON.stringify({ customers: [{ id: 'CUST_BY_PHONE' }] });
      }, { headers: { 'content-type': 'application/json' } });

    const client = square({ accessToken: 't', locationId: 'LOC1' });
    const id = await client.customers!.findOrCreate({ phone: '555-0100' });

    expect(id).toBe('CUST_BY_PHONE');
    expect(searchBody.query.filter.phone_number).toBeTruthy();
    agent.assertNoPendingInterceptors(); // no POST /customers create happened
  });
});
