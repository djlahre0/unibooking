import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { vagaro } from '../../src/adapters/vagaro';
import { runConformance } from '../conformance';

const JSON_HEADERS = { 'content-type': 'application/json' };
const ORIGIN = 'https://api.vagaro.com';

const APPT = {
  appointmentId: 'ap==',
  startTime: '2026-07-20T22:00:00.000Z',
  endTime: '2026-07-20T22:45:00.000Z',
  bookingStatus: 'Confirmed',
  serviceTitle: 'Mens Haircut',
  serviceId: 'svc1',
  serviceProviderId: 'sp1',
  customerId: 'cust1',
  eventType: 'Appointment',
  createdDate: '2026-07-01T00:00:00.000Z',
  modifiedDate: null,
};

const RANGE = { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:45:00Z' };
const makeClient = () => vagaro({ region: 'usa03', businessId: 'biz1', accessToken: 't' });

runConformance({
  provider: 'vagaro',
  origin: ORIGIN,
  makeClient,
  errorProbe: {
    method: 'POST',
    path: '/usa03/api/v2/appointments',
    run: (c) => c.getBooking('missing'),
  },
  cases: [
    {
      name: 'getBooking maps the appointment',
      method: 'POST',
      path: '/usa03/api/v2/appointments',
      reply: { status: 200, responseCode: 1000, data: [APPT] },
      run: (c) => c.getBooking('ap=='),
      check: (b) => {
        expect(b.id).toBe('ap==');
        expect(b.status).toBe('confirmed');
        expect(b.staffId).toBe('sp1');
        expect(b.serviceId).toBe('svc1');
        expect(b.customer?.id).toBe('cust1');
        expect(b.title).toBe('Mens Haircut');
        expect(b.range.end).toBe('2026-07-20T22:45:00.000Z');
      },
    },
    {
      name: 'searchAvailability expands timeSlot against appointmentDate',
      method: 'POST',
      path: '/usa03/api/v2/appointments/availability',
      reply: {
        data: [
          {
            appointmentDate: '2026-07-20',
            items: [{ serviceProviderId: 'sp1', duration: 30 }],
            timeSlot: ['09:00', '09:30'],
          },
        ],
      },
      run: (c) => c.searchAvailability({ range: RANGE, serviceId: 'svc1' }),
      check: (slots) => {
        expect(slots).toHaveLength(2);
        expect(slots[0].start).toBe('2026-07-20T09:00:00Z');
        expect(slots[0].end).toBe('2026-07-20T09:30:00Z');
        expect(slots[0].staffId).toBe('sp1');
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// Wire format. The conformance harness matches on path + method only, so the
// auth header and request body — the two things that were actually wrong — need
// explicit assertions.
// ---------------------------------------------------------------------------
describe('vagaro wire format', () => {
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

  it('authenticates with a raw accessToken header, not Authorization: Bearer', async () => {
    let seen: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments'), method: 'POST' })
      .reply(200, (opts: any) => {
        seen = opts;
        return JSON.stringify({ data: [APPT] });
      }, { headers: JSON_HEADERS });

    await makeClient().getBooking('ap==');

    const headers = seen.headers as Record<string, string>;
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(lower['accesstoken']).toBe('t');
    expect(lower['authorization']).toBeUndefined();
  });

  it('fetches a single appointment by POSTing businessId + appointmentId', async () => {
    let seen: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments'), method: 'POST' })
      .reply(200, (opts: any) => {
        seen = opts;
        return JSON.stringify({ data: [APPT] });
      }, { headers: JSON_HEADERS });

    await makeClient().getBooking('ap==');

    // No `merchants/` segment — that prefix only applies to token/employee routes.
    expect(seen.path).not.toContain('/merchants/');
    expect(JSON.parse(seen.body)).toEqual({ businessId: 'biz1', appointmentId: 'ap==' });
  });

  it('sends the create body as a top-level array in business-local time', async () => {
    let seen: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments/create'), method: 'POST' })
      .reply(200, (opts: any) => {
        seen = opts;
        return JSON.stringify({ data: { appointments: [{ appointmentId: 'ap==' }] } });
      }, { headers: JSON_HEADERS });
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p === '/usa03/api/v2/appointments', method: 'POST' })
      .reply(200, JSON.stringify({ data: [APPT] }), { headers: JSON_HEADERS });

    await makeClient().createBooking({
      title: 'Haircut',
      range: { start: '2026-07-20T09:00:00-07:00', end: '2026-07-20T09:30:00-07:00' },
      serviceId: 'svc1',
      staffId: 'sp1',
      customer: { id: 'cust1' },
    });

    const body = JSON.parse(seen.body);
    expect(Array.isArray(body)).toBe(true);
    // Writes are business-local with no offset — the caller's -07:00 wall clock,
    // not the UTC instant, which would shift the booking by 7 hours.
    expect(body[0].startTime).toBe('2026-07-20T09:00:00');
    expect(body[0].businessId).toBe('biz1');
    expect(body[0].appointmentType).toBe('appointment');
  });

  it('cancels via POST to appointments/delete, not DELETE', async () => {
    let seen: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments/delete/'), method: 'POST' })
      .reply(200, (opts: any) => {
        seen = opts;
        return JSON.stringify({ data: {} });
      }, { headers: JSON_HEADERS });

    await makeClient().cancelBooking('ap==');

    expect(seen.path).toContain('/appointments/delete/ap%3D%3D');
    expect(JSON.parse(seen.body).businessId).toBe('biz1');
  });

  it('rejects listBookings without a customerId — Vagaro has no date-range list', async () => {
    const err = await makeClient()
      .listBookings({ range: RANGE })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('UNSUPPORTED');
    expect(err?.message).toContain('customerId');
  });

  it('lists by customerId when one is supplied', async () => {
    let seen: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments'), method: 'POST' })
      .reply(200, (opts: any) => {
        seen = opts;
        return JSON.stringify({ data: [APPT] });
      }, { headers: JSON_HEADERS });

    const page = await makeClient().listBookings({ range: RANGE, customerId: 'cust1' });

    expect(JSON.parse(seen.body)).toEqual({ businessId: 'biz1', customerId: 'cust1' });
    expect(page.bookings).toHaveLength(1);
  });

  it('surfaces responseCode as the provider code', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments'), method: 'POST' })
      .reply(
        400,
        JSON.stringify({
          status: 400,
          responseCode: 1051,
          message: 'One or more validation errors occurred.',
        }),
        { headers: JSON_HEADERS },
      );

    const err = await makeClient().getBooking('x').catch((e) => e);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('validation errors');
    // Previously read `errorCode`/`code`, neither of which Vagaro ever sends.
    expect(err.providerCode).toBe('1051');
  });
});
