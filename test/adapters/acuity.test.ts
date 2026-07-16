import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { acuity } from '../../src/adapters/acuity';
import { runConformance } from '../conformance';

const APPT = {
  id: 55,
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  phone: '555-0100',
  datetime: '2026-07-20T15:00:00-0700',
  duration: '45',
  appointmentTypeID: 12,
  calendarID: 3,
  type: 'Haircut',
  canceled: false,
};

const RANGE = { start: '2026-07-20T15:00:00-07:00', end: '2026-07-20T15:45:00-07:00' };

runConformance({
  provider: 'acuity',
  origin: 'https://acuityscheduling.com',
  makeClient: () => acuity({ userId: 'u', apiKey: 'k' }),
  errorProbe: { method: 'GET', path: '/api/v1/appointments', run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking normalizes the offset + derives end from duration',
      method: 'POST',
      path: '/api/v1/appointments',
      reply: APPT,
      run: (c) =>
        c.createBooking({
          title: 'Haircut',
          range: RANGE,
          serviceId: '12',
          staffId: '3',
          customer: { name: 'Jane Doe', email: 'jane@example.com' },
        }),
      check: (b) => {
        expect(b.range.start).toBe('2026-07-20T15:00:00-07:00');
        expect(b.range.end).toBe('2026-07-20T15:45:00-07:00');
        expect(b.staffId).toBe('3');
        expect(b.serviceId).toBe('12');
        expect(b.customer?.name).toBe('Jane Doe');
      },
    },
    {
      name: 'getBooking',
      method: 'GET',
      path: '/api/v1/appointments',
      reply: APPT,
      run: (c) => c.getBooking('55'),
    },
    {
      name: 'updateBooking reschedules',
      method: 'PUT',
      path: '/api/v1/appointments/55/reschedule',
      reply: APPT,
      run: (c) => c.updateBooking('55', { range: RANGE }),
    },
    {
      name: 'cancelBooking',
      method: 'PUT',
      path: '/api/v1/appointments/55/cancel',
      reply: APPT,
      run: (c) => c.cancelBooking('55', { reason: 'client asked' }),
    },
    {
      name: 'listBookings returns an array',
      method: 'GET',
      path: '/api/v1/appointments',
      reply: [APPT],
      run: (c) => c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => expect(r.bookings).toHaveLength(1),
    },
    {
      name: 'searchAvailability derives slot end from durationMinutes',
      method: 'GET',
      path: '/api/v1/availability/times',
      reply: [{ time: '2026-07-20T15:00:00-0700' }],
      run: (c) => c.searchAvailability({ range: RANGE, serviceId: '12', durationMinutes: 45 }),
      check: (slots) => {
        expect(slots).toHaveLength(1);
        expect(slots[0].start).toBe('2026-07-20T15:00:00-07:00');
        expect(slots[0].end).toBe('2026-07-20T15:45:00-07:00');
      },
    },
  ],
});

describe('acuity: status, timezone, validation, and update mapping', () => {
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

  it('maps a no-show appointment to no_show and populates the timezone', async () => {
    const pool = agent.get('https://acuityscheduling.com');
    pool
      .intercept({ path: (p) => p.startsWith('/api/v1/appointments'), method: 'GET' })
      .reply(200, JSON.stringify({ ...APPT, noShow: true, timezone: 'America/Los_Angeles' }), {
        headers: { 'content-type': 'application/json' },
      });
    const client = acuity({ userId: 'u', apiKey: 'k' });
    const b = await client.getBooking('55');
    expect(b.status).toBe('no_show');
    expect(b.range.timezone).toBe('America/Los_Angeles');
  });

  it('searchAvailability rejects an inverted range before hitting the network', async () => {
    const client = acuity({ userId: 'u', apiKey: 'k' });
    await expect(
      client.searchAvailability({
        range: { start: '2026-07-21T00:00:00Z', end: '2026-07-20T00:00:00Z' },
        serviceId: '12',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('a non-reschedule update maps title to notes instead of dropping it', async () => {
    const pool = agent.get('https://acuityscheduling.com');
    let body: any;
    pool
      .intercept({ path: (p) => p === '/api/v1/appointments/55' || p.startsWith('/api/v1/appointments/55?'), method: 'PUT' })
      .reply(200, (opts) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify({ ...APPT });
      }, { headers: { 'content-type': 'application/json' } });
    const client = acuity({ userId: 'u', apiKey: 'k' });
    await client.updateBooking('55', { title: 'Please call first' });
    expect(body.notes).toBe('Please call first');
  });
});
