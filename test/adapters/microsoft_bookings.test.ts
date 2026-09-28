import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { microsoftBookings } from '../../src/adapters/microsoft_bookings';
import { runConformance } from '../conformance';

// Graph's bookingAppointment uses `start`/`end` (dateTimeTimeZone), NOT
// `startDateTime`/`endDateTime`.
const APPT = {
  id: 'a1',
  serviceId: 'svc1',
  serviceName: 'Haircut',
  staffMemberIds: ['staff1'],
  start: { dateTime: '2026-07-20T22:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-07-20T22:45:00.0000000', timeZone: 'UTC' },
  customers: [{ name: 'Jane', emailAddress: 'jane@example.com' }],
};

const BIZ = 'contoso@contoso.onmicrosoft.com';
const APPTS = `/v1.0/solutions/bookingBusinesses/${encodeURIComponent(BIZ)}/appointments`;
const VIEW = `/v1.0/solutions/bookingBusinesses/${encodeURIComponent(BIZ)}/calendarView`;
const CUSTOMERS = `/v1.0/solutions/bookingBusinesses/${encodeURIComponent(BIZ)}/customers`;
const RANGE = { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:45:00Z' };

runConformance({
  provider: 'microsoft_bookings',
  origin: 'https://graph.microsoft.com',
  makeClient: () => microsoftBookings({ accessToken: 'token', businessId: BIZ }),
  errorProbe: { method: 'GET', path: APPTS, run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking maps staff + service',
      method: 'POST',
      path: APPTS,
      reply: APPT,
      run: (c) =>
        c.createBooking({
          title: 'Haircut',
          range: RANGE,
          serviceId: 'svc1',
          staffId: 'staff1',
          customer: { name: 'Jane', email: 'jane@example.com' },
        }),
      check: (b) => {
        expect(b.staffId).toBe('staff1');
        expect(b.serviceId).toBe('svc1');
        expect(b.range.end).toBe('2026-07-20T22:45:00Z');
      },
    },
    {
      name: 'getBooking',
      method: 'GET',
      path: APPTS,
      reply: APPT,
      run: (c) => c.getBooking('a1'),
    },
    {
      name: 'cancelBooking posts /cancel',
      method: 'POST',
      path: `${APPTS}/a1/cancel`,
      reply: '',
      run: (c) => c.cancelBooking('a1', { reason: 'client asked' }),
    },
    {
      name: 'listBookings via calendarView',
      method: 'GET',
      path: VIEW,
      reply: { value: [APPT] },
      run: (c) =>
        c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => expect(r.bookings).toHaveLength(1),
    },
  ],
});

describe('microsoft_bookings: update handles the 204 PATCH by re-GETting', () => {
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

  it('sends start/end on PATCH (204) then re-GETs the appointment', async () => {
    const pool = agent.get('https://graph.microsoft.com');
    let patchBody: any;
    pool
      .intercept({ path: (p) => p.startsWith(`${APPTS}/a1`), method: 'PATCH' })
      .reply(204, (opts) => {
        patchBody = JSON.parse(String(opts.body));
        return '';
      });
    pool
      .intercept({ path: (p) => p.startsWith(`${APPTS}/a1`), method: 'GET' })
      .reply(200, JSON.stringify(APPT), { headers: { 'content-type': 'application/json' } });

    const client = microsoftBookings({ accessToken: 't', businessId: BIZ });
    const b = await client.updateBooking('a1', { range: RANGE });

    // The reschedule targets `start`/`end` (dateTimeTimeZone), not startDateTime.
    expect(patchBody.start.dateTime).toBeTruthy();
    expect(patchBody.startDateTime).toBeUndefined();
    expect(b.range.end).toBe('2026-07-20T22:45:00Z');
    agent.assertNoPendingInterceptors();
  });
});

describe('microsoft_bookings: customers.findOrCreate', () => {
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

  it('returns an existing customer id when the email matches (case-insensitive)', async () => {
    const pool = agent.get('https://graph.microsoft.com');
    pool.intercept({ path: (p) => p.startsWith(CUSTOMERS), method: 'GET' }).reply(
      200,
      JSON.stringify({
        value: [
          { id: 'c-other', displayName: 'Other', emailAddress: 'other@example.com' },
          { id: 'c-jane', displayName: 'Jane', emailAddress: 'Jane@Example.com' },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    const client = microsoftBookings({ accessToken: 't', businessId: BIZ });
    const id = await client.customers!.findOrCreate({ email: 'jane@example.com' });
    expect(id).toBe('c-jane');
    agent.assertNoPendingInterceptors(); // no POST create happened
  });

  it('creates a new bookingCustomer and returns its id when no email matches', async () => {
    const pool = agent.get('https://graph.microsoft.com');
    pool
      .intercept({ path: (p) => p.startsWith(CUSTOMERS), method: 'GET' })
      .reply(200, JSON.stringify({ value: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    let createBody: any;
    pool.intercept({ path: (p) => p.startsWith(CUSTOMERS), method: 'POST' }).reply(
      201,
      (opts) => {
        createBody = JSON.parse(String(opts.body));
        return JSON.stringify({
          id: 'c-new',
          displayName: 'Jane',
          emailAddress: 'jane@example.com',
        });
      },
      { headers: { 'content-type': 'application/json' } },
    );
    const client = microsoftBookings({ accessToken: 't', businessId: BIZ });
    const id = await client.customers!.findOrCreate({ name: 'Jane', email: 'jane@example.com' });
    expect(id).toBe('c-new');
    expect(createBody['@odata.type']).toBe('#microsoft.graph.bookingCustomer');
    expect(createBody.displayName).toBe('Jane');
    expect(createBody.emailAddress).toBe('jane@example.com');
    agent.assertNoPendingInterceptors();
  });

  it('returns customer.id verbatim without any HTTP call', async () => {
    const client = microsoftBookings({ accessToken: 't', businessId: BIZ });
    const id = await client.customers!.findOrCreate({
      id: 'existing-id',
      email: 'jane@example.com',
    });
    expect(id).toBe('existing-id');
  });
});

describe('microsoft_bookings: service and staff writes', () => {
  const BASE = `/v1.0/solutions/bookingBusinesses/${encodeURIComponent(BIZ)}`;
  const SVC = `${BASE}/services`;
  const STAFF = `${BASE}/staffMembers`;
  const JSON_HEADERS = { 'content-type': 'application/json' };
  const client = () => microsoftBookings({ accessToken: 'token', businessId: BIZ });
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

  const pool = () => agent.get('https://graph.microsoft.com');
  /** The business read that resolves the price currency. */
  const business = () =>
    pool()
      .intercept({ path: (p) => p === BASE || p.startsWith(`${BASE}?`), method: 'GET' })
      .reply(200, JSON.stringify({ defaultCurrencyIso: 'GBP' }), { headers: JSON_HEADERS })
      .persist();
  const svc = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    displayName: 'Cut',
    defaultDuration: 'PT45M',
    defaultPrice: 30,
    staffMemberIds: ['m1'],
    isHiddenFromCustomers: false,
    ...over,
  });

  it('createService posts displayName, an ISO duration and a decimal price', async () => {
    business();
    let body: any;
    pool()
      .intercept({ path: SVC, method: 'POST' })
      .reply(
        200,
        (o) => {
          body = JSON.parse(String(o.body));
          return JSON.stringify(svc());
        },
        { headers: JSON_HEADERS },
      );
    const s = await client().createService!({
      name: 'Cut',
      durationMinutes: 90,
      price: { amount: 3000, currency: 'GBP' },
    });
    expect(body).toMatchObject({
      displayName: 'Cut',
      defaultDuration: 'PT1H30M',
      defaultPrice: 30,
      defaultPriceType: 'fixedPrice',
    });
    expect(s).toMatchObject({
      id: 's1',
      price: { amount: 3000, currency: 'GBP' },
      staffIds: ['m1'],
    });
  });

  it('setServiceActive(false) hides it from customers and reads back inactive', async () => {
    business();
    let body: any;
    pool()
      .intercept({ path: `${SVC}/s1`, method: 'PATCH' })
      .reply(204, (o) => {
        body = JSON.parse(String(o.body));
        return '';
      });
    pool()
      .intercept({ path: `${SVC}/s1`, method: 'GET' })
      .reply(200, JSON.stringify(svc({ isHiddenFromCustomers: true })), { headers: JSON_HEADERS });
    const s = await client().setServiceActive!('s1', false);
    expect(body.isHiddenFromCustomers).toBe(true);
    expect(s.active).toBe(false);
  });

  it('assignStaffToService PATCHes the full staffMemberIds list', async () => {
    business();
    let body: any;
    pool()
      .intercept({ path: `${SVC}/s1`, method: 'GET' })
      .reply(200, JSON.stringify(svc()), { headers: JSON_HEADERS });
    pool()
      .intercept({ path: `${SVC}/s1`, method: 'PATCH' })
      .reply(204, (o) => {
        body = JSON.parse(String(o.body));
        return '';
      });
    pool()
      .intercept({ path: `${SVC}/s1`, method: 'GET' })
      .reply(200, JSON.stringify(svc({ staffMemberIds: ['m1', 'm2'] })), {
        headers: JSON_HEADERS,
      });
    const s = await client().assignStaffToService!('s1', 'm2');
    expect(body.staffMemberIds).toEqual(['m1', 'm2']);
    expect(s.staffIds).toEqual(['m1', 'm2']);
  });

  it('unassignStaffFromService drops only that member', async () => {
    business();
    let body: any;
    pool()
      .intercept({ path: `${SVC}/s1`, method: 'GET' })
      .reply(200, JSON.stringify(svc({ staffMemberIds: ['m1', 'm2'] })), {
        headers: JSON_HEADERS,
      });
    pool()
      .intercept({ path: `${SVC}/s1`, method: 'PATCH' })
      .reply(204, (o) => {
        body = JSON.parse(String(o.body));
        return '';
      });
    pool()
      .intercept({ path: `${SVC}/s1`, method: 'GET' })
      .reply(200, JSON.stringify(svc({ staffMemberIds: ['m2'] })), { headers: JSON_HEADERS });
    await client().unassignStaffFromService!('s1', 'm1');
    expect(body.staffMemberIds).toEqual(['m2']);
  });

  it('deleteService and deleteStaff send DELETE', async () => {
    const seen: string[] = [];
    for (const path of [`${SVC}/s1`, `${STAFF}/m1`]) {
      pool()
        .intercept({ path, method: 'DELETE' })
        .reply(204, () => {
          seen.push(path);
          return '';
        });
    }
    await client().deleteService!('s1');
    await client().deleteStaff!('m1');
    expect(seen).toEqual([`${SVC}/s1`, `${STAFF}/m1`]);
  });

  it('createStaff requires an email and sends a role', async () => {
    await expect(client().createStaff!({ name: 'No Mail' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    let body: any;
    pool()
      .intercept({ path: STAFF, method: 'POST' })
      .reply(
        200,
        (o) => {
          body = JSON.parse(String(o.body));
          return JSON.stringify({ id: 'm9', displayName: 'Ana', emailAddress: 'ana@x.com' });
        },
        { headers: JSON_HEADERS },
      );
    const m = await client().createStaff!({ name: 'Ana', email: 'ana@x.com' });
    expect(body).toMatchObject({
      displayName: 'Ana',
      emailAddress: 'ana@x.com',
      role: 'externalGuest',
    });
    expect(m).toMatchObject({ id: 'm9', name: 'Ana', email: 'ana@x.com' });
  });

  it('follows the nextLink it handed out as the pageToken, not page 1 again', async () => {
    const next = `https://graph.microsoft.com${STAFF}?$skiptoken=PAGE2`;
    pool()
      .intercept({ path: STAFF, method: 'GET' })
      .reply(
        200,
        JSON.stringify({ value: [{ id: 'm1', displayName: 'A' }], '@odata.nextLink': next }),
        {
          headers: JSON_HEADERS,
        },
      );
    pool()
      .intercept({
        path: (p) => p.includes('skiptoken=PAGE2') && !p.includes('https'),
        method: 'GET',
      })
      .reply(200, JSON.stringify({ value: [{ id: 'm2', displayName: 'B' }] }), {
        headers: JSON_HEADERS,
      });
    const first = await client().listStaff!();
    expect(first.nextPageToken).toBe(next);
    const second = await client().listStaff!({ pageToken: first.nextPageToken! });
    expect(second.staff.map((m) => m.id)).toEqual(['m2']);
    expect(second.nextPageToken).toBeUndefined();
  });

  it('rounds a fractional duration to whole minutes before splitting hours', async () => {
    business();
    let body: any;
    pool()
      .intercept({ path: SVC, method: 'POST' })
      .reply(
        200,
        (o) => {
          body = JSON.parse(String(o.body));
          return JSON.stringify(svc());
        },
        { headers: JSON_HEADERS },
      );
    await client().createService!({ name: 'Cut', durationMinutes: 119.6 });
    expect(body.defaultDuration).toBe('PT2H');
  });

  it('has no setStaffActive, because Graph has no inactive state', () => {
    const c = client();
    expect(c.capabilities.staffDeactivate).toBe(false);
    expect(c.setStaffActive).toBeUndefined();
  });
});

describe('microsoft_bookings: client records', () => {
  const BASE = `/v1.0/solutions/bookingBusinesses/${encodeURIComponent(BIZ)}`;
  const JSON_HEADERS = { 'content-type': 'application/json' };
  const client = () => microsoftBookings({ accessToken: 'token', businessId: BIZ });
  const CUST = {
    id: 'c1',
    displayName: 'Ana Silva',
    emailAddress: 'ana@x.com',
    phones: [{ number: '+15550100', type: 'mobile' }],
  };
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
  const pool = () => agent.get('https://graph.microsoft.com');

  it('list maps records and filters a page by email', async () => {
    pool()
      .intercept({ path: (p) => p.startsWith(`${BASE}/customers`), method: 'GET' })
      .reply(
        200,
        JSON.stringify({ value: [CUST, { ...CUST, id: 'c2', emailAddress: 'bo@x.com' }] }),
        { headers: JSON_HEADERS },
      );
    const r = await client().customers!.list!({ email: 'ANA@x.com' });
    expect(r.customers).toEqual([
      expect.objectContaining({ id: 'c1', name: 'Ana Silva', phone: '+15550100' }),
    ]);
  });

  it('update PATCHes then re-reads; delete removes', async () => {
    let body: any;
    pool()
      .intercept({ path: `${BASE}/customers/c1`, method: 'PATCH' })
      .reply(204, (o) => {
        body = JSON.parse(String(o.body));
        return '';
      });
    pool()
      .intercept({ path: `${BASE}/customers/c1`, method: 'GET' })
      .reply(200, JSON.stringify({ ...CUST, displayName: 'Ana S.' }), { headers: JSON_HEADERS });
    const u = await client().customers!.update!('c1', { name: 'Ana S.', phone: '+15550199' });
    expect(body).toMatchObject({
      displayName: 'Ana S.',
      phones: [{ number: '+15550199', type: 'mobile' }],
    });
    expect(u.name).toBe('Ana S.');

    pool()
      .intercept({ path: `${BASE}/customers/c1`, method: 'DELETE' })
      .reply(204, '');
    await client().customers!.delete!('c1');
  });
});
