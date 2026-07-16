import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getGlobalDispatcher,
  MockAgent,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { zenoti } from '../../src/adapters/zenoti';
import { runConformance } from '../conformance';

const APPT = {
  appointment_id: 'appt1',
  invoice_id: 'inv1',
  start_time_utc: '2026-07-20T22:00:00',
  end_time_utc: '2026-07-20T22:45:00',
  status: 6, // Confirmed
  therapist: { id: 'th1', first_name: 'Jo' },
  service: { id: 'svc1', name: 'Facial' },
  guest: {
    id: 'g1',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@example.com',
    mobile: { number: '+15550100' },
  },
  creation_date_utc: '2026-07-01T00:00:00',
};

const RANGE = { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:45:00Z' };
const makeClient = () => zenoti({ apiKey: 'k', centerId: 'c1' });

runConformance({
  provider: 'zenoti',
  origin: 'https://api.zenoti.com',
  makeClient,
  errorProbe: { method: 'GET', path: '/v1/appointments/missing', run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'getBooking maps _utc times and integer status',
      method: 'GET',
      path: '/v1/appointments/appt1',
      reply: APPT,
      run: (c) => c.getBooking('appt1'),
      check: (b) => {
        expect(b.range.start).toBe('2026-07-20T22:00:00Z');
        expect(b.status).toBe('confirmed');
        expect(b.staffId).toBe('th1');
        expect(b.serviceId).toBe('svc1');
        expect(b.customer?.email).toBe('jane@example.com');
        expect(b.customer?.phone).toBe('+15550100');
      },
    },
    {
      name: 'listBookings reads appointments[]',
      method: 'GET',
      path: '/v1/appointments',
      reply: { appointments: [APPT] },
      run: (c) => c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => expect(r.bookings).toHaveLength(1),
    },
  ],
});

// createBooking / cancelBooking / searchAvailability drive multi-call flows that a
// single conformance case can't express; test them with explicit interceptors.
describe('zenoti multi-step flows', () => {
  it('exposes availability + customers capabilities', () => {
    const c = makeClient();
    expect(c.capabilities.availability).toBe(true);
    expect(c.capabilities.customers).toBe(true);
    expect(typeof c.customers?.findOrCreate).toBe('function');
  });
});

describe('zenoti flows', () => {
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
  const intercept = (method: string, path: string, body: unknown) =>
    agent
      .get('https://api.zenoti.com')
      .intercept({ path: (p: string) => p.split('?')[0] === path, method })
      .reply(200, typeof body === 'string' ? body : JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });

  it('createBooking runs the reserve/confirm flow', async () => {
    intercept('POST', '/v1/bookings', { id: 'bk1' });
    intercept('GET', '/v1/bookings/bk1/slots', { slots: [{ Time: '2026-07-20T22:00:00Z' }] });
    intercept('POST', '/v1/bookings/bk1/slots/reserve', { status: 'Reserved' });
    intercept('POST', '/v1/bookings/bk1/slots/confirm', { invoice: { items: [{ appointment_id: 'appt1' }] } });
    intercept('GET', '/v1/appointments/appt1', APPT);
    const b = await makeClient().createBooking({ title: 'x', range: RANGE, serviceId: 'svc1', customer: { id: 'g1' } });
    expect(b.id).toBe('appt1');
  });

  it('cancelBooking looks up invoice then cancels', async () => {
    intercept('GET', '/v1/appointments/appt1', APPT);
    intercept('PUT', '/v1/invoices/inv1/cancel', '');
    await expect(makeClient().cancelBooking('appt1', { reason: 'x' })).resolves.toBeUndefined();
  });

  it('searchAvailability creates a transient booking and reads slots', async () => {
    intercept('POST', '/v1/bookings', { id: 'bk1' });
    intercept('GET', '/v1/bookings/bk1/slots', { slots: [{ Time: '2026-07-20T22:00:00Z' }] });
    // providerOptions is now a typed AvailabilityQuery field (no `as any`), and a
    // durationMinutes is required so slots aren't zero-length.
    const slots = await makeClient().searchAvailability({
      range: RANGE,
      serviceId: 'svc1',
      durationMinutes: 45,
      providerOptions: { guestId: 'g1' },
    });
    expect(slots[0]?.start).toBe('2026-07-20T22:00:00Z');
    expect(slots[0]?.end).toBe('2026-07-20T22:45:00Z');
  });

  it('searchAvailability requires durationMinutes (no zero-length slots)', async () => {
    const err = await makeClient()
      .searchAvailability({ range: RANGE, serviceId: 'svc1', providerOptions: { guestId: 'g1' } })
      .catch((e) => e);
    expect(err.code).toBe('INVALID_INPUT');
  });

  it('books using the wall-clock date, not the UTC date, near midnight', async () => {
    let bookingBody: any;
    agent
      .get('https://api.zenoti.com')
      .intercept({ path: (p: string) => p.split('?')[0] === '/v1/bookings', method: 'POST' })
      .reply(200, (opts) => {
        bookingBody = JSON.parse(String(opts.body));
        return JSON.stringify({ id: 'bkX' });
      }, { headers: { 'content-type': 'application/json' } });
    intercept('GET', '/v1/bookings/bkX/slots', { slots: [{ Time: '2026-07-20T22:00:00-05:00' }] });
    intercept('POST', '/v1/bookings/bkX/slots/reserve', { status: 'Reserved' });
    intercept('POST', '/v1/bookings/bkX/slots/confirm', { invoice: { items: [{ appointment_id: 'apptX' }] } });
    intercept('GET', '/v1/appointments/apptX', { ...APPT, appointment_id: 'apptX' });
    await makeClient().createBooking({
      title: 'x',
      // 10pm center-local = 03:00Z the next day; the booking date must stay the 20th.
      range: { start: '2026-07-20T22:00:00-05:00', end: '2026-07-20T22:45:00-05:00' },
      serviceId: 'svc1',
      customer: { id: 'g1' },
    });
    expect(bookingBody.date).toBe('2026-07-20');
  });

  it('updateBooking reschedules by re-booking then cancelling the old invoice', async () => {
    const RANGE2 = { start: '2026-07-21T22:00:00Z', end: '2026-07-21T22:45:00Z' };
    intercept('GET', '/v1/appointments/appt1', APPT); // current appt: service svc1, guest g1, invoice inv1
    intercept('POST', '/v1/bookings', { id: 'bk2' });
    intercept('GET', '/v1/bookings/bk2/slots', { slots: [{ Time: '2026-07-21T22:00:00Z' }] });
    intercept('POST', '/v1/bookings/bk2/slots/reserve', { status: 'Reserved' });
    intercept('POST', '/v1/bookings/bk2/slots/confirm', { invoice: { items: [{ appointment_id: 'appt2' }] } });
    intercept('PUT', '/v1/invoices/inv1/cancel', '');
    intercept('GET', '/v1/appointments/appt2', { ...APPT, appointment_id: 'appt2' });
    const b = await makeClient().updateBooking('appt1', { range: RANGE2 });
    expect(b.id).toBe('appt2');
  });

  it('customers.findOrCreate returns an existing guest id by email', async () => {
    intercept('GET', '/v1/guests/search', { guests: [{ id: 'g9' }] });
    const id = await makeClient().customers!.findOrCreate({ email: 'jane@example.com' });
    expect(id).toBe('g9');
  });

  it('createBooking matches a wall-clock slot when the caller uses the center offset', async () => {
    intercept('POST', '/v1/bookings', { id: 'bk3' });
    intercept('GET', '/v1/bookings/bk3/slots', { slots: [{ Time: '2026-07-20T14:00:00' }] });
    intercept('POST', '/v1/bookings/bk3/slots/reserve', { status: 'Reserved' });
    intercept('POST', '/v1/bookings/bk3/slots/confirm', { invoice: { items: [{ appointment_id: 'appt3' }] } });
    intercept('GET', '/v1/appointments/appt3', { ...APPT, appointment_id: 'appt3' });
    const b = await makeClient().createBooking({
      title: 'x',
      range: { start: '2026-07-20T14:00:00-05:00', end: '2026-07-20T14:45:00-05:00' },
      serviceId: 'svc1',
      customer: { id: 'g1' },
    });
    expect(b.id).toBe('appt3');
  });
});
