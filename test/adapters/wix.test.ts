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
  // Reader V2 has no GET-by-id — get/list both POST the extended-bookings query.
  errorProbe: {
    method: 'POST',
    path: '/bookings/bookings-reader/v2/extended-bookings/query',
    run: (c) => c.getBooking('missing'),
  },
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
      name: 'getBooking queries extended-bookings and unwraps .booking',
      method: 'POST',
      path: '/bookings/bookings-reader/v2/extended-bookings/query',
      reply: { extendedBookings: [{ booking: wixBooking({ status: 'CANCELED' }) }] },
      run: (c) => c.getBooking('B1'),
      check: (b) => expect(b.status).toBe('cancelled'),
    },
    {
      name: 'listBookings queries extended-bookings and returns a cursor',
      method: 'POST',
      path: '/bookings/bookings-reader/v2/extended-bookings/query',
      reply: {
        extendedBookings: [{ booking: wixBooking() }],
        pagingMetadata: { cursors: { next: 'c2' } },
      },
      run: (c) => c.listBookings({ range: { start: START, end: '2026-07-21T00:00:00Z' } }),
      check: (r) => {
        expect(r.bookings).toHaveLength(1);
        expect(r.nextPageToken).toBe('c2');
      },
    },
    {
      name: 'searchAvailability maps Time Slots V2 local times back to instants',
      method: 'POST',
      path: '/_api/service-availability/v2/time-slots',
      reply: {
        timeSlots: [
          {
            localStartDate: '2026-07-20T22:00:00',
            localEndDate: '2026-07-20T22:30:00',
            availableResources: [{ resources: [{ id: 'staff1' }] }],
          },
        ],
      },
      run: (c) =>
        c.searchAvailability({
          // Time Slots V2 is local-time; pass an IANA zone (UTC keeps the math trivial).
          range: { start: START, end: '2026-07-21T00:00:00Z', timezone: 'UTC' },
          serviceId: 'svc1',
        }),
      check: (slots) => {
        expect(slots).toHaveLength(1);
        expect(slots[0].start).toBe('2026-07-20T22:00:00Z');
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

  it('reschedule reads the current revision, then sends it on the reschedule', async () => {
    const pool = agent.get(ORIGIN);
    // 1) revision lookup via the extended-bookings query
    pool
      .intercept({ path: '/bookings/bookings-reader/v2/extended-bookings/query', method: 'POST' })
      .reply(200, JSON.stringify({ extendedBookings: [{ booking: wixBooking({ revision: '7' }) }] }), {
        headers: { 'content-type': 'application/json' },
      });
    // 2) reschedule carries that revision
    let body: any;
    pool.intercept({ path: '/bookings/v2/bookings/B1/reschedule', method: 'POST' }).reply(
      200,
      (opts) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify({ booking: wixBooking() });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = wix({ accessToken: 't' });
    await client.updateBooking('B1', { range: RANGE });
    expect(body.revision).toBe('7');
    expect(body.slot.startDate).toBe(START);
    agent.assertNoPendingInterceptors();
  });

  it('updateBooking with status cancelled reads the revision then routes to cancel', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: '/bookings/bookings-reader/v2/extended-bookings/query', method: 'POST' })
      .reply(200, JSON.stringify({ extendedBookings: [{ booking: wixBooking({ revision: '9' }) }] }), {
        headers: { 'content-type': 'application/json' },
      });
    let cancelBody: any;
    pool.intercept({ path: '/bookings/v2/bookings/B1/cancel', method: 'POST' }).reply(
      200,
      (opts) => {
        cancelBody = JSON.parse(String(opts.body));
        return JSON.stringify({ booking: wixBooking({ status: 'CANCELED' }) });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = wix({ accessToken: 't' });
    await client.updateBooking('B1', { status: 'cancelled' });
    expect(cancelBody.revision).toBe('9');
    agent.assertNoPendingInterceptors();
  });

  it('searchAvailability without a range.timezone is rejected (Time Slots V2 is local-time)', async () => {
    const client = wix({ accessToken: 't' });
    await expect(
      client.searchAvailability({ range: { start: START, end: '2026-07-21T00:00:00Z' }, serviceId: 'svc1' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('updateBooking with no range and no cancel throws UNSUPPORTED', async () => {
    const client = wix({ accessToken: 't' });
    await expect(client.updateBooking('B1', { title: 'new title' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });
});
