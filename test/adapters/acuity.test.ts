import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { acuity } from '../../src/adapters/acuity';
import { runConformance } from '../conformance';

const APPT = {
  id: 55,
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  phone: '555-0100',
  datetime: '2026-07-20T15:00:00-0700',
  duration: '45',
  appointmentTypeID: 12,
  calendarID: 3,
  type: 'Haircut',
  canceled: false,
};

const RANGE = { start: '2026-07-20T15:00:00-07:00', end: '2026-07-20T15:45:00-07:00' };

runConformance({
  provider: 'acuity',
  origin: 'https://acuityscheduling.com',
  makeClient: () => acuity({ userId: 'u', apiKey: 'k' }),
  errorProbe: { method: 'GET', path: '/api/v1/appointments', run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking normalizes the offset + derives end from duration',
      method: 'POST',
      path: '/api/v1/appointments',
      reply: APPT,
      run: (c) =>
        c.createBooking({
          title: 'Haircut',
          range: RANGE,
          serviceId: '12',
          staffId: '3',
          customer: { name: 'Jane Doe', email: 'jane@example.com' },
        }),
      check: (b) => {
        expect(b.range.start).toBe('2026-07-20T15:00:00-07:00');
        expect(b.range.end).toBe('2026-07-20T15:45:00-07:00');
        expect(b.staffId).toBe('3');
        expect(b.serviceId).toBe('12');
        expect(b.customer?.name).toBe('Jane Doe');
      },
    },
    {
      name: 'getBooking',
      method: 'GET',
      path: '/api/v1/appointments',
      reply: APPT,
      run: (c) => c.getBooking('55'),
    },
    {
      name: 'updateBooking reschedules',
      method: 'PUT',
      path: '/api/v1/appointments/55/reschedule',
      reply: APPT,
      run: (c) => c.updateBooking('55', { range: RANGE }),
    },
    {
      name: 'cancelBooking',
      method: 'PUT',
      path: '/api/v1/appointments/55/cancel',
      reply: APPT,
      run: (c) => c.cancelBooking('55', { reason: 'client asked' }),
    },
    {
      name: 'listBookings returns an array',
      method: 'GET',
      path: '/api/v1/appointments',
      reply: [APPT],
      run: (c) => c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => expect(r.bookings).toHaveLength(1),
    },
    {
      name: 'searchAvailability derives slot end from durationMinutes',
      method: 'GET',
      path: '/api/v1/availability/times',
      reply: [{ time: '2026-07-20T15:00:00-0700' }],
      run: (c) => c.searchAvailability({ range: RANGE, serviceId: '12', durationMinutes: 45 }),
      check: (slots) => {
        expect(slots).toHaveLength(1);
        expect(slots[0].start).toBe('2026-07-20T15:00:00-07:00');
        expect(slots[0].end).toBe('2026-07-20T15:45:00-07:00');
      },
    },
  ],
});

describe('acuity: status, timezone, validation, and update mapping', () => {
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

  it('maps a no-show appointment to no_show and populates the timezone', async () => {
    const pool = agent.get('https://acuityscheduling.com');
    pool
      .intercept({ path: (p) => p.startsWith('/api/v1/appointments'), method: 'GET' })
      // Acuity marks a no-show ON a canceled appointment — `noShow` never
      // arrives without `canceled`, so the mapping must prefer the former.
      .reply(200, JSON.stringify({ ...APPT, canceled: true, noShow: true, timezone: 'America/Los_Angeles' }), {
        headers: { 'content-type': 'application/json' },
      });
    const client = acuity({ userId: 'u', apiKey: 'k' });
    const b = await client.getBooking('55');
    expect(b.status).toBe('no_show');
    expect(b.range.timezone).toBe('America/Los_Angeles');
  });

  it('pages availability across a multi-day range and keeps only in-window slots', async () => {
    const pool = agent.get('https://acuityscheduling.com');
    const H = { 'content-type': 'application/json' };
    pool
      .intercept({ path: (p) => p.startsWith('/api/v1/availability/times') && p.includes('2026-07-20'), method: 'GET' })
      .reply(200, JSON.stringify([{ time: '2026-07-20T09:00:00-0700' }, { time: '2026-07-20T15:00:00-0700' }]), { headers: H });
    pool
      .intercept({ path: (p) => p.startsWith('/api/v1/availability/times') && p.includes('2026-07-21'), method: 'GET' })
      .reply(200, JSON.stringify([{ time: '2026-07-21T10:00:00-0700' }]), { headers: H });

    const client = acuity({ userId: 'u', apiKey: 'k' });
    const slots = await client.searchAvailability({
      range: { start: '2026-07-20T10:00:00-07:00', end: '2026-07-21T12:00:00-07:00' },
      serviceId: '12',
      durationMinutes: 30,
    });
    // 07-20 09:00 is before the window (10:00) → dropped; the other two are in-window.
    expect(slots.map((s) => s.start)).toEqual([
      '2026-07-20T15:00:00-07:00',
      '2026-07-21T10:00:00-07:00',
    ]);
    agent.assertNoPendingInterceptors();
  });

  it('searchAvailability rejects an inverted range before hitting the network', async () => {
    const client = acuity({ userId: 'u', apiKey: 'k' });
    await expect(
      client.searchAvailability({
        range: { start: '2026-07-21T00:00:00Z', end: '2026-07-20T00:00:00Z' },
        serviceId: '12',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('a non-reschedule update maps title to notes and sets admin=true (or notes are dropped)', async () => {
    const pool = agent.get('https://acuityscheduling.com');
    let body: any;
    let path = '';
    pool
      .intercept({ path: (p) => p === '/api/v1/appointments/55' || p.startsWith('/api/v1/appointments/55?'), method: 'PUT' })
      .reply(200, (opts) => {
        path = opts.path;
        body = JSON.parse(String(opts.body));
        return JSON.stringify({ ...APPT });
      }, { headers: { 'content-type': 'application/json' } });
    const client = acuity({ userId: 'u', apiKey: 'k' });
    await client.updateBooking('55', { title: 'Please call first' });
    expect(body.notes).toBe('Please call first');
    // Acuity only lets an admin write `notes`.
    expect(path).toContain('admin=true');
  });

  it('createBooking sends admin=true only when a staffId (calendarID) is present', async () => {
    const pool = agent.get('https://acuityscheduling.com');
    const paths: string[] = [];
    pool
      .intercept({ path: (p) => p.startsWith('/api/v1/appointments'), method: 'POST' })
      .reply(200, (opts) => {
        paths.push(opts.path);
        return JSON.stringify({ ...APPT });
      }, { headers: { 'content-type': 'application/json' } })
      .times(2);
    const client = acuity({ userId: 'u', apiKey: 'k' });
    // With staffId → admin bypass (needs the calendarID admin mode requires).
    await client.createBooking({ title: 'x', range: RANGE, serviceId: '12', staffId: '3', customer: { name: 'A B', email: 'a@b.com' } });
    // Without staffId → no admin (admin mode would fail without a calendarID).
    await client.createBooking({ title: 'x', range: RANGE, serviceId: '12', customer: { name: 'A B', email: 'a@b.com' } });
    expect(paths[0]).toContain('admin=true');
    expect(paths[1]).not.toContain('admin=true');
  });
});

describe('acuity: auth', () => {
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

  function captureAuth(): { get: () => string | undefined } {
    const pool = agent.get('https://acuityscheduling.com');
    let auth: string | undefined;
    pool
      .intercept({ path: (p) => p.startsWith('/api/v1/appointments'), method: 'GET' })
      .reply(200, (opts) => {
        const h = opts.headers as Record<string, string>;
        auth = h.authorization ?? h.Authorization;
        return JSON.stringify({ ...APPT });
      }, { headers: { 'content-type': 'application/json' } });
    return { get: () => auth };
  }

  it('sends a Bearer token when built with an accessToken (OAuth2)', async () => {
    const cap = captureAuth();
    await acuity({ accessToken: 'oauth-token' }).getBooking('55');
    expect(cap.get()).toBe('Bearer oauth-token');
  });

  it('sends a Basic header when built with a userId + apiKey', async () => {
    const cap = captureAuth();
    await acuity({ userId: 'u', apiKey: 'k' }).getBooking('55');
    expect(cap.get()).toBe(`Basic ${btoa('u:k')}`);
  });
});
