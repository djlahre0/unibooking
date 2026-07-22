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
  invoice_item_id: 'inv-item-1',
  start_time_utc: '2026-07-20T22:00:00',
  end_time_utc: '2026-07-20T22:45:00',
  status: 4, // Confirm (documented enum; there is no 6)
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

  /** Same, but records the query string and body the adapter actually sent. */
  const capture = (method: string, path: string, body: unknown) => {
    const seen: { query: URLSearchParams; body?: any } = { query: new URLSearchParams() };
    agent
      .get('https://api.zenoti.com')
      .intercept({ path: (p: string) => p.split('?')[0] === path, method })
      .reply(200, (opts: any) => {
        seen.query = new URLSearchParams(String(opts.path).split('?')[1] ?? '');
        seen.body = opts.body ? JSON.parse(String(opts.body)) : undefined;
        return typeof body === 'string' ? body : JSON.stringify(body);
      }, { headers: { 'content-type': 'application/json' } });
    return seen;
  };

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

  it('updateBooking reschedules in place, carrying invoice ids', async () => {
    const RANGE2 = { start: '2026-07-21T22:00:00Z', end: '2026-07-21T22:45:00Z' };
    intercept('GET', '/v1/appointments/appt1', APPT);
    let bookingBody: any;
    agent
      .get('https://api.zenoti.com')
      .intercept({ path: (p: string) => p.split('?')[0] === '/v1/bookings', method: 'POST' })
      .reply(200, (opts: any) => { bookingBody = JSON.parse(String(opts.body)); return JSON.stringify({ id: 'bk2' }); },
        { headers: { 'content-type': 'application/json' } });
    intercept('GET', '/v1/bookings/bk2/slots', { slots: [{ Time: '2026-07-21T22:00:00Z' }] });
    intercept('POST', '/v1/bookings/bk2/slots/reserve', { status: 'Reserved' });
    intercept('POST', '/v1/bookings/bk2/slots/confirm', { invoice: { items: [{ appointment_id: 'appt1' }] } });
    intercept('GET', '/v1/appointments/appt1', APPT);

    const b = await makeClient().updateBooking('appt1', { range: RANGE2 });

    // Reschedule threads the existing invoice ids so Zenoti moves the booking
    // rather than creating a second one and cancelling the first.
    expect(bookingBody.guests[0].invoice_id).toBe('inv1');
    expect(bookingBody.guests[0].items[0].invoice_item_id).toBe('inv-item-1');
    // No invoice cancel is issued, and the booking keeps its id.
    expect(b.id).toBe('appt1');
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

  // The documented enum is NoShow=-2, Cancelled=-1, New=0, Closed=1, Checkin=2,
  // Confirm=4, Break=10, NotSpecified=11, Available=20, Voided=21. The previous
  // table inverted -2/-1 and invented 5/6/99.
  it('maps the documented status enum, with no-show and cancelled the right way round', async () => {
    const table: Array<[number, string]> = [
      [-2, 'no_show'],
      [-1, 'cancelled'],
      [0, 'pending'],
      [1, 'completed'],
      [2, 'confirmed'],
      [4, 'confirmed'],
      [10, 'unknown'],
      [11, 'unknown'],
      [20, 'unknown'],
      [21, 'cancelled'],
    ];
    for (const [code, expected] of table) {
      intercept('GET', '/v1/appointments/appt1', { ...APPT, status: code });
      expect((await makeClient().getBooking('appt1')).status, `status ${code}`).toBe(expected);
    }
  });

  it('widens a same-day listBookings window — end_date is exclusive', async () => {
    const seen = capture('GET', '/v1/appointments', { appointments: [APPT] });
    const r = await makeClient().listBookings({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T23:00:00Z' },
    });
    expect(seen.query.get('start_date')).toBe('2026-07-20');
    // Same start/end dates collapse to an empty window upstream.
    expect(seen.query.get('end_date')).toBe('2026-07-21');
    expect(r.bookings).toHaveLength(1);
  });

  it('trims listBookings back to the caller instants', async () => {
    // The widened day window returns the 22:00Z appointment; the caller asked
    // only for 09:00–17:00.
    capture('GET', '/v1/appointments', { appointments: [APPT] });
    const r = await makeClient().listBookings({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T17:00:00Z' },
    });
    expect(r.bookings).toHaveLength(0);
  });

  it('asks for cancelled appointments explicitly and filters on mapped status', async () => {
    const seen = capture('GET', '/v1/appointments', {
      appointments: [APPT, { ...APPT, appointment_id: 'appt2', status: -1 }],
    });
    const r = await makeClient().listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
      status: 'cancelled',
    });
    // Without this flag Zenoti omits cancelled/no-show rows entirely.
    expect(seen.query.get('include_no_show_cancel')).toBe('true');
    expect(r.bookings.map((b) => b.id)).toEqual(['appt2']);
  });

  it('honors a listBookings limit client-side', async () => {
    capture('GET', '/v1/appointments', {
      appointments: [APPT, { ...APPT, appointment_id: 'appt2' }],
    });
    const r = await makeClient().listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
      limit: 1,
    });
    expect(r.bookings).toHaveLength(1);
    // The endpoint exposes no cursor, so none is fabricated.
    expect(r.nextPageToken).toBeUndefined();
  });

  it('rejects a listBookings pageToken rather than silently ignoring it', async () => {
    const err = await makeClient()
      .listBookings({
        range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
        pageToken: '2',
      })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('UNSUPPORTED');
  });

  it('rejects a multi-day availability range instead of returning day one', async () => {
    const err = await makeClient()
      .searchAvailability({
        range: { start: '2026-07-20T09:00:00Z', end: '2026-07-22T09:00:00Z' },
        serviceId: 'svc1',
        durationMinutes: 45,
        providerOptions: { guestId: 'g1' },
      })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('INVALID_INPUT');
    expect(err?.message).toContain('single');
  });

  it('anchors an offset-less slot Time in the caller range offset, not UTC', async () => {
    intercept('POST', '/v1/bookings', { id: 'bk4' });
    intercept('GET', '/v1/bookings/bk4/slots', { slots: [{ Time: '2026-07-20T14:00:00' }] });
    const slots = await makeClient().searchAvailability({
      range: { start: '2026-07-20T09:00:00-05:00', end: '2026-07-20T18:00:00-05:00' },
      serviceId: 'svc1',
      durationMinutes: 45,
      providerOptions: { guestId: 'g1' },
    });
    // Appending `Z` would claim a UTC instant the center-local wall clock is not.
    expect(slots[0]?.start).toBe('2026-07-20T14:00:00-05:00');
    expect(slots[0]?.end).toBe('2026-07-20T14:45:00-05:00');
  });

  it('forwards providerOptions to the availability booking, minus consumed keys', async () => {
    const seen = capture('POST', '/v1/bookings', { id: 'bk5' });
    intercept('GET', '/v1/bookings/bk5/slots', { slots: [] });
    await makeClient().searchAvailability({
      range: RANGE,
      serviceId: 'svc1',
      durationMinutes: 45,
      providerOptions: { guestId: 'g1', roomId: 'room9' },
    });
    expect(seen.body.roomId).toBe('room9');
    expect(seen.body.guestId).toBeUndefined();
  });

  it('does not leak consumed providerOptions into the booking body', async () => {
    const seen = capture('POST', '/v1/bookings', { id: 'bk6' });
    intercept('GET', '/v1/bookings/bk6/slots', { slots: [{ Time: '2026-07-20T22:00:00Z' }] });
    intercept('POST', '/v1/bookings/bk6/slots/reserve', { status: 'Reserved' });
    intercept('POST', '/v1/bookings/bk6/slots/confirm', { invoice: { items: [{ appointment_id: 'appt1' }] } });
    intercept('GET', '/v1/appointments/appt1', APPT);
    await makeClient().createBooking({
      title: 'x',
      range: RANGE,
      serviceId: 'svc1',
      providerOptions: { guestId: 'g1', countryCode: 91, roomId: 'room9' },
    });
    expect(seen.body.roomId).toBe('room9');
    expect(seen.body.guestId).toBeUndefined();
    expect(seen.body.countryCode).toBeUndefined();
  });

  it('sends country_code alongside the guest mobile when providerOptions supplies one', async () => {
    intercept('GET', '/v1/guests/search', { guests: [] });
    const guest = capture('POST', '/v1/guests', { id: 'g7' });
    intercept('POST', '/v1/bookings', { id: 'bk7' });
    intercept('GET', '/v1/bookings/bk7/slots', { slots: [{ Time: '2026-07-20T22:00:00Z' }] });
    intercept('POST', '/v1/bookings/bk7/slots/reserve', { status: 'Reserved' });
    intercept('POST', '/v1/bookings/bk7/slots/confirm', { invoice: { items: [{ appointment_id: 'appt1' }] } });
    intercept('GET', '/v1/appointments/appt1', APPT);
    await makeClient().createBooking({
      title: 'x',
      range: RANGE,
      serviceId: 'svc1',
      customer: { name: 'Jane Doe', email: 'jane@example.com', phone: '9885517727' },
      providerOptions: { countryCode: 91 },
    });
    expect(guest.body.personal_info.mobile_phone).toEqual({ number: '9885517727', country_code: 91 });
  });

  it('reads the guest phone from display_number when number is null', async () => {
    intercept('GET', '/v1/appointments/appt1', {
      ...APPT,
      guest: { ...APPT.guest, mobile: { number: null, display_number: '+91 9885517727' } },
    });
    const b = await makeClient().getBooking('appt1');
    expect(b.customer?.phone).toBe('+91 9885517727');
  });
});
