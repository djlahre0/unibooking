import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { vagaro } from '../../src/adapters/vagaro';
import { runConformance } from '../conformance';

const APPT = {
  appointmentId: 'ap==',
  startTime: '2026-07-20T22:00:00Z',
  endTime: '2026-07-20T22:45:00Z',
  bookingStatus: 'Confirmed',
  serviceId: 'svc1',
  serviceProviderId: 'sp1',
  customerId: 'cust1',
  createdDate: '2026-07-01T00:00:00Z',
  modifiedDate: null,
};

const RANGE = { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:45:00Z' };
const makeClient = () => vagaro({ region: 'usa03', accessToken: 't' });

runConformance({
  provider: 'vagaro',
  origin: 'https://api.vagaro.com',
  makeClient,
  errorProbe: {
    method: 'GET',
    path: '/usa03/api/v2/merchants/appointments/missing',
    run: (c) => c.getBooking('missing'),
  },
  cases: [
    {
      name: 'getBooking maps the appointment',
      method: 'GET',
      path: '/usa03/api/v2/merchants/appointments/ap%3D%3D',
      reply: APPT,
      run: (c) => c.getBooking('ap=='),
      check: (b) => {
        expect(b.status).toBe('confirmed');
        expect(b.staffId).toBe('sp1');
        expect(b.range.end).toBe('2026-07-20T22:45:00Z');
        expect(b.id).toBe('ap==');
        expect(b.serviceId).toBe('svc1');
        expect(b.customer?.id).toBe('cust1');
        expect(b.createdAt).toBe('2026-07-01T00:00:00Z');
      },
    },
    {
      name: 'searchAvailability returns slots',
      method: 'GET',
      path: '/usa03/api/v2/merchants/appointments/availability',
      reply: [{ startTime: '2026-07-20T22:00:00Z', endTime: '2026-07-20T22:45:00Z' }],
      run: (c) => c.searchAvailability({ range: RANGE }),
      check: (slots) => expect(slots[0].start).toBe('2026-07-20T22:00:00Z'),
    },
  ],
});

describe('vagaro read-only', () => {
  const range = RANGE;
  it.each([
    ['createBooking', (c: any) => c.createBooking({ title: 'x', range })],
    ['updateBooking', (c: any) => c.updateBooking('1', { range })],
    ['cancelBooking', (c: any) => c.cancelBooking('1')],
    ['listBookings', (c: any) => c.listBookings({ range })],
  ])('%s throws UNSUPPORTED', async (_name, call) => {
    const err = await call(makeClient()).then(() => null).catch((e: any) => e);
    expect(err?.code).toBe('UNSUPPORTED');
  });
});

describe('vagaro error parsing', () => {
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

  it('surfaces the provider message and code from an error body', async () => {
    agent
      .get('https://api.vagaro.com')
      .intercept({ path: (p) => p.startsWith('/usa03/api/v2/merchants/appointments/'), method: 'GET' })
      .reply(400, JSON.stringify({ message: 'Appointment not bookable', errorCode: 'V-123' }), {
        headers: { 'content-type': 'application/json' },
      });
    const err = await makeClient().getBooking('x').catch((e) => e);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('Appointment not bookable');
    expect(err.providerCode).toBe('V-123');
  });
});
