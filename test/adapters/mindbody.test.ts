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
  makeClient: () => mindbody({ apiKey: 'k', siteId: '-99', accessToken: 'tok', utcOffset: '-08:00' }),
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
      name: 'updateBooking reschedules',
      method: 'PUT',
      path: '/public/v6/appointment/updateappointment',
      reply: { Appointment: APPT },
      run: (c) => c.updateBooking('101', { range: RANGE }),
    },
    {
      name: 'listBookings with pagination metadata',
      method: 'GET',
      path: APPTS_PATH,
      reply: { Appointments: [APPT], PaginationResponse: { TotalResults: 1 } },
      run: (c) => c.listBookings({ range: { start: '2026-07-20T00:00:00-08:00', end: '2026-07-21T00:00:00-08:00' } }),
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
          { StartDateTime: '2026-07-20T15:00:00', EndDateTime: '2026-07-20T15:45:00', Staff: { Id: 5 } },
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

  it('maps Completed to the completed status (not confirmed)', async () => {
    const pool = agent.get('https://api.mindbodyonline.com');
    pool
      .intercept({ path: (p) => p.startsWith(APPTS_PATH), method: 'GET' })
      .reply(200, JSON.stringify({ Appointments: [{ ...APPT, Status: 'Completed' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    const client = mindbody({ apiKey: 'k', siteId: '-99', accessToken: 'tok', utcOffset: '-08:00' });
    expect((await client.getBooking('101')).status).toBe('completed');
  });

  it('sends the list window as site-local (offset-stripped) dates', async () => {
    const pool = agent.get('https://api.mindbodyonline.com');
    let startDate: string | null = null;
    pool
      .intercept({ path: (p) => p.startsWith(APPTS_PATH), method: 'GET' })
      .reply(200, (opts) => {
        startDate = new URL('http://x' + opts.path).searchParams.get('StartDate');
        return JSON.stringify({ Appointments: [APPT] });
      }, { headers: { 'content-type': 'application/json' } });

    const client = mindbody({ apiKey: 'k', siteId: '-99', accessToken: 'tok', utcOffset: '-08:00' });
    await client.listBookings({ range: { start: '2026-07-20T00:00:00-08:00', end: '2026-07-21T00:00:00-08:00' } });
    // Previously the raw offset instant was forwarded, shifting Mindbody's
    // site-local window; now it's converted to the site's wall clock.
    expect(startDate).toBe('2026-07-20T00:00:00');
  });
});
