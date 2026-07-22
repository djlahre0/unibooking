import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { setmore } from '../../src/adapters/setmore';
import { runConformance } from '../conformance';

const JSON_HEADERS = { 'content-type': 'application/json' };
const ORIGIN = 'https://developer.setmore.com';

const APPT = {
  key: 'A1',
  start_time: '2026-07-20T09:00Z',
  end_time: '2026-07-20T09:30Z',
  staff_key: 's1',
  service_key: 'svc1',
  customer_key: 'c1',
  label: 'Haircut',
  duration: 30,
};

const RANGE = { start: '2026-07-20T09:00:00Z', end: '2026-07-21T09:00:00Z' };
const makeClient = () => setmore({ accessToken: 't' });

runConformance({
  provider: 'setmore',
  origin: ORIGIN,
  makeClient,
  errorProbe: {
    method: 'GET',
    path: '/api/v1/bookingapi/appointments',
    run: (c) => c.listBookings({ range: RANGE }),
  },
  cases: [
    {
      name: 'listBookings maps appointments',
      method: 'GET',
      path: '/api/v1/bookingapi/appointments',
      reply: { response: true, data: { appointments: [APPT], cursor: '' } },
      run: (c) => c.listBookings({ range: RANGE }),
      check: (page) => {
        expect(page.bookings).toHaveLength(1);
        expect(page.bookings[0].id).toBe('A1');
        expect(page.bookings[0].title).toBe('Haircut');
        expect(page.bookings[0].staffId).toBe('s1');
        expect(page.bookings[0].status).toBe('confirmed');
        expect(page.nextPageToken).toBeUndefined();
      },
    },
    {
      name: 'createBooking posts to appointment/create',
      method: 'POST',
      path: '/api/v1/bookingapi/appointment/create',
      reply: { response: true, data: { appointment: APPT } },
      run: (c) =>
        c.createBooking({
          title: 'Haircut',
          range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T09:30:00Z' },
          staffId: 's1',
          serviceId: 'svc1',
          customer: { id: 'c1' },
        }),
      check: (b) => expect(b.id).toBe('A1'),
    },
  ],
});

describe('setmore: operations the API genuinely lacks', () => {
  it.each([
    ['getBooking', (c: any) => c.getBooking('A1')],
    ['cancelBooking', (c: any) => c.cancelBooking('A1')],
  ])('%s throws UNSUPPORTED', async (_name, call) => {
    const err = await call(makeClient())
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('UNSUPPORTED');
  });

  it('updateBooking rejects time/staff/service changes — only a label can change', async () => {
    const err = await makeClient()
      .updateBooking('A1', {
        range: { start: '2026-07-20T10:00:00Z', end: '2026-07-20T10:30:00Z' },
      })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('UNSUPPORTED');
  });

  it('updateBooking rejects a status change as UNSUPPORTED, not as a missing title', async () => {
    const err = await makeClient()
      .updateBooking('A1', { status: 'cancelled' })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('UNSUPPORTED');
    expect(err?.message).toContain('status');
  });
});

describe('setmore wire format', () => {
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

  it('lists with dash-separated day-first dates', async () => {
    let seen: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/api/v1/bookingapi/appointments'), method: 'GET' })
      .reply(
        200,
        (opts: any) => {
          seen = opts;
          return JSON.stringify({ response: true, data: { appointments: [] } });
        },
        { headers: JSON_HEADERS },
      );

    await makeClient().listBookings({
      range: { start: '2026-02-12T00:00:00Z', end: '2026-03-12T00:00:00Z' },
    });

    // dd-mm-yyyy for the list endpoint — not the slots endpoint's DD/MM/YYYY.
    expect(seen.path).toContain('startDate=12-02-2026');
    expect(seen.path).toContain('endDate=12-03-2026');
  });

  it('requests slots by POST with slash-separated dates and an explicit timezone', async () => {
    let seen: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/api/v1/bookingapi/slots'), method: 'POST' })
      .reply(
        200,
        (opts: any) => {
          seen = opts;
          return JSON.stringify({ response: true, data: { slots: ['09.00', '09.30'] } });
        },
        { headers: JSON_HEADERS },
      );

    const slots = await makeClient().searchAvailability({
      range: {
        start: '2026-07-20T00:00:00-07:00',
        end: '2026-07-20T23:00:00-07:00',
        timezone: 'America/Los_Angeles',
      },
      serviceId: 'svc1',
      staffId: 's1',
      durationMinutes: 30,
    });

    const body = JSON.parse(seen.body);
    expect(body.selected_date).toBe('20/07/2026');
    expect(body.timezone).toBe('America/Los_Angeles');
    // Dot-separated wall-clock times, anchored via the supplied IANA zone.
    expect(slots).toHaveLength(2);
    expect(slots[0]!.start).toBe('2026-07-20T16:00:00.000Z');
    expect(slots[1]!.start).toBe('2026-07-20T16:30:00.000Z');
  });

  it("tolerates the docs' ambiguous slots envelope (bare array under data)", async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/api/v1/bookingapi/slots'), method: 'POST' })
      .reply(200, JSON.stringify({ response: true, data: ['09.00'] }), { headers: JSON_HEADERS });

    const slots = await makeClient().searchAvailability({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-20T23:00:00Z', timezone: 'UTC' },
      serviceId: 'svc1',
      staffId: 's1',
      durationMinutes: 30,
    });
    expect(slots).toHaveLength(1);
  });

  it('forwards slot_limit from providerOptions', async () => {
    let seen: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/api/v1/bookingapi/slots'), method: 'POST' })
      .reply(
        200,
        (opts: any) => {
          seen = opts;
          return JSON.stringify({ response: true, data: [] });
        },
        { headers: JSON_HEADERS },
      );

    await makeClient().searchAvailability({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-20T23:00:00Z', timezone: 'UTC' },
      serviceId: 'svc1',
      staffId: 's1',
      durationMinutes: 30,
      providerOptions: { slot_limit: 100 },
    });

    expect(JSON.parse(seen.body).slot_limit).toBe(100);
  });

  it("fans out one slots request per day using each endpoint's own offset", async () => {
    const dates: string[] = [];
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/api/v1/bookingapi/slots'), method: 'POST' })
      .reply(
        200,
        (opts: any) => {
          dates.push(JSON.parse(String(opts.body)).selected_date);
          return JSON.stringify({ response: true, data: [] });
        },
        { headers: JSON_HEADERS },
      )
      .persist();

    await makeClient().searchAvailability({
      // The end carries -07:00 (post-DST) while the start is -08:00; using the
      // start's offset for both would drop the final day.
      range: {
        start: '2026-03-07T23:00:00-08:00',
        end: '2026-03-09T00:30:00-07:00',
        timezone: 'America/Los_Angeles',
      },
      serviceId: 'svc1',
      staffId: 's1',
      durationMinutes: 30,
    });

    expect(dates).toEqual(['07/03/2026', '08/03/2026', '09/03/2026']);
  });

  it('rejects an availability range wider than the per-day fan-out cap', async () => {
    const err = await makeClient()
      .searchAvailability({
        range: { start: '2026-01-01T00:00:00Z', end: '2026-06-01T00:00:00Z', timezone: 'UTC' },
        serviceId: 'svc1',
        staffId: 's1',
        durationMinutes: 30,
      })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('INVALID_INPUT');
    expect(err?.message).toContain('62');
  });

  it('requires an IANA timezone for availability — slot times carry no offset', async () => {
    const err = await makeClient()
      .searchAvailability({
        range: { start: '2026-07-20T00:00:00Z', end: '2026-07-20T23:00:00Z' },
        serviceId: 'svc1',
        staffId: 's1',
        durationMinutes: 30,
      })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('INVALID_INPUT');
    expect(err?.message).toContain('timezone');
  });

  it('updates a label via query param on the label sub-resource', async () => {
    let seen: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.includes('/label'), method: 'PUT' })
      .reply(
        200,
        (opts: any) => {
          seen = opts;
          return JSON.stringify({
            response: true,
            data: { appointment: { ...APPT, label: 'VIP' } },
          });
        },
        { headers: JSON_HEADERS },
      );

    const b = await makeClient().updateBooking('A1', { title: 'VIP' });

    expect(seen.path).toContain('/api/v1/bookingapi/appointments/A1/label');
    expect(seen.path).toContain('label=VIP');
    expect(b.title).toBe('VIP');
  });

  it('looks up a customer by firstname and creates with cell_phone', async () => {
    let created: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/api/v1/bookingapi/customer?'), method: 'GET' })
      .reply(200, JSON.stringify({ response: true, data: { customer: [] } }), {
        headers: JSON_HEADERS,
      });
    agent
      .get(ORIGIN)
      .intercept({
        path: (p) => p.startsWith('/api/v1/bookingapi/customer/create'),
        method: 'POST',
      })
      .reply(
        200,
        (opts: any) => {
          created = opts;
          return JSON.stringify({ response: true, data: { customer: { key: 'C9' } } });
        },
        { headers: JSON_HEADERS },
      );

    const id = await makeClient().customers!.findOrCreate({
      name: 'Jane Doe',
      email: 'jane@example.com',
      phone: '+15550100',
    });

    expect(id).toBe('C9');
    const body = JSON.parse(created.body);
    expect(body.first_name).toBe('Jane');
    expect(body.last_name).toBe('Doe');
    // Documented field is cell_phone; cell_no silently dropped the number.
    expect(body.cell_phone).toBe('+15550100');
    expect(body.email_id).toBe('jane@example.com');
  });

  it('treats response:false as a failure even on HTTP 200', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/api/v1/bookingapi/appointments'), method: 'GET' })
      .reply(200, JSON.stringify({ response: false, error: 'not_allowed', msg: 'nope' }), {
        headers: JSON_HEADERS,
      });

    const err = await makeClient()
      .listBookings({ range: RANGE })
      .catch((e) => e);
    expect(err.code).toBe('UPSTREAM');
    expect(err.providerCode).toBe('not_allowed');
  });
});
