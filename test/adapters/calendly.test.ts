import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { calendly } from '../../src/adapters/calendly';
import { runConformance } from '../conformance';

const ORIGIN = 'https://api.calendly.com';
const START = '2026-07-20T22:00:00Z';
const USER = 'https://api.calendly.com/users/UME';

function event(overrides: Record<string, unknown> = {}) {
  return {
    uri: 'https://api.calendly.com/scheduled_events/EVT1',
    name: 'Consultation',
    status: 'active',
    start_time: START,
    end_time: '2026-07-20T22:30:00Z',
    event_type: 'https://api.calendly.com/event_types/SVC1',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

const RANGE = { start: START, end: '2026-07-20T22:30:00Z' };
const CREATE_PATH = '/scheduling/event_invitees';

runConformance({
  provider: 'calendly',
  origin: ORIGIN,
  makeClient: () => calendly({ token: 'token', user: USER }),
  errorProbe: { method: 'GET', path: '/scheduled_events', run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking maps the created scheduled event',
      method: 'POST',
      path: CREATE_PATH,
      reply: { resource: event() },
      run: (c) =>
        c.createBooking({
          title: 'Consultation',
          range: RANGE,
          serviceId: 'https://api.calendly.com/event_types/SVC1',
          customer: { email: 'jane@example.com', name: 'Jane Doe' },
        }),
      check: (b) => {
        expect(b.id).toBe('EVT1');
        expect(b.range.start).toBe(START);
        expect(b.status).toBe('confirmed');
        expect(b.serviceId).toBe('https://api.calendly.com/event_types/SVC1');
      },
    },
    {
      name: 'getBooking maps a canceled event',
      method: 'GET',
      path: '/scheduled_events',
      reply: { resource: event({ status: 'canceled' }) },
      run: (c) => c.getBooking('EVT1'),
      check: (b) => expect(b.status).toBe('cancelled'),
    },
    {
      name: 'updateBooking with status cancelled posts a cancellation',
      method: 'POST',
      path: '/scheduled_events/EVT1/cancellation',
      reply: { resource: event({ status: 'canceled' }) },
      run: (c) => c.updateBooking('EVT1', { status: 'cancelled' }),
      check: (b) => expect(b.status).toBe('cancelled'),
    },
    {
      name: 'cancelBooking posts a cancellation',
      method: 'POST',
      path: '/scheduled_events/EVT1/cancellation',
      reply: { resource: event({ status: 'canceled' }) },
      run: (c) => c.cancelBooking('EVT1', { reason: 'client asked' }),
    },
    {
      name: 'listBookings returns events + page token',
      method: 'GET',
      path: '/scheduled_events',
      reply: { collection: [event()], pagination: { next_page_token: 'c2' } },
      run: (c) => c.listBookings({ range: { start: START, end: '2026-07-21T00:00:00Z' } }),
      check: (r) => {
        expect(r.bookings).toHaveLength(1);
        expect(r.nextPageToken).toBe('c2');
      },
    },
    {
      name: 'searchAvailability derives slot end from durationMinutes',
      method: 'GET',
      path: '/event_type_available_times',
      reply: { collection: [{ status: 'available', start_time: START }] },
      run: (c) =>
        c.searchAvailability({
          range: { start: START, end: '2026-07-21T00:00:00Z' },
          serviceId: 'https://api.calendly.com/event_types/SVC1',
          durationMinutes: 30,
        }),
      check: (slots) => {
        expect(slots).toHaveLength(1);
        expect(slots[0].start).toBe(START);
        expect(slots[0].end).toBe('2026-07-20T22:30:00Z');
      },
    },
  ],
});

// --- Calendly-specific behavior -------------------------------------------

describe('calendly: cancel+rebook and input requirements', () => {
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

  it('updateBooking with a range cancels the old event and rebooks a new one', async () => {
    const NEW = '2026-07-21T18:00:00Z';
    const pool = agent.get(ORIGIN);
    // 1) read current event (for its event_type)
    pool
      .intercept({ path: '/scheduled_events/EVT1', method: 'GET' })
      .reply(200, JSON.stringify({ resource: event() }), { headers: { 'content-type': 'application/json' } });
    // 2) read invitee to carry over
    pool
      .intercept({ path: '/scheduled_events/EVT1/invitees', method: 'GET' })
      .reply(200, JSON.stringify({ collection: [{ email: 'jane@example.com', name: 'Jane' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    // 3) create the new booking
    let createBody: any;
    pool.intercept({ path: CREATE_PATH, method: 'POST' }).reply(
      200,
      (opts) => {
        createBody = JSON.parse(String(opts.body));
        return JSON.stringify({
          resource: event({ uri: 'https://api.calendly.com/scheduled_events/EVT2', start_time: NEW, end_time: '2026-07-21T18:30:00Z' }),
        });
      },
      { headers: { 'content-type': 'application/json' } },
    );
    // 4) cancel the old
    let canceled = false;
    pool.intercept({ path: '/scheduled_events/EVT1/cancellation', method: 'POST' }).reply(
      200,
      () => {
        canceled = true;
        return JSON.stringify({ resource: event({ status: 'canceled' }) });
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const client = calendly({ token: 't', user: USER });
    const b = await client.updateBooking('EVT1', { range: { start: NEW, end: '2026-07-21T18:30:00Z' } });

    expect(b.id).toBe('EVT2');
    expect(b.range.start).toBe(NEW);
    expect(createBody.event_type).toBe('https://api.calendly.com/event_types/SVC1');
    expect(createBody.invitee.email).toBe('jane@example.com');
    expect(canceled).toBe(true);
    agent.assertNoPendingInterceptors();
  });

  it('createBooking without a serviceId (event_type) is rejected', async () => {
    const client = calendly({ token: 't' });
    await expect(
      client.createBooking({ title: 'x', range: RANGE, customer: { email: 'a@b.com' } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('createBooking without an invitee email is rejected', async () => {
    const client = calendly({ token: 't' });
    await expect(
      client.createBooking({ title: 'x', range: RANGE, serviceId: 'https://api.calendly.com/event_types/SVC1' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('searchAvailability without durationMinutes is rejected (times are start-only)', async () => {
    const client = calendly({ token: 't' });
    await expect(
      client.searchAvailability({
        range: { start: START, end: '2026-07-21T00:00:00Z' },
        serviceId: 'https://api.calendly.com/event_types/SVC1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
