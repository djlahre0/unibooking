import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { outlook } from '../../src/adapters/outlook';
import { isInstant } from '../../src/time';
import { runConformance } from '../conformance';

const EVENT = {
  id: 'ev1',
  subject: 'Sync — Jane',
  start: { dateTime: '2026-07-20T22:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-07-20T22:30:00.0000000', timeZone: 'UTC' },
  attendees: [{ emailAddress: { address: 'jane@example.com', name: 'Jane' }, type: 'required' }],
  isCancelled: false,
  createdDateTime: '2026-07-01T00:00:00Z',
  lastModifiedDateTime: '2026-07-02T00:00:00Z',
};

const RANGE = { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:30:00Z' };

runConformance({
  provider: 'outlook',
  origin: 'https://graph.microsoft.com',
  makeClient: () => outlook({ accessToken: 'token' }),
  errorProbe: { method: 'GET', path: '/v1.0/me/events', run: (c) => c.getBooking('missing') },
  cases: [
    {
      name: 'createBooking maps a Graph event to UTC instants',
      method: 'POST',
      path: '/v1.0/me/events',
      reply: EVENT,
      run: (c) =>
        c.createBooking({ title: 'Sync', range: RANGE, customer: { email: 'jane@example.com' } }),
      check: (b) => {
        expect(b.range.start).toBe('2026-07-20T22:00:00Z');
        expect(b.range.end).toBe('2026-07-20T22:30:00Z');
        expect(b.customer?.email).toBe('jane@example.com');
      },
    },
    {
      name: 'getBooking',
      method: 'GET',
      path: '/v1.0/me/events',
      reply: EVENT,
      run: (c) => c.getBooking('ev1'),
    },
    {
      name: 'updateBooking',
      method: 'PATCH',
      path: '/v1.0/me/events',
      reply: EVENT,
      run: (c) => c.updateBooking('ev1', { title: 'Renamed' }),
    },
    {
      name: 'cancelBooking deletes',
      method: 'DELETE',
      path: '/v1.0/me/events',
      reply: '',
      run: (c) => c.cancelBooking('ev1'),
    },
    {
      name: 'listBookings via calendarView + skiptoken',
      method: 'GET',
      path: '/v1.0/me/calendarView',
      reply: {
        value: [EVENT],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=OPAQUE123',
      },
      run: (c) =>
        c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => {
        expect(r.bookings).toHaveLength(1);
        // The page token is the full @odata.nextLink so any Graph paging param works.
        expect(r.nextPageToken).toBe(
          'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=OPAQUE123',
        );
      },
    },
    {
      name: 'searchAvailability derives free slots from getSchedule',
      method: 'POST',
      path: '/v1.0/me/calendar/getSchedule',
      reply: {
        value: [
          {
            scheduleId: 'jane@example.com',
            scheduleItems: [
              {
                status: 'busy',
                start: { dateTime: '2026-07-20T10:00:00.0000000', timeZone: 'UTC' },
                end: { dateTime: '2026-07-20T11:00:00.0000000', timeZone: 'UTC' },
              },
            ],
          },
        ],
      },
      run: (c) =>
        c.searchAvailability({
          range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
          durationMinutes: 60,
          providerOptions: { schedules: 'jane@example.com' },
        }),
      check: (slots) => {
        // The busy 10:00–11:00 block is excluded; 09–10 and 11–12 remain.
        expect(slots).toHaveLength(2);
        expect(slots[0].start).toBe('2026-07-20T09:00:00Z');
        expect(slots[1].start).toBe('2026-07-20T11:00:00Z');
      },
    },
  ],
});

describe('outlook: getSchedule-derived availability', () => {
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

  it('rejects when no mailbox can be resolved (me is not a schedule id)', async () => {
    // No providerOptions and a userId-less client → nothing to use as a schedule.
    const client = outlook({ accessToken: 't' });
    await expect(
      client.searchAvailability({
        range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
        durationMinutes: 60,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a missing durationMinutes with INVALID_INPUT', async () => {
    const client = outlook({ accessToken: 't' });
    await expect(
      client.searchAvailability({
        range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
        providerOptions: { mailbox: 'jane@example.com' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('resolves a UPN-form userId as the schedule id', async () => {
    let sentBody: any;
    agent
      .get('https://graph.microsoft.com')
      // userId is set, so the mailbox segment is `users/{upn}`, not `me`.
      .intercept({ path: (p) => p.includes('/calendar/getSchedule'), method: 'POST' })
      .reply(
        200,
        (opts) => {
          sentBody = JSON.parse(String(opts.body));
          return JSON.stringify({ value: [{ scheduleId: 'jane@contoso.com', scheduleItems: [] }] });
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const client = outlook({ accessToken: 't', userId: 'jane@contoso.com' });
    const slots = await client.searchAvailability({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T11:00:00Z' },
      durationMinutes: 60,
    });
    // Nothing busy → full range sliced, and the UPN went out as the schedule id.
    expect(sentBody.schedules).toEqual(['jane@contoso.com']);
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z']);
  });

  it('excludes non-free scheduleItems and keeps free ones bookable', async () => {
    agent
      .get('https://graph.microsoft.com')
      .intercept({ path: (p) => p.startsWith('/v1.0/me/calendar/getSchedule'), method: 'POST' })
      .reply(
        200,
        JSON.stringify({
          value: [
            {
              scheduleId: 'jane@example.com',
              scheduleItems: [
                {
                  status: 'busy',
                  start: { dateTime: '2026-07-20T10:00:00.0000000', timeZone: 'UTC' },
                  end: { dateTime: '2026-07-20T11:00:00.0000000', timeZone: 'UTC' },
                },
                {
                  // A 'free' item must NOT block, so 09:00 stays bookable.
                  status: 'free',
                  start: { dateTime: '2026-07-20T09:00:00.0000000', timeZone: 'UTC' },
                  end: { dateTime: '2026-07-20T09:30:00.0000000', timeZone: 'UTC' },
                },
              ],
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    const slots = await outlook({ accessToken: 't' }).searchAvailability({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
      durationMinutes: 60,
      providerOptions: { schedules: ['jane@example.com'] },
    });
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z']);
    for (const s of slots) expect(isInstant(s.start)).toBe(true);
  });
});

describe('outlook: status, cancel, and $skip pagination', () => {
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

  it('maps a declined response to declined and tentative to pending', async () => {
    const pool = agent.get('https://graph.microsoft.com');
    pool
      .intercept({ path: (p) => p.startsWith('/v1.0/me/events'), method: 'GET' })
      .reply(
        200,
        JSON.stringify({ ...EVENT, isCancelled: false, responseStatus: { response: 'declined' } }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    pool
      .intercept({ path: (p) => p.startsWith('/v1.0/me/events'), method: 'GET' })
      .reply(200, JSON.stringify({ ...EVENT, showAs: 'tentative' }), {
        headers: { 'content-type': 'application/json' },
      });

    const client = outlook({ accessToken: 't' });
    expect((await client.getBooking('a')).status).toBe('declined');
    expect((await client.getBooking('b')).status).toBe('pending');
  });

  it('cancelBooking POSTs /cancel with a comment when notify/reason are set', async () => {
    const pool = agent.get('https://graph.microsoft.com');
    let body = '';
    let sawDelete = false;
    pool
      .intercept({ path: (p) => p.includes('/events/ev1/cancel'), method: 'POST' })
      .reply(202, (opts) => {
        body = String(opts.body);
        return '';
      });
    pool
      .intercept({ path: (p) => p.startsWith('/v1.0/me/events/ev1'), method: 'DELETE' })
      .reply(204, () => {
        sawDelete = true;
        return '';
      });

    const client = outlook({ accessToken: 't' });
    await client.cancelBooking('ev1', { notify: true, reason: 'Client rescheduled' });
    expect(body).toContain('Client rescheduled');
    expect(sawDelete).toBe(false);
  });

  it('follows a $skip-based @odata.nextLink to the next page', async () => {
    const pool = agent.get('https://graph.microsoft.com');
    // undici percent-encodes `$` in the path, so match on the encoding-agnostic
    // substring 'skip'.
    pool
      .intercept({
        path: (p) => p.startsWith('/v1.0/me/calendarView') && !p.includes('skip'),
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          value: [{ ...EVENT, id: 'p1' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skip=1',
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    pool
      .intercept({ path: (p) => p.includes('skip=1'), method: 'GET' })
      .reply(200, JSON.stringify({ value: [{ ...EVENT, id: 'p2' }] }), {
        headers: { 'content-type': 'application/json' },
      });

    const client = outlook({ accessToken: 't' });
    const first = await client.listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
    });
    expect(first.bookings[0]!.id).toBe('p1');
    expect(first.nextPageToken).toBe('https://graph.microsoft.com/v1.0/me/calendarView?$skip=1');
    const second = await client.listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
      pageToken: first.nextPageToken!,
    });
    expect(second.bookings[0]!.id).toBe('p2');
    expect(second.nextPageToken).toBeUndefined();
  });
});
