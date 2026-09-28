import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { outlook } from '../../src/adapters/outlook';
import { isInstant } from '../../src/time';
import { assertCanonicalCalendar, runConformance } from '../conformance';

const EVENT = {
  id: 'ev1',
  subject: 'Sync: Jane',
  start: { dateTime: '2026-07-20T22:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-07-20T22:30:00.0000000', timeZone: 'UTC' },
  attendees: [{ emailAddress: { address: 'jane@example.com', name: 'Jane' }, type: 'required' }],
  isCancelled: false,
  createdDateTime: '2026-07-01T00:00:00Z',
  lastModifiedDateTime: '2026-07-02T00:00:00Z',
};

const RANGE = { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:30:00Z' };

/** Availability drops slots that have already started, so the fixtures' July
 *  windows are searched from a clock pinned before them. */
const CLOCK = { now: () => new Date('2026-07-01T00:00:00Z') };

runConformance({
  provider: 'outlook',
  origin: 'https://graph.microsoft.com',
  makeClient: () => outlook({ accessToken: 'token' }, CLOCK),
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

  it("reads the calendar's own events when no mailbox is given", async () => {
    // getSchedule is unavailable to personal Microsoft accounts and cannot
    // target a calendarId, so the default reads calendarView of the calendar
    // the client is pointed at. Cancelled and free events do not block.
    let query: URLSearchParams | undefined;
    agent
      .get('https://graph.microsoft.com')
      .intercept({
        path: (p) => p.startsWith('/v1.0/me/calendars/cal-1/calendarView'),
        method: 'GET',
      })
      .reply(
        200,
        (opts) => {
          query = new URL(String(opts.path), 'https://graph.microsoft.com').searchParams;
          return JSON.stringify({
            '@odata.context':
              "https://graph.microsoft.com/v1.0/$metadata#users('me')/calendars('cal-1')/calendarView(start,end,showAs,isCancelled)",
            value: [
              {
                '@odata.etag': 'W/"1"',
                id: 'busy-1',
                showAs: 'busy',
                isCancelled: false,
                start: { dateTime: '2026-07-20T10:00:00.0000000', timeZone: 'UTC' },
                end: { dateTime: '2026-07-20T11:00:00.0000000', timeZone: 'UTC' },
              },
              {
                '@odata.etag': 'W/"2"',
                id: 'free-1',
                showAs: 'free',
                isCancelled: false,
                start: { dateTime: '2026-07-20T09:00:00.0000000', timeZone: 'UTC' },
                end: { dateTime: '2026-07-20T10:00:00.0000000', timeZone: 'UTC' },
              },
              {
                '@odata.etag': 'W/"3"',
                id: 'cancelled-1',
                showAs: 'busy',
                isCancelled: true,
                start: { dateTime: '2026-07-20T11:00:00.0000000', timeZone: 'UTC' },
                end: { dateTime: '2026-07-20T12:00:00.0000000', timeZone: 'UTC' },
              },
            ],
          });
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const client = outlook({ accessToken: 't', calendarId: 'cal-1' }, CLOCK);
    const slots = await client.searchAvailability({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
      durationMinutes: 60,
    });
    expect(query?.get('startDateTime')).toBe('2026-07-20T09:00:00Z');
    expect(query?.get('endDateTime')).toBe('2026-07-20T12:00:00Z');
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z']);
  });

  it('follows calendarView pages when reading busy time', async () => {
    const pool = agent.get('https://graph.microsoft.com');
    pool
      // undici percent-encodes `$`, so match on the encoding-agnostic 'skip'.
      .intercept({
        path: (p) => p.startsWith('/v1.0/me/calendarView') && !p.includes('skip'),
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          value: [
            {
              id: 'a',
              showAs: 'busy',
              isCancelled: false,
              start: { dateTime: '2026-07-20T09:00:00.0000000', timeZone: 'UTC' },
              end: { dateTime: '2026-07-20T10:00:00.0000000', timeZone: 'UTC' },
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skip=1000',
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    pool.intercept({ path: (p) => p.includes('skip=1000'), method: 'GET' }).reply(
      200,
      JSON.stringify({
        value: [
          {
            id: 'b',
            showAs: 'tentative',
            isCancelled: false,
            start: { dateTime: '2026-07-20T10:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2026-07-20T11:00:00.0000000', timeZone: 'UTC' },
          },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    const slots = await outlook({ accessToken: 't' }, CLOCK).searchAvailability({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
      durationMinutes: 60,
    });
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T11:00:00Z']);
  });

  it("clamps getSchedule's availabilityViewInterval to 5..1440", async () => {
    // Graph documents the field as min 5, max 1440; the adapter used to send
    // durationMinutes verbatim, so a 2-minute or two-day slot was a 400.
    const bodies: any[] = [];
    const pool = agent.get('https://graph.microsoft.com');
    for (let i = 0; i < 2; i++) {
      pool.intercept({ path: (p) => p.includes('/calendar/getSchedule'), method: 'POST' }).reply(
        200,
        (opts) => {
          bodies.push(JSON.parse(String(opts.body)));
          return JSON.stringify({
            value: [{ scheduleId: 'jane@contoso.com', scheduleItems: [] }],
          });
        },
        { headers: { 'content-type': 'application/json' } },
      );
    }
    const client = outlook({ accessToken: 't' }, CLOCK);
    await client.searchAvailability({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T09:10:00Z' },
      durationMinutes: 2,
      providerOptions: { mailbox: 'jane@contoso.com' },
    });
    await client.searchAvailability({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-23T00:00:00Z' },
      durationMinutes: 2880,
      providerOptions: { mailbox: 'jane@contoso.com' },
    });
    expect(bodies.map((b) => b.availabilityViewInterval)).toEqual([5, 1440]);
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

  it("reads another user's calendar when userId is set and no mailbox is given", async () => {
    agent
      .get('https://graph.microsoft.com')
      .intercept({
        path: (p) => p.startsWith('/v1.0/users/jane%40contoso.com/calendarView'),
        method: 'GET',
      })
      .reply(200, JSON.stringify({ value: [] }), {
        headers: { 'content-type': 'application/json' },
      });

    const client = outlook({ accessToken: 't', userId: 'jane@contoso.com' }, CLOCK);
    const slots = await client.searchAvailability({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T11:00:00Z' },
      durationMinutes: 60,
    });
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

    const slots = await outlook({ accessToken: 't' }, CLOCK).searchAvailability({
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

describe('outlook: calendars, event details, all-day and timezones', () => {
  const ORIGIN = 'https://graph.microsoft.com';
  const JSON_HEADERS = { 'content-type': 'application/json' };
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

  function capture(method: string, path: string, reply: unknown) {
    const seen: { body?: any; headers?: Headers; query?: URLSearchParams } = {};
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.split('?')[0] === path, method })
      .reply(
        200,
        (opts) => {
          seen.headers = new Headers(opts.headers as HeadersInit);
          seen.query = new URL(String(opts.path), ORIGIN).searchParams;
          if (opts.body) seen.body = JSON.parse(String(opts.body));
          return JSON.stringify(reply);
        },
        { headers: JSON_HEADERS },
      );
    return seen;
  }

  const TIMED = {
    id: 'e1',
    subject: 'Standup',
    start: { dateTime: '2026-09-21T04:30:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-21T05:00:00.0000000', timeZone: 'UTC' },
    body: { contentType: 'text', content: 'Agenda: blockers' },
    location: { displayName: 'Room 4' },
  };

  it('lists calendars with default, read-only, color and nextLink paging', async () => {
    const seen = capture('GET', '/v1.0/me/calendars', {
      value: [
        {
          id: 'AAA',
          name: 'Calendar',
          hexColor: '#e3008c',
          isDefaultCalendar: true,
          canEdit: true,
        },
        { id: 'BBB', name: 'Birthdays', hexColor: '', isDefaultCalendar: false, canEdit: false },
      ],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars?$skip=2',
    });
    const res = await outlook({ accessToken: 't' }).listCalendars!({ limit: 2 });
    expect(seen.query?.get('$top')).toBe('2');
    expect(res.calendars[0]).toMatchObject({
      id: 'AAA',
      primary: true,
      readOnly: false,
      color: '#e3008c',
    });
    expect(res.calendars[1]).toMatchObject({ id: 'BBB', primary: false, readOnly: true });
    expect(res.calendars[1]?.color).toBeUndefined();
    expect(res.nextPageToken).toBe('https://graph.microsoft.com/v1.0/me/calendars?$skip=2');
    for (const c of res.calendars) assertCanonicalCalendar(c);
  });

  it('follows a nextLink page and rejects a reconstructed token', async () => {
    capture('GET', '/v1.0/me/calendars', { value: [] });
    await outlook({ accessToken: 't' }).listCalendars!({
      pageToken: 'https://graph.microsoft.com/v1.0/me/calendars?$skip=2',
    });
    await expect(
      outlook({ accessToken: 't' }).listCalendars!({ pageToken: 'skip2' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('scopes calendars to another user when userId is set', async () => {
    capture('GET', '/v1.0/users/jane%40contoso.com/calendars', { value: [] });
    await outlook({ accessToken: 't', userId: 'jane@contoso.com' }).listCalendars!();
    agent.assertNoPendingInterceptors();
  });

  it('writes the chosen timezone as wall-clock + zone, with a text body and location', async () => {
    const seen = capture('POST', '/v1.0/me/events', TIMED);
    const b = await outlook({ accessToken: 't' }).createBooking({
      title: 'Standup',
      range: {
        start: '2026-09-21T10:00:00+05:30',
        end: '2026-09-21T10:30:00+05:30',
        timezone: 'Asia/Kolkata',
      },
      description: 'Agenda: blockers',
      location: 'Room 4',
    });
    expect(seen.body.start).toEqual({ dateTime: '2026-09-21T10:00:00', timeZone: 'Asia/Kolkata' });
    expect(seen.body.end).toEqual({ dateTime: '2026-09-21T10:30:00', timeZone: 'Asia/Kolkata' });
    expect(seen.body.body).toEqual({ contentType: 'text', content: 'Agenda: blockers' });
    expect(seen.body.location).toEqual({ displayName: 'Room 4' });
    expect(seen.headers?.get('prefer')).toContain('outlook.body-content-type="text"');
    expect(seen.headers?.get('prefer')).toContain('IdType="ImmutableId"');
    expect(b).toMatchObject({ description: 'Agenda: blockers', location: 'Room 4' });
  });

  it('falls back to UTC without a timezone, or with one it cannot resolve', async () => {
    const plain = capture('POST', '/v1.0/me/events', TIMED);
    await outlook({ accessToken: 't' }).createBooking({
      title: 'x',
      range: { start: '2026-09-21T10:00:00+05:30', end: '2026-09-21T10:30:00+05:30' },
    });
    expect(plain.body.start).toEqual({ dateTime: '2026-09-21T04:30:00', timeZone: 'UTC' });

    const bogus = capture('POST', '/v1.0/me/events', TIMED);
    await outlook({ accessToken: 't' }).createBooking({
      title: 'x',
      range: {
        start: '2026-09-21T10:00:00+05:30',
        end: '2026-09-21T10:30:00+05:30',
        timezone: 'Nowhere/Zone',
      },
    });
    expect(bogus.body.start).toEqual({ dateTime: '2026-09-21T04:30:00', timeZone: 'UTC' });
  });

  it('creates an all-day event at midnight in the chosen zone', async () => {
    const seen = capture('POST', '/v1.0/me/events', {
      ...TIMED,
      isAllDay: true,
      start: { dateTime: '2026-09-21T00:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-09-22T00:00:00.0000000', timeZone: 'UTC' },
    });
    const b = await outlook({ accessToken: 't' }).createBooking({
      title: 'Offsite',
      range: {
        start: '2026-09-21T00:00:00+05:30',
        end: '2026-09-22T00:00:00+05:30',
        timezone: 'Asia/Kolkata',
      },
      allDay: true,
    });
    expect(seen.body).toMatchObject({
      isAllDay: true,
      start: { dateTime: '2026-09-21T00:00:00', timeZone: 'Asia/Kolkata' },
      end: { dateTime: '2026-09-22T00:00:00', timeZone: 'Asia/Kolkata' },
    });
    expect(b).toMatchObject({
      allDay: true,
      range: { start: '2026-09-21T00:00:00Z', end: '2026-09-22T00:00:00Z' },
    });
  });

  it('reads all-day dates whether Graph reports midnight or converts to UTC', async () => {
    capture('GET', '/v1.0/me/events/conv', {
      ...TIMED,
      id: 'conv',
      isAllDay: true,
      originalStartTimeZone: 'India Standard Time',
      originalEndTimeZone: 'India Standard Time',
      start: { dateTime: '2026-09-20T18:30:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-09-21T18:30:00.0000000', timeZone: 'UTC' },
    });
    const b = await outlook({ accessToken: 't' }).getBooking('conv');
    expect(b).toMatchObject({
      allDay: true,
      range: { start: '2026-09-21T00:00:00Z', end: '2026-09-22T00:00:00Z' },
    });
  });

  it('marks updates timed unless allDay is set, and rejects allDay without a range', async () => {
    const seen = capture('PATCH', '/v1.0/me/events/e1', TIMED);
    await outlook({ accessToken: 't' }).updateBooking('e1', {
      range: { start: '2026-09-21T04:30:00Z', end: '2026-09-21T05:00:00Z' },
      location: '',
    });
    expect(seen.body.isAllDay).toBe(false);
    expect(seen.body.location).toEqual({ displayName: '' });
    await expect(
      outlook({ accessToken: 't' }).updateBooking('e1', { allDay: true }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('outlook: the customer is the guest', () => {
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

  it('skips the organizer and room resources among the attendees', async () => {
    agent
      .get('https://graph.microsoft.com')
      .intercept({ path: (p) => p.startsWith('/v1.0/me/events/ev1'), method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          ...EVENT,
          organizer: { emailAddress: { name: 'Owner', address: 'Owner@Contoso.com' } },
          attendees: [
            {
              type: 'required',
              status: { response: 'accepted', time: '2026-07-01T00:00:00Z' },
              emailAddress: { name: 'Owner', address: 'owner@contoso.com' },
            },
            {
              type: 'resource',
              status: { response: 'accepted', time: '2026-07-01T00:00:00Z' },
              emailAddress: { name: 'Room 1', address: 'room1@contoso.com' },
            },
            {
              type: 'required',
              status: { response: 'none', time: '0001-01-01T00:00:00Z' },
              emailAddress: { name: 'Jane', address: 'jane@example.com' },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    const b = await outlook({ accessToken: 't' }).getBooking('ev1');
    expect(b.customer).toEqual({ email: 'jane@example.com', name: 'Jane' });
  });
});

describe('outlook: recurring occurrences', () => {
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

  it('names the series of an occurrence or exception, not of the master', async () => {
    agent
      .get('https://graph.microsoft.com')
      .intercept({ path: (p) => p.startsWith('/v1.0/me/calendarView'), method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          value: [
            { ...EVENT, id: 'occ-1', type: 'occurrence', seriesMasterId: 'master-1' },
            { ...EVENT, id: 'exc-1', type: 'exception', seriesMasterId: 'master-1' },
            { ...EVENT, id: 'single', type: 'singleInstance', seriesMasterId: null },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    const { bookings } = await outlook({ accessToken: 't' }).listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
    });
    expect(bookings.map((b) => b.seriesId)).toEqual(['master-1', 'master-1', undefined]);
  });
});
