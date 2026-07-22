import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { bookeo } from '../../src/adapters/bookeo';
import { runConformance } from '../conformance';

const BK = {
  bookingNumber: 'BK123',
  startTime: '2026-07-20T22:00:00Z',
  endTime: '2026-07-20T22:45:00Z',
  productId: 'PROD1',
  title: 'Kayak Tour',
  customer: {
    firstName: 'Jane',
    lastName: 'Doe',
    emailAddress: 'jane@example.com',
    phoneNumbers: [{ number: '555-0100' }],
  },
  canceled: false,
  creationTime: '2026-07-01T00:00:00Z',
};

const RANGE = { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:45:00Z' };

runConformance({
  provider: 'bookeo',
  origin: 'https://api.bookeo.com',
  makeClient: () => bookeo({ apiKey: 'k', secretKey: 's' }),
  errorProbe: { method: 'GET', path: '/v2/bookings', run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking maps product + customer',
      method: 'POST',
      path: '/v2/bookings',
      reply: BK,
      run: (c) =>
        c.createBooking({
          title: 'Kayak Tour',
          range: RANGE,
          serviceId: 'PROD1',
          customer: { name: 'Jane Doe', email: 'jane@example.com' },
          providerOptions: {
            participants: { numbers: [{ peopleCategoryId: 'Cadults', number: 1 }] },
          },
        }),
      check: (b) => {
        expect(b.serviceId).toBe('PROD1');
        expect(b.customer?.email).toBe('jane@example.com');
        expect(b.range.end).toBe('2026-07-20T22:45:00Z');
      },
    },
    {
      name: 'getBooking',
      method: 'GET',
      path: '/v2/bookings/BK123',
      reply: BK,
      run: (c) => c.getBooking('BK123'),
    },
    {
      name: 'updateBooking',
      method: 'PUT',
      path: '/v2/bookings/BK123',
      reply: BK,
      run: (c) => c.updateBooking('BK123', { range: RANGE }),
    },
    {
      name: 'cancelBooking deletes',
      method: 'DELETE',
      path: '/v2/bookings/BK123',
      reply: '',
      run: (c) => c.cancelBooking('BK123', { reason: 'weather' }),
    },
    {
      name: 'listBookings reads data[]',
      method: 'GET',
      path: '/v2/bookings',
      reply: { data: [BK], info: { totalItems: 1 } },
      run: (c) =>
        c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => expect(r.bookings).toHaveLength(1),
    },
    {
      name: 'searchAvailability reads /availability/slots and keeps eventId in raw',
      method: 'GET',
      path: '/v2/availability/slots',
      reply: {
        data: [
          {
            productId: 'PROD1',
            eventId: 'PROD1_2026-07-20',
            startTime: '2026-07-20T22:00:00Z',
            endTime: '2026-07-20T22:45:00Z',
            numSeatsAvailable: 5,
          },
        ],
      },
      run: (c) => c.searchAvailability({ range: RANGE, serviceId: 'PROD1' }),
      check: (slots) => {
        expect(slots[0].end).toBe('2026-07-20T22:45:00Z');
        expect((slots[0].raw as any).eventId).toBe('PROD1_2026-07-20');
      },
    },
  ],
});

describe('bookeo: pagination + numeric error code', () => {
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

  it('pages through bookings via the pageNavigationToken', async () => {
    const pool = agent.get('https://api.bookeo.com');
    pool
      .intercept({
        path: (p) => p.startsWith('/v2/bookings') && !p.includes('pageNavigationToken'),
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          data: [{ ...BK, bookingNumber: 'BK1' }],
          info: { totalItems: 2, pageNavigationToken: 'NAV', currentPage: 1, totalPages: 2 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    pool.intercept({ path: (p) => p.includes('pageNavigationToken'), method: 'GET' }).reply(
      200,
      JSON.stringify({
        data: [{ ...BK, bookingNumber: 'BK2' }],
        info: { totalItems: 2, pageNavigationToken: 'NAV', currentPage: 2, totalPages: 2 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );

    const client = bookeo({ apiKey: 'k', secretKey: 's' });
    const p1 = await client.listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
    });
    expect(p1.bookings[0]!.id).toBe('BK1');
    expect(p1.nextPageToken).toBeTruthy();
    const p2 = await client.listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
      pageToken: p1.nextPageToken!,
    });
    expect(p2.bookings[0]!.id).toBe('BK2');
    expect(p2.nextPageToken).toBeUndefined();
  });

  it('captures the provider error code from errorId', async () => {
    const pool = agent.get('https://api.bookeo.com');
    pool
      .intercept({ path: (p) => p.startsWith('/v2/bookings/BK'), method: 'GET' })
      .reply(400, JSON.stringify({ httpStatus: 400, message: 'bad request', errorId: 507 }), {
        headers: { 'content-type': 'application/json' },
      });
    const client = bookeo({ apiKey: 'k', secretKey: 's' });
    const err = await client.getBooking('BK').catch((e) => e);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.providerCode).toBe('507');
  });
});

describe('bookeo: request payloads (spec diff, July 2026)', () => {
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

  const JSON_HEADERS = { 'content-type': 'application/json' };
  const PARTICIPANTS = { numbers: [{ peopleCategoryId: 'Cadults', number: 2 }] };
  const DAY = { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' };

  it('createBooking refuses to invent a peopleCategoryId', async () => {
    const client = bookeo({ apiKey: 'k', secretKey: 's' });
    await expect(
      client.createBooking({ title: 'Kayak Tour', range: RANGE, serviceId: 'PROD1' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('participants'),
    });
  });

  it('createBooking sends title, the caller participants, customerId and notify', async () => {
    let body: any;
    let path = '';
    agent
      .get('https://api.bookeo.com')
      .intercept({ path: (p) => p.startsWith('/v2/bookings'), method: 'POST' })
      .reply(
        200,
        (opts: any) => {
          body = JSON.parse(String(opts.body));
          path = String(opts.path);
          return JSON.stringify(BK);
        },
        { headers: JSON_HEADERS },
      );

    await bookeo({ apiKey: 'k', secretKey: 's' }).createBooking({
      title: 'Kayak Tour',
      range: RANGE,
      serviceId: 'PROD1',
      customer: { id: 'CUST9', name: 'Jane Doe', email: 'jane@example.com' },
      notify: true,
      providerOptions: { participants: PARTICIPANTS },
    });
    // `title` is in the Booking schema's required list and is read back as the title.
    expect(body.title).toBe('Kayak Tour');
    expect(body.participants).toEqual(PARTICIPANTS);
    // An existing customer is referenced by id, not re-described inline.
    expect(body.customerId).toBe('CUST9');
    expect(body.customer).toBeUndefined();
    expect(path).toContain('notifyCustomer=true');
    expect(path).toContain('notifyUsers=true');
  });

  it('createBooking omits lastName for a single-word customer name', async () => {
    let body: any;
    agent
      .get('https://api.bookeo.com')
      .intercept({ path: (p) => p.startsWith('/v2/bookings'), method: 'POST' })
      .reply(
        200,
        (opts: any) => {
          body = JSON.parse(String(opts.body));
          return JSON.stringify(BK);
        },
        { headers: JSON_HEADERS },
      );

    await bookeo({ apiKey: 'k', secretKey: 's' }).createBooking({
      title: 'Kayak Tour',
      range: RANGE,
      serviceId: 'PROD1',
      customer: { name: 'Jane' },
      providerOptions: { participants: PARTICIPANTS },
    });
    expect(body.customer.firstName).toBe('Jane');
    expect('lastName' in body.customer).toBe(false);
  });

  it('getBooking asks for the customer and maps lastChangeTime', async () => {
    let path = '';
    agent
      .get('https://api.bookeo.com')
      .intercept({ path: (p) => p.startsWith('/v2/bookings/BK123'), method: 'GET' })
      .reply(
        200,
        (opts: any) => {
          path = String(opts.path);
          return JSON.stringify({ ...BK, lastChangeTime: '2026-07-10T00:00:00Z' });
        },
        { headers: JSON_HEADERS },
      );

    const b = await bookeo({ apiKey: 'k', secretKey: 's' }).getBooking('BK123');
    // Bookeo omits `customer` entirely unless expandCustomer is requested.
    expect(path).toContain('expandCustomer=true');
    expect(b.customer?.email).toBe('jane@example.com');
    expect(b.updatedAt).toBe('2026-07-10T00:00:00Z');
  });

  it('listBookings asks for the customer and includes cancelled only on request', async () => {
    const paths: string[] = [];
    const pool = agent.get('https://api.bookeo.com');
    pool
      .intercept({ path: (p) => p.startsWith('/v2/bookings'), method: 'GET' })
      .reply(
        200,
        (opts: any) => {
          paths.push(String(opts.path));
          return JSON.stringify({ data: [BK], info: { totalItems: 1 } });
        },
        { headers: JSON_HEADERS },
      )
      .times(2);

    const client = bookeo({ apiKey: 'k', secretKey: 's' });
    const plain = await client.listBookings({ range: DAY });
    await client.listBookings({ range: DAY, status: 'cancelled' });
    expect(plain.bookings[0]!.customer?.name).toBe('Jane Doe');
    expect(paths[0]).toContain('expandCustomer=true');
    expect(paths[0]).not.toContain('includeCanceled');
    expect(paths[1]).toContain('includeCanceled=true');
  });

  it('listBookings rejects a range wider than the documented 31 days', async () => {
    await expect(
      bookeo({ apiKey: 'k', secretKey: 's' }).listBookings({
        range: { start: '2026-01-01T00:00:00Z', end: '2026-03-01T00:00:00Z' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('31 days') });
  });

  it('maps noShow and unaccepted bookings to their own statuses', async () => {
    const pool = agent.get('https://api.bookeo.com');
    for (const b of [
      { ...BK, canceled: true, noShow: true },
      { ...BK, accepted: false },
    ]) {
      pool
        .intercept({ path: (p) => p.startsWith('/v2/bookings/BK123'), method: 'GET' })
        .reply(200, JSON.stringify(b), { headers: JSON_HEADERS });
    }
    const client = bookeo({ apiKey: 'k', secretKey: 's' });
    // noShow rides on top of canceled, so the more specific flag wins.
    expect((await client.getBooking('BK123')).status).toBe('no_show');
    expect((await client.getBooking('BK123')).status).toBe('pending');
  });

  it('cancelBooking forwards notify as notifyCustomer/notifyUsers', async () => {
    let path = '';
    agent
      .get('https://api.bookeo.com')
      .intercept({ path: (p) => p.startsWith('/v2/bookings/BK123'), method: 'DELETE' })
      .reply(204, (opts: any) => {
        path = String(opts.path);
        return '';
      });

    await bookeo({ apiKey: 'k', secretKey: 's' }).cancelBooking('BK123', {
      reason: 'weather',
      notify: false,
    });
    expect(path).toContain('notifyCustomer=false');
    expect(path).toContain('notifyUsers=false');
    expect(path).toContain('reason=weather');
  });
});
