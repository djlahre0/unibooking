import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { boulevard } from '../../src/adapters/boulevard';
import { runConformance } from '../conformance';

const ORIGIN = 'https://dashboard.boulevard.io';
const GQL = '/api/2020-01/admin';
const START = '2026-07-20T22:00:00Z';
// A valid base64 secret (base64ToBytes -> atob must not throw).
const CREDS = { businessId: 'biz1', apiKey: 'key1', apiSecret: 'c2VjcmV0' };

function appt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'APT1',
    startAt: START,
    endAt: '2026-07-20T22:45:00Z',
    state: 'CONFIRMED',
    client: { id: 'CL1', name: 'Jane Doe', email: 'jane@example.com' },
    appointmentServices: [{ service: { id: 'SVC1', name: 'Haircut' }, staff: { id: 'STF1' } }],
    createdAt: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

const RANGE = { start: START, end: '2026-07-20T22:45:00Z' };

runConformance({
  provider: 'boulevard',
  origin: ORIGIN,
  makeClient: () => boulevard(CREDS),
  errorProbe: { method: 'POST', path: GQL, run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking maps the appointment from bookingCreate',
      method: 'POST',
      path: GQL,
      reply: { data: { bookingCreate: { appointment: appt() } } },
      run: (c) =>
        c.createBooking({
          title: 'Haircut',
          range: RANGE,
          customer: { id: 'CL1' },
          staffId: 'STF1',
          serviceId: 'SVC1',
        }),
      check: (b) => {
        expect(b.id).toBe('APT1');
        expect(b.range.start).toBe(START);
        expect(b.range.end).toBe('2026-07-20T22:45:00Z');
        expect(b.staffId).toBe('STF1');
        expect(b.serviceId).toBe('SVC1');
        expect(b.status).toBe('confirmed');
      },
    },
    {
      name: 'getBooking maps a cancelled appointment',
      method: 'POST',
      path: GQL,
      reply: { data: { appointment: appt({ state: 'CANCELLED' }) } },
      run: (c) => c.getBooking('APT1'),
      check: (b) => expect(b.status).toBe('cancelled'),
    },
    {
      name: 'updateBooking with a range reschedules natively',
      method: 'POST',
      path: GQL,
      reply: { data: { appointmentReschedule: { appointment: appt() } } },
      run: (c) => c.updateBooking('APT1', { range: RANGE }),
    },
    {
      name: 'cancelBooking calls cancelAppointment',
      method: 'POST',
      path: GQL,
      reply: { data: { cancelAppointment: { appointment: appt({ state: 'CANCELLED' }) } } },
      run: (c) => c.cancelBooking('APT1', { reason: 'client asked' }),
    },
    {
      name: 'listBookings maps a connection + end cursor',
      method: 'POST',
      path: GQL,
      reply: {
        data: {
          appointments: {
            edges: [{ node: appt() }],
            pageInfo: { endCursor: 'c2', hasNextPage: true },
          },
        },
      },
      run: (c) => c.listBookings({ range: { start: START, end: '2026-07-21T00:00:00Z' } }),
      check: (r) => {
        expect(r.bookings).toHaveLength(1);
        expect(r.nextPageToken).toBe('c2');
      },
    },
  ],
});

// --- Boulevard-specific behavior ------------------------------------------

describe('boulevard: HMAC auth, client resolution, unsupported availability', () => {
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

  it('signs each request with an HMAC token in a Basic auth header', async () => {
    const pool = agent.get(ORIGIN);
    let auth: string | null = null;
    pool.intercept({ path: GQL, method: 'POST' }).reply(
      200,
      (opts) => {
        auth = new Headers(opts.headers as any).get('authorization');
        return JSON.stringify({ data: { appointment: appt() } });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    await boulevard(CREDS).getBooking('APT1');
    expect(auth).toBeTruthy();
    expect(auth!.startsWith('Basic ')).toBe(true);
    const decoded = Buffer.from(auth!.slice('Basic '.length), 'base64').toString('utf8');
    // Basic base64(apiKey + ":" + token), token = mac + "blvd-admin-v1<businessId><ts>"
    expect(decoded.startsWith('key1:')).toBe(true);
    expect(decoded).toContain('blvd-admin-v1biz1');
    agent.assertNoPendingInterceptors();
  });

  it('createBooking resolves a client by email, then books with that clientId', async () => {
    const pool = agent.get(ORIGIN);
    const bodies: any[] = [];
    pool.intercept({ path: GQL, method: 'POST' }).reply(
      200,
      (opts) => {
        bodies.push(JSON.parse(String(opts.body)));
        return JSON.stringify({ data: { clients: { edges: [{ node: { id: 'CL_FOUND' } }] } } });
      },
      { headers: { 'content-type': 'application/json' } },
    );
    pool.intercept({ path: GQL, method: 'POST' }).reply(
      200,
      (opts) => {
        bodies.push(JSON.parse(String(opts.body)));
        return JSON.stringify({ data: { bookingCreate: { appointment: appt() } } });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    await boulevard(CREDS).createBooking({
      title: 'Cut',
      range: RANGE,
      staffId: 'STF1',
      serviceId: 'SVC1',
      customer: { email: 'jane@example.com' },
    });
    expect(bodies[1].variables.input.clientId).toBe('CL_FOUND');
    agent.assertNoPendingInterceptors();
  });

  it('searchAvailability throws UNSUPPORTED (Admin API has no stateless slots)', async () => {
    await expect(
      boulevard(CREDS).searchAvailability({ range: RANGE, serviceId: 'SVC1' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('surfaces a GraphQL error body as UPSTREAM even on HTTP 200', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: GQL, method: 'POST' })
      .reply(200, JSON.stringify({ errors: [{ message: 'boom' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    await expect(boulevard(CREDS).getBooking('APT1')).rejects.toMatchObject({ code: 'UPSTREAM' });
  });
});
