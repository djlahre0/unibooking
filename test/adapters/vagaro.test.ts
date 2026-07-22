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
      // A whole-day window: slots outside the caller's range are now dropped.
      run: (c) =>
        c.searchAvailability({
          range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
          serviceId: 'svc1',
        }),
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

  it('validates the listBookings range like every other method', async () => {
    const err = await makeClient()
      .listBookings({ range: { start: '2026-07-20T22:00:00Z', end: 'nonsense' }, customerId: 'cust1' })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('INVALID_INPUT');
  });

  it('trims the customer history to the requested range', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments'), method: 'POST' })
      .reply(200, JSON.stringify({
        data: [APPT, { ...APPT, appointmentId: 'old==', startTime: '2020-01-01T10:00:00.000Z' }],
      }), { headers: JSON_HEADERS });

    // POST /appointments takes no date window — it returns the whole history.
    const page = await makeClient().listBookings({ range: RANGE, customerId: 'cust1' });

    expect(page.bookings.map((b) => b.id)).toEqual(['ap==']);
  });

  it('does not emit an endless nextPageToken when no limit was requested', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments'), method: 'POST' })
      .reply(200, JSON.stringify({ data: [APPT] }), { headers: JSON_HEADERS });

    const page = await makeClient().listBookings({ range: RANGE, customerId: 'cust1' });

    // `rows.length >= rows.length` is always true — a caller looping to
    // exhaustion never terminated.
    expect(page.nextPageToken).toBeUndefined();
  });

  it('pages only when the caller asked for a page size and the page was full', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments'), method: 'POST' })
      .reply(200, JSON.stringify({ data: [APPT] }), { headers: JSON_HEADERS });

    const page = await makeClient().listBookings({ range: RANGE, customerId: 'cust1', limit: 1 });

    expect(page.nextPageToken).toBe('2');
  });

  it('filters availability slots to the requested window', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments/availability'), method: 'POST' })
      .reply(200, JSON.stringify({
        data: [
          {
            appointmentDate: '2026-07-20',
            items: [{ serviceProviderId: 'sp1', duration: 30 }],
            timeSlot: ['08:00', '10:00', '18:00'],
          },
        ],
      }), { headers: JSON_HEADERS });

    const slots = await makeClient().searchAvailability({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
      serviceId: 'svc1',
    });

    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T10:00:00Z']);
  });

  it('queries one day per date in a multi-day availability range', async () => {
    const dates: string[] = [];
    for (const [date, time] of [['2026-07-20', '10:00'], ['2026-07-21', '11:00']]) {
      agent
        .get(ORIGIN)
        .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments/availability'), method: 'POST' })
        .reply(200, (opts: any) => {
          dates.push(JSON.parse(String(opts.body)).appointmentDate);
          return JSON.stringify({
            data: [{ appointmentDate: date, items: [{ duration: 30 }], timeSlot: [time] }],
          });
        }, { headers: JSON_HEADERS });
    }

    const slots = await makeClient().searchAvailability({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-22T00:00:00Z' },
      serviceId: 'svc1',
    });

    expect(dates).toEqual(['2026-07-20', '2026-07-21']);
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T10:00:00Z', '2026-07-21T11:00:00Z']);
  });

  it('rejects an availability range wider than the day cap', async () => {
    const err = await makeClient()
      .searchAvailability({
        range: { start: '2026-01-01T00:00:00Z', end: '2026-04-01T00:00:00Z' },
        serviceId: 'svc1',
      })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('INVALID_INPUT');
    expect(err?.message).toContain('31');
  });

  it('fails fast when no serviceProviderId can be resolved for an update', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p === '/usa03/api/v2/appointments', method: 'POST' })
      .reply(200, JSON.stringify({ data: [{ ...APPT, serviceProviderId: null }] }), {
        headers: JSON_HEADERS,
      });

    const err = await makeClient()
      .updateBooking('ap==', { range: { start: '2026-07-21T09:00:00Z', end: '2026-07-21T09:45:00Z' } })
      .then(() => null)
      .catch((e: any) => e);

    // JSON.stringify would have dropped the undefined field and silently omitted
    // a value the PUT requires.
    expect(err?.code).toBe('INVALID_INPUT');
    expect(err?.message).toContain('staffId');
  });

  it('writes a title as appointmentNote on update, like create does', async () => {
    let seen: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p === '/usa03/api/v2/appointments', method: 'POST' })
      .reply(200, JSON.stringify({ data: [APPT] }), { headers: JSON_HEADERS })
      .times(2);
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/appointments/ap'), method: 'PUT' })
      .reply(200, (opts: any) => {
        seen = JSON.parse(String(opts.body));
        return JSON.stringify({ data: '' });
      }, { headers: JSON_HEADERS });

    await makeClient().updateBooking('ap==', { title: 'VIP client' });

    expect(seen.appointmentNote).toBe('VIP client');
  });

  it('rejects a status change it cannot write', async () => {
    const client = makeClient();
    for (const [status, hint] of [['cancelled', 'cancelBooking'], ['confirmed', 'confirmed']] as const) {
      const err = await client
        .updateBooking('ap==', { status })
        .then(() => null)
        .catch((e: any) => e);
      expect(err?.code).toBe('INVALID_INPUT');
      expect(err?.message).toContain(hint);
    }
  });
});
