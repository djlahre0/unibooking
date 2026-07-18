import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { wix } from '../../src/adapters/wix';
import { runConformance } from '../conformance';

const ORIGIN = 'https://www.wixapis.com';
const START = '2026-07-20T22:00:00Z';

function wixBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'B1',
    bookedEntity: {
      title: 'Haircut',
      slot: {
        serviceId: 'svc1',
        startDate: START,
        endDate: '2026-07-20T22:45:00Z',
        resource: { id: 'staff1', name: 'Alex' },
      },
    },
    contactDetails: { contactId: 'CT1', firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
    status: 'CONFIRMED',
    createdDate: '2026-07-01T00:00:00Z',
    updatedDate: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

const RANGE = { start: START, end: '2026-07-20T22:45:00Z' };

runConformance({
  provider: 'wix',
  origin: ORIGIN,
  makeClient: () => wix({ accessToken: 'token' }),
  errorProbe: { method: 'GET', path: '/bookings/reader/v2/bookings', run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking maps slot + contact',
      method: 'POST',
      path: '/bookings/v2/bookings',
      reply: { booking: wixBooking() },
      run: (c) =>
        c.createBooking({
          title: 'Haircut',
          range: RANGE,
          customer: { id: 'CT1' },
          staffId: 'staff1',
          serviceId: 'svc1',
        }),
      check: (b) => {
        expect(b.range.start).toBe(START);
        expect(b.range.end).toBe('2026-07-20T22:45:00Z');
        expect(b.staffId).toBe('staff1');
        expect(b.serviceId).toBe('svc1');
        expect(b.status).toBe('confirmed');
        expect(b.customer?.email).toBe('jane@example.com');
      },
    },
    {
      name: 'getBooking maps a canceled booking',
      method: 'GET',
      path: '/bookings/reader/v2/bookings',
      reply: { booking: wixBooking({ status: 'CANCELED' }) },
      run: (c) => c.getBooking('B1'),
      check: (b) => expect(b.status).toBe('cancelled'),
    },
    {
      name: 'updateBooking with a range reschedules',
      method: 'POST',
      path: '/bookings/v2/bookings/B1/reschedule',
      reply: { booking: wixBooking() },
      run: (c) => c.updateBooking('B1', { range: RANGE }),
    },
    {
      name: 'cancelBooking posts to /cancel',
      method: 'POST',
      path: '/bookings/v2/bookings/B1/cancel',
      reply: { booking: wixBooking({ status: 'CANCELED' }) },
      run: (c) => c.cancelBooking('B1', { reason: 'client asked' }),
    },
    {
      name: 'listBookings queries and returns a cursor',
      method: 'POST',
      path: '/bookings/reader/v2/bookings/query',
      reply: { bookings: [wixBooking()], pagingMetadata: { cursors: { next: 'c2' } } },
      run: (c) => c.listBookings({ range: { start: START, end: '2026-07-21T00:00:00Z' } }),
      check: (r) => {
        expect(r.bookings).toHaveLength(1);
        expect(r.nextPageToken).toBe('c2');
      },
    },
    {
      name: 'searchAvailability maps time slots',
      method: 'POST',
      path: '/bookings/v2/time-slots/list-availability-time-slots',
      reply: {
        availabilityTimeSlots: [
          { startDate: START, endDate: '2026-07-20T22:30:00Z', resource: { id: 'staff1' } },
        ],
      },
      run: (c) =>
        c.searchAvailability({ range: { start: START, end: '2026-07-21T00:00:00Z' }, serviceId: 'svc1' }),
      check: (slots) => {
        expect(slots).toHaveLength(1);
        expect(slots[0].start).toBe(START);
        expect(slots[0].end).toBe('2026-07-20T22:30:00Z');
        expect(slots[0].staffId).toBe('staff1');
      },
    },
  ],
});

// --- Wix-specific behavior ------------------------------------------------

describe('wix: contact resolution + non-reschedule updates', () => {
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

  it('createBooking resolves a contact by email before booking', async () => {
    const pool = agent.get(ORIGIN);
    const bodies: any[] = [];
    pool
      .intercept({ path: '/contacts/v4/contacts/query', method: 'POST' })
      .reply(200, JSON.stringify({ contacts: [{ id: 'CT_FOUND' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/bookings/v2/bookings', method: 'POST' }).reply(
      200,
      (opts) => {
        bodies.push(JSON.parse(String(opts.body)));
        return JSON.stringify({ booking: wixBooking() });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = wix({ accessToken: 't' });
    await client.createBooking({ title: 'Cut', range: RANGE, customer: { email: 'jane@example.com' } });

    expect(bodies[0].booking.contactDetails.contactId).toBe('CT_FOUND');
    agent.assertNoPendingInterceptors();
  });

  it('creates a CRM contact with the {first,last} name shape (not firstName/lastName)', async () => {
    const pool = agent.get(ORIGIN);
    let createBody: any;
    // No existing contact → falls through to create.
    pool
      .intercept({ path: '/contacts/v4/contacts/query', method: 'POST' })
      .reply(200, JSON.stringify({ contacts: [] }), { headers: { 'content-type': 'application/json' } });
    pool
      .intercept({ path: '/contacts/v4/contacts', method: 'POST' })
      .reply(200, (opts) => {
        createBody = JSON.parse(String(opts.body));
        return JSON.stringify({ contact: { id: 'CT_NEW' } });
      }, { headers: { 'content-type': 'application/json' } });

    const client = wix({ accessToken: 't' });
    const id = await client.customers!.findOrCreate({ name: 'Jane Doe', email: 'jane@example.com' });

    expect(id).toBe('CT_NEW');
    expect(createBody.info.name).toEqual({ first: 'Jane', last: 'Doe' });
    expect(createBody.info.name.firstName).toBeUndefined();
    agent.assertNoPendingInterceptors();
  });

  it('updateBooking with only a status of cancelled routes to cancel', async () => {
    const pool = agent.get(ORIGIN);
    let canceled = false;
    pool.intercept({ path: '/bookings/v2/bookings/B1/cancel', method: 'POST' }).reply(
      200,
      () => {
        canceled = true;
        return JSON.stringify({ booking: wixBooking({ status: 'CANCELED' }) });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = wix({ accessToken: 't' });
    await client.updateBooking('B1', { status: 'cancelled' });
    expect(canceled).toBe(true);
    agent.assertNoPendingInterceptors();
  });

  it('updateBooking with no range and no cancel throws UNSUPPORTED', async () => {
    const client = wix({ accessToken: 't' });
    await expect(client.updateBooking('B1', { title: 'new title' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });
});
