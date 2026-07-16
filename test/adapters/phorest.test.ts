import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getGlobalDispatcher,
  MockAgent,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { phorest } from '../../src/adapters/phorest';
import { runConformance } from '../conformance';

// Phorest response splits time into appointmentDate + UTC LocalTime.
const APPT = {
  appointmentId: 'ap123',
  version: 1,
  appointmentDate: '2026-07-20',
  startTime: '22:00:00',
  endTime: '22:45:00',
  staffId: 'staff1',
  serviceId: 'svc1',
  serviceName: 'Haircut',
  clientId: 'cli1',
  state: 'BOOKED',
  activationState: 'ACTIVE',
  confirmed: true,
  deleted: false,
  bookingId: 'bk1',
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

const RANGE = { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:45:00Z' };
const makeClient = () =>
  phorest({ username: 'global/api@salon.com', password: 'p', businessId: 'biz1', branchId: 'br1' });

runConformance({
  provider: 'phorest',
  origin: 'https://platform.phorest.com',
  makeClient,
  errorProbe: {
    method: 'GET',
    path: '/third-party-api-server/api/business/biz1/branch/br1/appointment/missing',
    run: (c) => c.getBooking('missing'),
  },
  cases: [
    {
      name: 'getBooking recombines date + localtime into RFC3339',
      method: 'GET',
      path: '/third-party-api-server/api/business/biz1/branch/br1/appointment/ap123',
      reply: APPT,
      run: (c) => c.getBooking('ap123'),
      check: (b) => {
        expect(b.range.start).toBe('2026-07-20T22:00:00Z');
        expect(b.range.end).toBe('2026-07-20T22:45:00Z');
        expect(b.status).toBe('confirmed');
        expect(b.serviceId).toBe('svc1');
      },
    },
    {
      name: 'updateBooking reads version then PUTs',
      method: 'PUT',
      path: '/third-party-api-server/api/business/biz1/branch/br1/appointment/ap123',
      reply: APPT,
      run: (c) => c.updateBooking('ap123', { range: RANGE, providerOptions: { version: 1 } }),
      check: (b) => expect(b.range.end).toBe('2026-07-20T22:45:00Z'),
    },
    {
      name: 'cancelBooking posts to /appointment/cancel',
      method: 'POST',
      path: '/third-party-api-server/api/business/biz1/branch/br1/appointment/cancel',
      reply: '',
      run: (c) => c.cancelBooking('ap123', { reason: 'client request' }),
    },
    {
      name: 'listBookings reads _embedded + page',
      method: 'GET',
      path: '/third-party-api-server/api/business/biz1/branch/br1/appointment',
      reply: { _embedded: [APPT], page: { size: 20, totalElements: 1, totalPages: 1, number: 0 } },
      run: (c) => c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => expect(r.bookings).toHaveLength(1),
    },
    {
      name: 'searchAvailability posts to /appointments/availability',
      method: 'POST',
      path: '/third-party-api-server/api/business/biz1/branch/br1/appointments/availability',
      reply: [{ startTime: '2026-07-20T22:00:00Z', endTime: '2026-07-20T22:45:00Z', staffId: 'staff1' }],
      run: (c) => c.searchAvailability({ range: RANGE, serviceId: 'svc1' }),
      check: (slots) => expect(slots[0].start).toBe('2026-07-20T22:00:00Z'),
    },
  ],
});

// createBooking is a two-call flow (POST /booking then GET /appointment), which a
// single-interceptor runConformance case can't express — test it explicitly.
describe('phorest multi-call flows', () => {
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
  const P = '/third-party-api-server/api/business/biz1/branch/br1';
  const intercept = (method: string, path: string, body: unknown, status = 200) =>
    agent
      .get('https://platform.phorest.com')
      .intercept({ path: (p: string) => p.split('?')[0] === path, method })
      .reply(status, typeof body === 'string' ? body : JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });

  it('createBooking posts a booking then reads the created appointment', async () => {
    intercept('POST', `${P}/booking`, { bookingId: 'bk1' }, 201);
    intercept('GET', `${P}/appointment`, {
      _embedded: [APPT],
      page: { size: 20, totalElements: 1, totalPages: 1, number: 0 },
    });
    const b = await makeClient().createBooking({
      title: 'Haircut',
      range: RANGE,
      serviceId: 'svc1',
      staffId: 'staff1',
      customer: { id: 'cli1' },
    });
    expect(b.id).toBe('ap123');
  });

  it('updateBooking reads the current version when not supplied, then PUTs', async () => {
    intercept('GET', `${P}/appointment/ap123`, { ...APPT, version: 7 });
    intercept('PUT', `${P}/appointment/ap123`, APPT);
    const b = await makeClient().updateBooking('ap123', { range: RANGE });
    expect(b.id).toBe('ap123');
  });

  it('updateBooking sends both startTime and endTime on reschedule', async () => {
    intercept('GET', `${P}/appointment/ap123`, { ...APPT, version: 3 });
    let putBody: any;
    agent
      .get('https://platform.phorest.com')
      .intercept({ path: (p: string) => p.split('?')[0] === `${P}/appointment/ap123`, method: 'PUT' })
      .reply(200, (opts) => {
        putBody = JSON.parse(String(opts.body));
        return JSON.stringify(APPT);
      }, { headers: { 'content-type': 'application/json' } });
    await makeClient().updateBooking('ap123', { range: RANGE });
    expect(putBody.startTime).toBe('2026-07-20T22:00:00Z');
    expect(putBody.endTime).toBe('2026-07-20T22:45:00Z');
  });

  it('exposes the customers capability', () => {
    const c = makeClient();
    expect(c.capabilities.customers).toBe(true);
    expect(typeof c.customers?.findOrCreate).toBe('function');
  });

  it('rolls a midnight-crossing appointment end to the next day', async () => {
    const CROSS = { ...APPT, appointmentId: 'ap999', startTime: '23:30:00', endTime: '00:15:00' };
    intercept('GET', `${P}/appointment/ap999`, CROSS);
    const b = await makeClient().getBooking('ap999');
    expect(b.range.start).toBe('2026-07-20T23:30:00Z');
    expect(b.range.end).toBe('2026-07-21T00:15:00Z');
    expect(Date.parse(b.range.end) > Date.parse(b.range.start)).toBe(true);
  });

  it('listBookings returns a nextPageToken when more pages exist', async () => {
    intercept('GET', `${P}/appointment`, {
      _embedded: [APPT],
      page: { size: 20, totalElements: 40, totalPages: 2, number: 0 },
    });
    const r = await makeClient().listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
    });
    expect(r.nextPageToken).toBe('1');
  });
});
