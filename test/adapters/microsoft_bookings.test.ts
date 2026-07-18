import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { microsoftBookings } from '../../src/adapters/microsoft_bookings';
import { runConformance } from '../conformance';

// Graph's bookingAppointment uses `start`/`end` (dateTimeTimeZone), NOT
// `startDateTime`/`endDateTime`.
const APPT = {
  id: 'a1',
  serviceId: 'svc1',
  serviceName: 'Haircut',
  staffMemberIds: ['staff1'],
  start: { dateTime: '2026-07-20T22:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-07-20T22:45:00.0000000', timeZone: 'UTC' },
  customers: [{ name: 'Jane', emailAddress: 'jane@example.com' }],
};

const BIZ = 'contoso@contoso.onmicrosoft.com';
const APPTS = `/v1.0/solutions/bookingBusinesses/${encodeURIComponent(BIZ)}/appointments`;
const VIEW = `/v1.0/solutions/bookingBusinesses/${encodeURIComponent(BIZ)}/calendarView`;
const RANGE = { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:45:00Z' };

runConformance({
  provider: 'microsoft_bookings',
  origin: 'https://graph.microsoft.com',
  makeClient: () => microsoftBookings({ accessToken: 'token', businessId: BIZ }),
  errorProbe: { method: 'GET', path: APPTS, run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking maps staff + service',
      method: 'POST',
      path: APPTS,
      reply: APPT,
      run: (c) =>
        c.createBooking({
          title: 'Haircut',
          range: RANGE,
          serviceId: 'svc1',
          staffId: 'staff1',
          customer: { name: 'Jane', email: 'jane@example.com' },
        }),
      check: (b) => {
        expect(b.staffId).toBe('staff1');
        expect(b.serviceId).toBe('svc1');
        expect(b.range.end).toBe('2026-07-20T22:45:00Z');
      },
    },
    {
      name: 'getBooking',
      method: 'GET',
      path: APPTS,
      reply: APPT,
      run: (c) => c.getBooking('a1'),
    },
    {
      name: 'cancelBooking posts /cancel',
      method: 'POST',
      path: `${APPTS}/a1/cancel`,
      reply: '',
      run: (c) => c.cancelBooking('a1', { reason: 'client asked' }),
    },
    {
      name: 'listBookings via calendarView',
      method: 'GET',
      path: VIEW,
      reply: { value: [APPT] },
      run: (c) => c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => expect(r.bookings).toHaveLength(1),
    },
  ],
});

describe('microsoft_bookings: update handles the 204 PATCH by re-GETting', () => {
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

  it('sends start/end on PATCH (204) then re-GETs the appointment', async () => {
    const pool = agent.get('https://graph.microsoft.com');
    let patchBody: any;
    pool
      .intercept({ path: (p) => p.startsWith(`${APPTS}/a1`), method: 'PATCH' })
      .reply(204, (opts) => {
        patchBody = JSON.parse(String(opts.body));
        return '';
      });
    pool
      .intercept({ path: (p) => p.startsWith(`${APPTS}/a1`), method: 'GET' })
      .reply(200, JSON.stringify(APPT), { headers: { 'content-type': 'application/json' } });

    const client = microsoftBookings({ accessToken: 't', businessId: BIZ });
    const b = await client.updateBooking('a1', { range: RANGE });

    // The reschedule targets `start`/`end` (dateTimeTimeZone), not startDateTime.
    expect(patchBody.start.dateTime).toBeTruthy();
    expect(patchBody.startDateTime).toBeUndefined();
    expect(b.range.end).toBe('2026-07-20T22:45:00Z');
    agent.assertNoPendingInterceptors();
  });
});
