import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { mindbody } from '../../src/adapters/mindbody';
import { runConformance } from '../conformance';

const APPT = {
  Id: 101,
  StartDateTime: '2026-07-20T15:00:00',
  EndDateTime: '2026-07-20T15:45:00',
  StaffId: 5,
  SessionTypeId: 9,
  ClientId: 'C1',
  Status: 'Booked',
  Notes: 'Haircut',
};

const RANGE = { start: '2026-07-20T15:00:00-08:00', end: '2026-07-20T15:45:00-08:00' };
const APPTS_PATH = '/public/v6/appointment/staffappointments';

runConformance({
  provider: 'mindbody',
  origin: 'https://api.mindbodyonline.com',
  makeClient: () =>
    mindbody({
      apiKey: 'k',
      siteId: '-99',
      accessToken: 'tok',
      locationId: 'L1',
      utcOffset: '-08:00',
    }),
  errorProbe: { method: 'GET', path: APPTS_PATH, run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking applies the site offset to build a canonical instant',
      method: 'POST',
      path: '/public/v6/appointment/addappointment',
      reply: { Appointment: APPT },
      run: (c) =>
        c.createBooking({
          title: 'Haircut',
          range: RANGE,
          customer: { id: 'C1' },
          staffId: '5',
          serviceId: '9',
        }),
      check: (b) => {
        expect(b.range.start).toBe('2026-07-20T15:00:00-08:00');
        expect(b.staffId).toBe('5');
        expect(b.serviceId).toBe('9');
        expect(b.customer?.id).toBe('C1');
      },
    },
    {
      name: 'getBooking reads the appointment list',
      method: 'GET',
      path: APPTS_PATH,
      reply: { Appointments: [APPT] },
      run: (c) => c.getBooking('101'),
    },
    {
      name: 'updateBooking reschedules (POST, not PUT)',
      method: 'POST',
      path: '/public/v6/appointment/updateappointment',
      reply: { Appointment: APPT },
      run: (c) => c.updateBooking('101', { range: RANGE }),
    },
    {
      name: 'listBookings with pagination metadata',
      method: 'GET',
      path: APPTS_PATH,
      reply: { Appointments: [APPT], PaginationResponse: { TotalResults: 1 } },
      run: (c) =>
        c.listBookings({
          range: { start: '2026-07-20T00:00:00-08:00', end: '2026-07-21T00:00:00-08:00' },
        }),
      check: (r) => {
        expect(r.bookings).toHaveLength(1);
        expect(r.nextPageToken).toBeUndefined();
      },
    },
    {
      name: 'searchAvailability reads bookable items',
      method: 'GET',
      path: '/public/v6/appointment/bookableitems',
      reply: {
        Availabilities: [
          {
            StartDateTime: '2026-07-20T15:00:00',
            EndDateTime: '2026-07-20T15:45:00',
            Staff: { Id: 5 },
          },
        ],
      },
      run: (c) => c.searchAvailability({ range: RANGE, serviceId: '9' }),
      check: (slots) => {
        expect(slots).toHaveLength(1);
        expect(slots[0].staffId).toBe('5');
      },
    },
  ],
});

describe('mindbody: status mapping + site-local query window', () => {
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

  it('maps Completed to completed and Requested to pending (not unknown)', async () => {
    const pool = agent.get('https://api.mindbodyonline.com');
    pool
      .intercept({ path: (p) => p.startsWith(APPTS_PATH), method: 'GET' })
      .reply(200, JSON.stringify({ Appointments: [{ ...APPT, Status: 'Completed' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    pool
      .intercept({ path: (p) => p.startsWith(APPTS_PATH), method: 'GET' })
      .reply(200, JSON.stringify({ Appointments: [{ ...APPT, Status: 'Requested' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    const client = mindbody({
      apiKey: 'k',
      siteId: '-99',
      accessToken: 'tok',
      utcOffset: '-08:00',
    });
    expect((await client.getBooking('101')).status).toBe('completed');
    expect((await client.getBooking('101')).status).toBe('pending');
  });

  it('createBooking without a locationId is rejected (LocationId is required)', async () => {
    const client = mindbody({
      apiKey: 'k',
      siteId: '-99',
      accessToken: 'tok',
      utcOffset: '-08:00',
    });
    await expect(
      client.createBooking({
        title: 'x',
        range: RANGE,
        customer: { id: 'C1' },
        staffId: '5',
        serviceId: '9',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('sends the list window as site-local (offset-stripped) dates', async () => {
    const pool = agent.get('https://api.mindbodyonline.com');
    let startDate: string | null = null;
    pool.intercept({ path: (p) => p.startsWith(APPTS_PATH), method: 'GET' }).reply(
      200,
      (opts) => {
        startDate = new URL('http://x' + opts.path).searchParams.get('StartDate');
        return JSON.stringify({ Appointments: [APPT] });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = mindbody({
      apiKey: 'k',
      siteId: '-99',
      accessToken: 'tok',
      utcOffset: '-08:00',
    });
    await client.listBookings({
      range: { start: '2026-07-20T00:00:00-08:00', end: '2026-07-21T00:00:00-08:00' },
    });
    // Previously the raw offset instant was forwarded, shifting Mindbody's
    // site-local window; now it's converted to the site's wall clock.
    expect(startDate).toBe('2026-07-20T00:00:00');
  });
});

describe('mindbody: request payloads (spec diff, July 2026)', () => {
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

  const CREDS = {
    apiKey: 'k',
    siteId: '-99',
    accessToken: 'tok',
    locationId: 'L1',
    utcOffset: '-08:00',
  };
  const JSON_HEADERS = { 'content-type': 'application/json' };
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

  it('getBooking sends a wide date window (StartDate defaults to today)', async () => {
    let params: URLSearchParams | undefined;
    // Dated a year out: findable only when a window accompanies the id.
    const nextYear = {
      ...APPT,
      StartDateTime: '2027-07-20T15:00:00',
      EndDateTime: '2027-07-20T15:45:00',
    };
    agent
      .get('https://api.mindbodyonline.com')
      .intercept({ path: (p) => p.startsWith(APPTS_PATH), method: 'GET' })
      .reply(
        200,
        (opts: any) => {
          params = new URL('http://x' + opts.path).searchParams;
          return JSON.stringify({ Appointments: [nextYear] });
        },
        { headers: JSON_HEADERS },
      );

    const b = await mindbody(CREDS).getBooking('101');
    expect(params!.get('AppointmentIds')).toBe('101');
    const startMs = Date.parse(params!.get('StartDate')! + 'Z');
    const endMs = Date.parse(params!.get('EndDate')! + 'Z');
    expect(Date.now() - startMs).toBeGreaterThan(YEAR_MS);
    expect(endMs - Date.now()).toBeGreaterThan(YEAR_MS);
    expect(b.range.start).toBe('2027-07-20T15:00:00-08:00');
  });

  it('updateBooking sends EndDateTime, SessionTypeId and Notes', async () => {
    let body: any;
    agent
      .get('https://api.mindbodyonline.com')
      .intercept({ path: (p) => p.includes('/appointment/updateappointment'), method: 'POST' })
      .reply(
        200,
        (opts: any) => {
          body = JSON.parse(String(opts.body));
          return JSON.stringify({ Appointment: APPT });
        },
        { headers: JSON_HEADERS },
      );

    await mindbody(CREDS).updateBooking('101', { range: RANGE, serviceId: '9', title: 'Trim' });
    expect(body.AppointmentId).toBe(101);
    expect(body.StartDateTime).toBe('2026-07-20T15:00:00');
    // Without EndDateTime the staff default duration silently replaces the range.
    expect(body.EndDateTime).toBe('2026-07-20T15:45:00');
    expect(body.SessionTypeId).toBe('9');
    expect(body.Notes).toBe('Trim');
  });

  it('updateBooking rejects a status change and points at cancelBooking()', async () => {
    const client = mindbody(CREDS);
    await expect(client.updateBooking('101', { status: 'cancelled' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('cancelBooking()'),
    });
    await expect(client.updateBooking('101', { status: 'completed' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects a non-numeric appointment id client-side (AppointmentId is an int)', async () => {
    const client = mindbody(CREDS);
    await expect(client.cancelBooking('abc')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.updateBooking('abc', { title: 'x' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('createBooking round-trips the title through Notes and maps notify to SendEmail', async () => {
    let body: any;
    agent
      .get('https://api.mindbodyonline.com')
      .intercept({ path: (p) => p.includes('/appointment/addappointment'), method: 'POST' })
      .reply(
        200,
        (opts: any) => {
          body = JSON.parse(String(opts.body));
          return JSON.stringify({ Appointment: { ...APPT, Notes: body.Notes } });
        },
        { headers: JSON_HEADERS },
      );

    const b = await mindbody(CREDS).createBooking({
      title: 'Beard trim',
      range: RANGE,
      customer: { id: 'C1' },
      staffId: '5',
      serviceId: '9',
      notify: false,
    });
    expect(body.Notes).toBe('Beard trim');
    expect(body.SendEmail).toBe(false);
    expect(b.title).toBe('Beard trim');
  });

  it('does not read a serviceId from AppointmentTypeId (not a v6 field)', async () => {
    agent
      .get('https://api.mindbodyonline.com')
      .intercept({ path: (p) => p.startsWith(APPTS_PATH), method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          Appointments: [{ ...APPT, SessionTypeId: undefined, AppointmentTypeId: 77 }],
        }),
        { headers: JSON_HEADERS },
      );
    const b = await mindbody(CREDS).getBooking('101');
    expect(b.serviceId).toBeUndefined();
  });

  it('listBookings forwards customerId as ClientId and the site location', async () => {
    let params: URLSearchParams | undefined;
    agent
      .get('https://api.mindbodyonline.com')
      .intercept({ path: (p) => p.startsWith(APPTS_PATH), method: 'GET' })
      .reply(
        200,
        (opts: any) => {
          params = new URL('http://x' + opts.path).searchParams;
          return JSON.stringify({ Appointments: [APPT] });
        },
        { headers: JSON_HEADERS },
      );

    await mindbody(CREDS).listBookings({
      range: { start: '2026-07-20T00:00:00-08:00', end: '2026-07-21T00:00:00-08:00' },
      customerId: 'C1',
      staffId: '5',
    });
    expect(params!.get('ClientId')).toBe('C1');
    expect(params!.get('LocationIds')).toBe('L1');
    expect(params!.get('StaffIds')).toBe('5');
  });

  it('searchAvailability slices a bookable window into discrete slots', async () => {
    agent
      .get('https://api.mindbodyonline.com')
      .intercept({
        path: (p) => p.startsWith('/public/v6/appointment/bookableitems'),
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          Availabilities: [
            {
              StartDateTime: '2026-07-20T09:00:00',
              EndDateTime: '2026-07-20T17:00:00',
              BookableEndDateTime: '2026-07-20T16:00:00',
              Staff: { Id: 5 },
            },
          ],
        }),
        { headers: JSON_HEADERS },
      );

    const slots = await mindbody(CREDS).searchAvailability({
      range: { start: '2026-07-20T09:00:00-08:00', end: '2026-07-20T17:00:00-08:00' },
      serviceId: '9',
      durationMinutes: 60,
    });
    // 09:00..16:00 inclusive — the whole window used to come back as ONE 8h slot.
    expect(slots).toHaveLength(8);
    expect(slots[0]!.start).toBe('2026-07-20T09:00:00-08:00');
    expect(slots[0]!.end).toBe('2026-07-20T10:00:00-08:00');
    expect(slots.at(-1)!.start).toBe('2026-07-20T16:00:00-08:00');
    const lastStart = Date.parse('2026-07-20T16:00:00-08:00');
    expect(slots.every((s) => Date.parse(s.start) <= lastStart)).toBe(true);
    expect(slots.every((s) => s.staffId === '5')).toBe(true);
    // The raw window stays attached to every slice.
    expect((slots[0]!.raw as any).BookableEndDateTime).toBe('2026-07-20T16:00:00');
  });

  it('searchAvailability falls back to the session type default length', async () => {
    agent
      .get('https://api.mindbodyonline.com')
      .intercept({
        path: (p) => p.startsWith('/public/v6/appointment/bookableitems'),
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          Availabilities: [
            {
              StartDateTime: '2026-07-20T09:00:00',
              EndDateTime: '2026-07-20T11:00:00',
              SessionType: { Id: 9, DefaultTimeLength: 30 },
            },
          ],
        }),
        { headers: JSON_HEADERS },
      );

    const slots = await mindbody(CREDS).searchAvailability({
      range: { start: '2026-07-20T09:00:00-08:00', end: '2026-07-20T11:00:00-08:00' },
      serviceId: '9',
    });
    expect(slots).toHaveLength(4);
    expect(slots[1]!.start).toBe('2026-07-20T09:30:00-08:00');
  });

  it('searchAvailability keeps the window when no duration can be determined', async () => {
    agent
      .get('https://api.mindbodyonline.com')
      .intercept({
        path: (p) => p.startsWith('/public/v6/appointment/bookableitems'),
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          Availabilities: [
            { StartDateTime: '2026-07-20T09:00:00', EndDateTime: '2026-07-20T17:00:00' },
          ],
        }),
        { headers: JSON_HEADERS },
      );

    const slots = await mindbody(CREDS).searchAvailability({
      range: { start: '2026-07-20T09:00:00-08:00', end: '2026-07-20T17:00:00-08:00' },
      serviceId: '9',
    });
    expect(slots).toHaveLength(1);
    expect(slots[0]!.end).toBe('2026-07-20T17:00:00-08:00');
  });
});
