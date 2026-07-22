import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
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

// BookingResponse carries the new appointment id under
// clientAppointmentSchedules[].serviceSchedules[] — never at the top level.
const BOOKING_RESPONSE = {
  bookingStatus: 'CONFIRMED',
  clientId: 'cli1',
  bookingId: 'bk1',
  schedules: [{ startTime: '2026-07-20T22:00:00Z', endTime: '2026-07-20T22:45:00Z' }],
  clientAppointmentSchedules: [
    {
      clientId: 'cli1',
      serviceSchedules: [{ serviceId: 'svc1', staffId: 'staff1', appointmentId: 'ap123' }],
    },
  ],
  links: [],
};

// Availability: `{ data: [...], links: [...] }`, where each entry carries only a
// startTime and the end/staff live under clientSchedules[].serviceSchedules[].
const AVAILABILITY = {
  data: [
    {
      startTime: '2026-07-20T22:00:00Z',
      clientSchedules: [
        {
          clientId: 'cli1',
          serviceSchedules: [
            {
              serviceId: 'svc1',
              staffId: 'staff1',
              startTime: '2026-07-20T22:00:00Z',
              endTime: '2026-07-20T22:45:00Z',
            },
            {
              serviceId: 'svc1',
              staffId: 'staff2',
              startTime: '2026-07-20T22:00:00Z',
              endTime: '2026-07-20T23:00:00Z',
            },
          ],
        },
      ],
    },
  ],
  links: [],
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
      run: (c) =>
        c.updateBooking('ap123', {
          range: RANGE,
          staffId: 'stf1',
          providerOptions: { version: 1 },
        }),
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
      run: (c) =>
        c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => expect(r.bookings).toHaveLength(1),
    },
    {
      name: 'searchAvailability posts to /appointments/availability',
      method: 'POST',
      path: '/third-party-api-server/api/business/biz1/branch/br1/appointments/availability',
      reply: AVAILABILITY,
      run: (c) => c.searchAvailability({ range: RANGE, serviceId: 'svc1' }),
      check: (slots) => {
        // One slot per staff schedule, end/staff taken from the nested schedule.
        expect(slots).toHaveLength(2);
        expect(slots[0].start).toBe('2026-07-20T22:00:00Z');
        expect(slots[0].end).toBe('2026-07-20T22:45:00Z');
        expect(slots[0].staffId).toBe('staff1');
        expect(slots[1].end).toBe('2026-07-20T23:00:00Z');
        expect(slots[1].staffId).toBe('staff2');
      },
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
    intercept('POST', `${P}/booking`, BOOKING_RESPONSE, 201);
    intercept('GET', `${P}/appointment/ap123`, APPT);
    const b = await makeClient().createBooking({
      title: 'Haircut',
      range: RANGE,
      serviceId: 'svc1',
      staffId: 'staff1',
      customer: { id: 'cli1' },
    });
    expect(b.id).toBe('ap123');
    expect(b.range.start).toBe('2026-07-20T22:00:00Z');
    expect(b.status).toBe('confirmed');
  });

  it('createBooking rejects a missing staffId before calling Phorest', async () => {
    const err = await makeClient()
      .createBooking({
        title: 'Haircut',
        range: RANGE,
        serviceId: 'svc1',
        customer: { id: 'cli1' },
      })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('INVALID_INPUT');
    expect(err?.message).toContain('staffId');
  });

  it('updateBooking reads the current version when not supplied, then PUTs', async () => {
    intercept('GET', `${P}/appointment/ap123`, { ...APPT, version: 7 });
    intercept('PUT', `${P}/appointment/ap123`, APPT);
    const b = await makeClient().updateBooking('ap123', { range: RANGE });
    expect(b.id).toBe('ap123');
  });

  const capturePut = (): (() => any) => {
    let putBody: any;
    agent
      .get('https://platform.phorest.com')
      .intercept({
        path: (p: string) => p.split('?')[0] === `${P}/appointment/ap123`,
        method: 'PUT',
      })
      .reply(
        200,
        (opts) => {
          putBody = JSON.parse(String(opts.body));
          return JSON.stringify(APPT);
        },
        { headers: { 'content-type': 'application/json' } },
      );
    return () => putBody;
  };

  it('updateBooking sends appointmentDate plus LocalTime start/end on reschedule', async () => {
    intercept('GET', `${P}/appointment/ap123`, { ...APPT, version: 3 });
    const putBody = capturePut();
    await makeClient().updateBooking('ap123', { range: RANGE });
    // AppointmentUpdateRequest wants a yyyy-MM-dd date + HH:mm:ss LocalTimes,
    // not RFC3339 instants.
    expect(putBody().appointmentDate).toBe('2026-07-20');
    expect(putBody().startTime).toBe('22:00:00');
    expect(putBody().endTime).toBe('22:45:00');
  });

  it('updateBooking derives the reschedule date in UTC, so it can cross days', async () => {
    intercept('GET', `${P}/appointment/ap123`, { ...APPT, version: 3 });
    const putBody = capturePut();
    // 20:00-07:00 on the 20th is 03:00Z on the 21st — the UTC day, not the local one.
    await makeClient().updateBooking('ap123', {
      range: { start: '2026-07-20T20:00:00-07:00', end: '2026-07-20T20:45:00-07:00' },
    });
    expect(putBody().appointmentDate).toBe('2026-07-21');
    expect(putBody().startTime).toBe('03:00:00');
    expect(putBody().endTime).toBe('03:45:00');
  });

  it('updateBooking status:cancelled routes to /appointment/cancel', async () => {
    intercept('POST', `${P}/appointment/cancel`, '');
    intercept('GET', `${P}/appointment/ap123`, { ...APPT, activationState: 'CANCELED' });
    const b = await makeClient().updateBooking('ap123', { status: 'cancelled' });
    expect(b.status).toBe('cancelled');
  });

  it('updateBooking status:confirmed routes to /appointment/confirm', async () => {
    intercept('POST', `${P}/appointment/confirm`, '');
    intercept('GET', `${P}/appointment/ap123`, APPT);
    const b = await makeClient().updateBooking('ap123', { status: 'confirmed' });
    expect(b.status).toBe('confirmed');
  });

  it('updateBooking rejects a status Phorest has no transition for', async () => {
    const err = await makeClient()
      .updateBooking('ap123', { status: 'no_show' })
      .then(() => null)
      .catch((e: any) => e);
    expect(err?.code).toBe('UNSUPPORTED');
  });

  it('searchAvailability skips entries with no derivable end', async () => {
    intercept('POST', `${P}/appointments/availability`, {
      data: [
        { startTime: '2026-07-20T22:00:00Z', clientSchedules: [] },
        {
          startTime: '2026-07-20T23:00:00Z',
          clientSchedules: [{ serviceSchedules: [{ staffId: 'staff1' }] }],
        },
        AVAILABILITY.data[0],
      ],
      links: [],
    });
    const slots = await makeClient().searchAvailability({ range: RANGE, serviceId: 'svc1' });
    expect(slots).toHaveLength(2);
    expect(slots.every((s) => s.start === '2026-07-20T22:00:00Z')).toBe(true);
  });

  it('base64-encodes non-Latin-1 credentials as UTF-8', async () => {
    let auth = '';
    agent
      .get('https://platform.phorest.com')
      .intercept({
        path: (p: string) => p.split('?')[0] === `${P}/appointment/ap123`,
        method: 'GET',
      })
      .reply(
        200,
        (opts: any) => {
          auth = String(opts.headers.authorization ?? opts.headers.Authorization ?? '');
          return JSON.stringify(APPT);
        },
        { headers: { 'content-type': 'application/json' } },
      );
    await phorest({
      username: 'global/api@salon.com',
      password: 'pässwörd☕',
      businessId: 'biz1',
      branchId: 'br1',
    }).getBooking('ap123');
    expect(auth.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(auth.slice(6), 'base64').toString('utf8')).toBe(
      'global/api@salon.com:pässwörd☕',
    );
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

  const captureList = (body: unknown): (() => string) => {
    let path = '';
    agent
      .get('https://platform.phorest.com')
      .intercept({ path: (p: string) => p.split('?')[0] === `${P}/appointment`, method: 'GET' })
      .reply(
        200,
        (opts: any) => {
          path = String(opts.path);
          return JSON.stringify(body);
        },
        { headers: { 'content-type': 'application/json' } },
      );
    return () => path;
  };

  it('listBookings derives from_date/to_date in UTC and trims to the requested instants', async () => {
    const IN = {
      ...APPT,
      appointmentId: 'ap777',
      appointmentDate: '2026-07-21',
      startTime: '05:00:00',
      endTime: '05:30:00',
    };
    const LATE = {
      ...APPT,
      appointmentId: 'ap888',
      appointmentDate: '2026-07-22',
      startTime: '04:00:00',
      endTime: '04:30:00',
    };
    const path = captureList({
      _embedded: [APPT, IN, LATE],
      page: { size: 20, totalElements: 3, totalPages: 1, number: 0 },
    });
    const r = await makeClient().listBookings({
      // 20:00-07:00 is 03:00Z the next UTC day; slicing the offset string would
      // shift the whole window back a day.
      range: { start: '2026-07-20T20:00:00-07:00', end: '2026-07-21T20:00:00-07:00' },
    });
    expect(path()).toContain('from_date=2026-07-21');
    expect(path()).toContain('to_date=2026-07-22');
    // to_date is inclusive, so the extra day it returns is trimmed client-side.
    expect(r.bookings.map((b) => b.id)).toEqual(['ap777']);
  });

  it('listBookings asks for cancelled appointments and filters on the mapped status', async () => {
    const CANCELLED = { ...APPT, appointmentId: 'ap555', activationState: 'CANCELED' };
    const path = captureList({
      _embedded: [APPT, CANCELLED],
      page: { size: 20, totalElements: 2, totalPages: 1, number: 0 },
    });
    const r = await makeClient().listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
      status: 'cancelled',
    });
    expect(path()).toContain('fetch_canceled=true');
    expect(r.bookings.map((b) => b.id)).toEqual(['ap555']);
  });

  it('listBookings clamps size to the documented maximum of 100', async () => {
    const path = captureList({
      _embedded: [],
      page: { size: 100, totalElements: 0, totalPages: 0, number: 0 },
    });
    await makeClient().listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
      limit: 500,
    });
    expect(path()).toContain('size=100');
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

describe('phorest: update backfills required fields', () => {
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

  it('reads current staffId/startTime when the patch omits them', async () => {
    // AppointmentUpdateRequest marks appointmentId, staffId, startTime and
    // version required, so a serviceId-only patch must backfill the rest.
    const pool = agent.get('https://platform.phorest.com');
    pool
      .intercept({ path: (p) => p.endsWith('/appointment/ap123'), method: 'GET' })
      .reply(200, JSON.stringify({ ...APPT, version: 7, staffId: 'stf-current' }), {
        headers: { 'content-type': 'application/json' },
      });
    let body: any;
    pool.intercept({ path: (p) => p.endsWith('/appointment/ap123'), method: 'PUT' }).reply(
      200,
      (opts: any) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify(APPT);
      },
      { headers: { 'content-type': 'application/json' } },
    );

    await makeClient().updateBooking('ap123', { serviceId: 'svc-new' });

    expect(body.appointmentId).toBe('ap123');
    expect(body.version).toBe(7);
    expect(body.staffId).toBe('stf-current');
    // Backfilled verbatim: current.appointmentDate + current.startTime are
    // already Phorest's date + LocalTime pair.
    expect(body.appointmentDate).toBe('2026-07-20');
    expect(body.startTime).toBe('22:00:00');
    expect(body.serviceId).toBe('svc-new');
  });
});
