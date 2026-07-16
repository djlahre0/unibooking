import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { setmore } from '../../src/adapters/setmore';
import { runConformance } from '../conformance';

const ORIGIN = 'https://api.setmore.com';
// Setmore times are business-local; express canonical times in that offset.
const START = '2026-07-20T09:00:00-05:00';

function appt(overrides: Record<string, unknown> = {}) {
  return {
    key: 'A1',
    staff_key: 'staff1',
    service_key: 'svc1',
    customer_key: 'cust1',
    start_time: START,
    end_time: '2026-07-20T09:30:00-05:00',
    label: 'Haircut',
    ...overrides,
  };
}

const RANGE = { start: START, end: '2026-07-20T09:30:00-05:00' };

runConformance({
  provider: 'setmore',
  origin: ORIGIN,
  makeClient: () => setmore({ accessToken: 'token' }),
  errorProbe: { method: 'GET', path: '/api/v1/bookingapi/appointments', run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking maps the created appointment',
      method: 'POST',
      path: '/api/v1/bookingapi/appointments',
      reply: { data: { appointment: appt() } },
      run: (c) =>
        c.createBooking({
          title: 'Haircut',
          range: RANGE,
          staffId: 'staff1',
          serviceId: 'svc1',
          customer: { id: 'cust1' },
        }),
      check: (b) => {
        expect(b.id).toBe('A1');
        expect(b.range.start).toBe(START);
        expect(b.staffId).toBe('staff1');
        expect(b.serviceId).toBe('svc1');
      },
    },
    {
      name: 'getBooking maps an appointment',
      method: 'GET',
      path: '/api/v1/bookingapi/appointments',
      reply: { data: { appointment: appt() } },
      run: (c) => c.getBooking('A1'),
      check: (b) => expect(b.customer?.id).toBe('cust1'),
    },
    {
      name: 'updateBooking reschedules via PUT',
      method: 'PUT',
      path: '/api/v1/bookingapi/appointments/A1',
      reply: { data: { appointment: appt() } },
      run: (c) => c.updateBooking('A1', { range: RANGE }),
    },
    {
      name: 'cancelBooking deletes the appointment',
      method: 'DELETE',
      path: '/api/v1/bookingapi/appointments/A1',
      reply: { response: true },
      run: (c) => c.cancelBooking('A1'),
    },
    {
      name: 'listBookings returns appointments',
      method: 'GET',
      path: '/api/v1/bookingapi/appointments',
      reply: { data: { appointments: [appt()] } },
      run: (c) => c.listBookings({ range: { start: START, end: '2026-07-21T00:00:00-05:00' } }),
      check: (r) => expect(r.bookings).toHaveLength(1),
    },
    {
      name: 'searchAvailability turns HH:mm slots into instants in the caller offset',
      method: 'GET',
      path: '/api/v1/bookingapi/slots',
      reply: { data: { slots: ['09:00', '09:30'] } },
      run: (c) =>
        c.searchAvailability({
          range: { start: START, end: '2026-07-20T17:00:00-05:00' },
          staffId: 'staff1',
          serviceId: 'svc1',
          durationMinutes: 30,
        }),
      check: (slots) => {
        expect(slots).toHaveLength(2);
        expect(slots[0].start).toBe('2026-07-20T09:00:00-05:00');
        expect(slots[0].end).toBe('2026-07-20T09:30:00-05:00');
        expect(slots[0].staffId).toBe('staff1');
      },
    },
  ],
});

// --- Setmore-specific behavior --------------------------------------------

describe('setmore: customer resolution + required fields', () => {
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

  it('createBooking resolves a customer by email before booking', async () => {
    const pool = agent.get(ORIGIN);
    const bodies: any[] = [];
    pool
      .intercept({ path: (p) => p.startsWith('/api/v1/bookingapi/customers'), method: 'GET' })
      .reply(200, JSON.stringify({ data: { customers: [{ key: 'CUST_FOUND' }] } }), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/api/v1/bookingapi/appointments', method: 'POST' }).reply(
      200,
      (opts) => {
        bodies.push(JSON.parse(String(opts.body)));
        return JSON.stringify({ data: { appointment: appt() } });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = setmore({ accessToken: 't' });
    await client.createBooking({
      title: 'Cut',
      range: RANGE,
      staffId: 'staff1',
      serviceId: 'svc1',
      customer: { email: 'jane@example.com' },
    });
    expect(bodies[0].customer_key).toBe('CUST_FOUND');
    agent.assertNoPendingInterceptors();
  });

  it('createBooking without staffId/serviceId is rejected', async () => {
    const client = setmore({ accessToken: 't' });
    await expect(client.createBooking({ title: 'x', range: RANGE, serviceId: 'svc1' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(client.createBooking({ title: 'x', range: RANGE, staffId: 'staff1' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('searchAvailability without durationMinutes is rejected', async () => {
    const client = setmore({ accessToken: 't' });
    await expect(
      client.searchAvailability({ range: RANGE, staffId: 'staff1', serviceId: 'svc1' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
