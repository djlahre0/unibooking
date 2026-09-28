import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { google } from '../../src/adapters/google';
import { isInstant } from '../../src/time';
import { assertCanonicalCalendar, runConformance } from '../conformance';

const EVENT = {
  id: 'ev1',
  summary: 'Haircut: Jane',
  start: { dateTime: '2026-07-20T15:00:00-07:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-07-20T15:45:00-07:00', timeZone: 'America/Los_Angeles' },
  status: 'confirmed',
  attendees: [{ email: 'jane@example.com', displayName: 'Jane Doe' }],
  created: '2026-07-01T00:00:00Z',
  updated: '2026-07-02T00:00:00Z',
};

const RANGE = { start: '2026-07-20T15:00:00-07:00', end: '2026-07-20T15:45:00-07:00' };

/** Availability drops slots that have already started, so the fixtures' July
 *  windows are searched from a clock pinned before them. */
const CLOCK = { now: () => new Date('2026-07-01T00:00:00Z') };

runConformance({
  provider: 'google',
  origin: 'https://www.googleapis.com',
  makeClient: () => google({ accessToken: 'token', calendarId: 'primary' }, CLOCK),
  errorProbe: {
    method: 'GET',
    path: '/calendar/v3/calendars/primary/events',
    run: (c) => c.getBooking('missing'),
  },
  cases: [
    {
      name: 'createBooking maps the event + attendee',
      method: 'POST',
      path: '/calendar/v3/calendars/primary/events',
      reply: EVENT,
      run: (c) =>
        c.createBooking({
          title: 'Haircut: Jane',
          range: RANGE,
          customer: { email: 'jane@example.com' },
        }),
      check: (b) => {
        expect(b.id).toBe('ev1');
        expect(b.customer?.email).toBe('jane@example.com');
        expect(Date.parse(b.range.end) > Date.parse(b.range.start)).toBe(true);
      },
    },
    {
      name: 'getBooking maps the event',
      method: 'GET',
      path: '/calendar/v3/calendars/primary/events',
      reply: EVENT,
      run: (c) => c.getBooking('ev1'),
      check: (b) => expect(b.status).toBe('confirmed'),
    },
    {
      name: 'updateBooking reschedules',
      method: 'PATCH',
      path: '/calendar/v3/calendars/primary/events',
      reply: { ...EVENT, end: { dateTime: '2026-07-20T16:00:00-07:00' } },
      run: (c) =>
        c.updateBooking('ev1', { range: { start: RANGE.start, end: '2026-07-20T16:00:00-07:00' } }),
    },
    {
      name: 'cancelBooking deletes',
      method: 'DELETE',
      path: '/calendar/v3/calendars/primary/events',
      reply: '',
      run: (c) => c.cancelBooking('ev1'),
    },
    {
      name: 'listBookings returns bookings + page token',
      method: 'GET',
      path: '/calendar/v3/calendars/primary/events',
      reply: { items: [EVENT], nextPageToken: 'next' },
      run: (c) =>
        c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => {
        expect(r.bookings).toHaveLength(1);
        expect(r.nextPageToken).toBe('next');
      },
    },
    {
      name: 'searchAvailability derives free slots from freeBusy',
      method: 'POST',
      path: '/calendar/v3/freeBusy',
      reply: {
        calendars: {
          primary: { busy: [{ start: '2026-07-20T10:00:00Z', end: '2026-07-20T11:00:00Z' }] },
        },
      },
      run: (c) =>
        c.searchAvailability({
          range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
          durationMinutes: 60,
        }),
      check: (slots) => {
        // The 10:00–11:00 busy block is excluded; 09–10 and 11–12 remain.
        expect(slots).toHaveLength(2);
        expect(slots[0].start).toBe('2026-07-20T09:00:00Z');
        expect(slots[1].start).toBe('2026-07-20T11:00:00Z');
        expect(slots.some((s: any) => s.start === '2026-07-20T10:00:00Z')).toBe(false);
      },
    },
  ],
});

describe('google: freeBusy-derived availability', () => {
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

  it('rejects a missing durationMinutes with INVALID_INPUT', async () => {
    const client = google({ accessToken: 't', calendarId: 'primary' }, CLOCK);
    await expect(
      client.searchAvailability({
        range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('excludes busy intervals and returns offset-bearing slots', async () => {
    agent
      .get('https://www.googleapis.com')
      .intercept({ path: (p) => p.startsWith('/calendar/v3/freeBusy'), method: 'POST' })
      .reply(
        200,
        JSON.stringify({
          calendars: {
            primary: { busy: [{ start: '2026-07-20T10:00:00Z', end: '2026-07-20T11:00:00Z' }] },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    const slots = await google(
      { accessToken: 't', calendarId: 'primary' },
      CLOCK,
    ).searchAvailability({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
      durationMinutes: 60,
    });
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T09:00:00Z', '2026-07-20T11:00:00Z']);
    // The busy hour is never offered as a slot start.
    expect(slots.some((s) => s.start === '2026-07-20T10:00:00Z')).toBe(false);
    for (const s of slots) {
      expect(isInstant(s.start)).toBe(true);
      expect(isInstant(s.end)).toBe(true);
    }
  });

  it('throws UPSTREAM when the calendar entry carries an errors array', async () => {
    agent
      .get('https://www.googleapis.com')
      .intercept({ path: (p) => p.startsWith('/calendar/v3/freeBusy'), method: 'POST' })
      .reply(
        200,
        JSON.stringify({
          calendars: { primary: { busy: [], errors: [{ reason: 'notACalendarUser' }] } },
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    await expect(
      google({ accessToken: 't', calendarId: 'primary' }, CLOCK).searchAvailability({
        range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
        durationMinutes: 60,
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM' });
  });

  it('sends the raw calendar id in the freeBusy body, not a percent-encoded one', async () => {
    const CAL = 'c_188ag7abcdef@group.calendar.google.com';
    let body: any;
    agent
      .get('https://www.googleapis.com')
      .intercept({ path: (p) => p.startsWith('/calendar/v3/freeBusy'), method: 'POST' })
      .reply(
        200,
        (opts) => {
          body = JSON.parse(String(opts.body));
          // Google keys the response by the calendar id it was given.
          return JSON.stringify({ calendars: { [CAL]: { busy: [] } } });
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const slots = await google({ accessToken: 't', calendarId: CAL }, CLOCK).searchAvailability({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T11:00:00Z' },
      durationMinutes: 60,
    });

    expect(body.items).toEqual([{ id: CAL }]);
    // The '@' must survive: '%40' here is the bug.
    expect(JSON.stringify(body)).not.toContain('%40');
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z']);
  });

  it('resolves the freeBusy entry when Google lowercases the calendar id', async () => {
    const REQUESTED = 'Merchant@Example.com';
    agent
      .get('https://www.googleapis.com')
      .intercept({ path: (p) => p.startsWith('/calendar/v3/freeBusy'), method: 'POST' })
      .reply(
        200,
        // Google normalizes email-form ids to lowercase in the response key.
        JSON.stringify({ calendars: { 'merchant@example.com': { busy: [] } } }),
        { headers: { 'content-type': 'application/json' } },
      );

    const slots = await google(
      { accessToken: 't', calendarId: REQUESTED },
      CLOCK,
    ).searchAvailability({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:00:00Z' },
      durationMinutes: 60,
    });

    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T09:00:00Z']);
  });

  it('throws UPSTREAM naming the calendar when no entry matches', async () => {
    agent
      .get('https://www.googleapis.com')
      .intercept({ path: (p) => p.startsWith('/calendar/v3/freeBusy'), method: 'POST' })
      .reply(
        200,
        JSON.stringify({
          calendars: {
            'someone-else@example.com': { busy: [] },
            'third@example.com': { busy: [] },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );

    await expect(
      google({ accessToken: 't', calendarId: 'mine@example.com' }, CLOCK).searchAvailability({
        range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:00:00Z' },
        durationMinutes: 60,
      }),
    ).rejects.toMatchObject({
      code: 'UPSTREAM',
      message: expect.stringContaining('mine@example.com'),
    });
  });
});

describe('google: calendars, event details and all-day events', () => {
  const ORIGIN = 'https://www.googleapis.com';
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

  /** Reply with `reply`, capturing the request body and query. */
  function capture(method: string, path: string, reply: unknown) {
    const seen: { body?: any; query?: URLSearchParams } = {};
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.split('?')[0] === path, method })
      .reply(
        200,
        (opts) => {
          seen.query = new URL(String(opts.path), ORIGIN).searchParams;
          if (opts.body) seen.body = JSON.parse(String(opts.body));
          return JSON.stringify(reply);
        },
        { headers: JSON_HEADERS },
      );
    return seen;
  }

  const ALL_DAY_EVENT = {
    id: 'ad1',
    summary: 'Offsite',
    status: 'confirmed',
    start: { date: '2026-09-21' },
    end: { date: '2026-09-22' },
    description: 'Bring laptops',
    location: 'HQ, Floor 3',
  };

  it('lists calendars with primary, read-only, color and paging', async () => {
    const seen = capture('GET', '/calendar/v3/users/me/calendarList', {
      items: [
        {
          id: 'jane@gmail.com',
          summary: 'Jane',
          timeZone: 'Asia/Kolkata',
          primary: true,
          accessRole: 'owner',
          backgroundColor: '#9fe1e7',
        },
        {
          id: 'en.indian#holiday@group.v.calendar.google.com',
          summary: 'Holidays in India',
          summaryOverride: 'India holidays',
          accessRole: 'reader',
          backgroundColor: '#16a765',
        },
      ],
      nextPageToken: 'n2',
    });
    const res = await google({ accessToken: 't' }).listCalendars!({ limit: 50, pageToken: 'p1' });
    expect(seen.query?.get('maxResults')).toBe('50');
    expect(seen.query?.get('pageToken')).toBe('p1');
    expect(res.nextPageToken).toBe('n2');
    expect(res.calendars[0]).toMatchObject({
      id: 'jane@gmail.com',
      name: 'Jane',
      timezone: 'Asia/Kolkata',
      primary: true,
      readOnly: false,
      color: '#9fe1e7',
    });
    expect(res.calendars[1]).toMatchObject({
      name: 'India holidays',
      primary: false,
      readOnly: true,
    });
    for (const c of res.calendars) assertCanonicalCalendar(c);
  });

  it('creates an all-day event with description and location', async () => {
    const seen = capture('POST', '/calendar/v3/calendars/primary/events', ALL_DAY_EVENT);
    const b = await google({ accessToken: 't' }).createBooking({
      title: 'Offsite',
      range: {
        start: '2026-09-21T00:00:00+05:30',
        end: '2026-09-22T00:00:00+05:30',
        timezone: 'Asia/Kolkata',
      },
      allDay: true,
      description: 'Bring laptops',
      location: 'HQ, Floor 3',
    });
    expect(seen.body.start).toEqual({ date: '2026-09-21' });
    expect(seen.body.end).toEqual({ date: '2026-09-22' });
    expect(seen.body.description).toBe('Bring laptops');
    expect(seen.body.location).toBe('HQ, Floor 3');
    expect(b).toMatchObject({
      allDay: true,
      range: { start: '2026-09-21T00:00:00Z', end: '2026-09-22T00:00:00Z' },
      description: 'Bring laptops',
      location: 'HQ, Floor 3',
    });
  });

  it('switches timed <-> all-day on update by nulling the other form', async () => {
    const toTimed = capture('PATCH', '/calendar/v3/calendars/primary/events/ad1', {
      ...ALL_DAY_EVENT,
      start: { dateTime: '2026-09-21T10:00:00+05:30' },
      end: { dateTime: '2026-09-21T11:00:00+05:30' },
    });
    await google({ accessToken: 't' }).updateBooking('ad1', {
      range: {
        start: '2026-09-21T10:00:00+05:30',
        end: '2026-09-21T11:00:00+05:30',
        timezone: 'Asia/Kolkata',
      },
    });
    expect(toTimed.body.start).toEqual({
      dateTime: '2026-09-21T10:00:00+05:30',
      timeZone: 'Asia/Kolkata',
      date: null,
    });

    const toAllDay = capture('PATCH', '/calendar/v3/calendars/primary/events/ad1', ALL_DAY_EVENT);
    await google({ accessToken: 't' }).updateBooking('ad1', {
      range: { start: '2026-09-21T00:00:00Z', end: '2026-09-22T00:00:00Z' },
      allDay: true,
      location: '',
    });
    expect(toAllDay.body.start).toEqual({ date: '2026-09-21', dateTime: null });
    expect(toAllDay.body.location).toBe('');
  });

  it('rejects allDay without a range, and a zero-day all-day range, before any request', async () => {
    const client = google({ accessToken: 't' });
    await expect(client.updateBooking('ad1', { allDay: true })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      client.createBooking({
        title: 'x',
        range: { start: '2026-09-21T00:00:00Z', end: '2026-09-21T12:00:00Z' },
        allDay: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    agent.assertNoPendingInterceptors();
  });

  it('reads description, location and all-day from an event', async () => {
    capture('GET', '/calendar/v3/calendars/primary/events/ad1', ALL_DAY_EVENT);
    const b = await google({ accessToken: 't' }).getBooking('ad1');
    expect(b).toMatchObject({
      allDay: true,
      description: 'Bring laptops',
      location: 'HQ, Floor 3',
    });
  });
});

describe('google: slot rules, the clock and the guest', () => {
  const ORIGIN = 'https://www.googleapis.com';
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

  function freeBusy(busy: Array<{ start: string; end: string }>) {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/calendar/v3/freeBusy'), method: 'POST' })
      .reply(200, JSON.stringify({ kind: 'calendar#freeBusy', calendars: { primary: { busy } } }), {
        headers: JSON_HEADERS,
      });
  }

  it('never offers a slot that has already started', async () => {
    freeBusy([]);
    // 10:20 now: 09:00 and 10:00 have started, 11:00 has not.
    const client = google({ accessToken: 't' }, { now: () => new Date('2026-07-20T10:20:00Z') });
    const slots = await client.searchAvailability({
      range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
      durationMinutes: 60,
    });
    expect(slots.map((s) => s.start)).toEqual(['2026-07-20T11:00:00Z']);
  });

  it('applies working hours, the start grid, buffers and minimum notice', async () => {
    // Busy 10:00-10:40 Kolkata (04:30-05:10Z).
    freeBusy([{ start: '2026-07-20T04:30:00Z', end: '2026-07-20T05:10:00Z' }]);
    const client = google(
      { accessToken: 't' },
      // 08:00 Kolkata; with 60 minutes' notice nothing before 09:00 is offered.
      { now: () => new Date('2026-07-20T02:30:00Z') },
    );
    const slots = await client.searchAvailability({
      range: { start: '2026-07-20T00:00:00+05:30', end: '2026-07-21T00:00:00+05:30' },
      durationMinutes: 30,
      intervalMinutes: 30,
      bufferAfterMinutes: 10,
      minNoticeMinutes: 60,
      workingHours: {
        timezone: 'Asia/Kolkata',
        periods: [{ dayOfWeek: 'MON', start: '09:00', end: '12:00' }],
      },
    });
    // 09:30-10:00 ends as the 10:00 meeting starts, but its 10-minute buffer
    // after would run to 10:10, so it goes. 10:00 and 10:30 overlap the
    // meeting; 11:00 is after it (no buffer before is asked for).
    expect(slots.map((s) => s.start)).toEqual([
      '2026-07-20T09:00:00+05:30',
      '2026-07-20T11:00:00+05:30',
      '2026-07-20T11:30:00+05:30',
    ]);
  });

  it('rejects unusable slot rules before any request', async () => {
    // No intercept registered: a request would fail the test with a
    // MockNotMatchedError instead of the INVALID_INPUT asserted here.
    const client = google({ accessToken: 't' }, CLOCK);
    await expect(
      client.searchAvailability({
        range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
        durationMinutes: 30,
        workingHours: { timezone: 'Mars/Olympus', periods: [] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      client.searchAvailability({
        range: { start: '2026-07-20T09:00:00Z', end: '2026-07-20T12:00:00Z' },
        durationMinutes: 30,
        intervalMinutes: 0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('takes the customer from the first guest, not the organizer', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/calendar/v3/calendars/primary/events/ev1') })
      .reply(
        200,
        JSON.stringify({
          ...EVENT,
          // An event created in Google Calendar's own UI: the organizer is
          // listed first among the attendees, flagged organizer + self.
          organizer: { email: 'owner@example.com', self: true },
          attendees: [
            { email: 'owner@example.com', organizer: true, self: true, responseStatus: 'accepted' },
            {
              email: 'room-1@resource.calendar.google.com',
              resource: true,
              responseStatus: 'accepted',
            },
            { email: 'jane@example.com', displayName: 'Jane Doe', responseStatus: 'needsAction' },
          ],
        }),
        { headers: JSON_HEADERS },
      );
    const b = await google({ accessToken: 't' }).getBooking('ev1');
    expect(b.customer).toEqual({ email: 'jane@example.com', name: 'Jane Doe' });
  });

  it('reports no customer when the only attendee is the organizer', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/calendar/v3/calendars/primary/events/ev1') })
      .reply(
        200,
        JSON.stringify({
          ...EVENT,
          attendees: [{ email: 'owner@example.com', organizer: true, self: true }],
        }),
        { headers: JSON_HEADERS },
      );
    const b = await google({ accessToken: 't' }).getBooking('ev1');
    expect(b.customer).toBeUndefined();
  });
});

describe('google: recurring instances', () => {
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

  it('names the series of an expanded instance', async () => {
    agent
      .get('https://www.googleapis.com')
      .intercept({ path: (p) => p.startsWith('/calendar/v3/calendars/primary/events?') })
      .reply(
        200,
        JSON.stringify({
          kind: 'calendar#events',
          items: [
            {
              ...EVENT,
              id: 'abc123_20260720T220000Z',
              recurringEventId: 'abc123',
              originalStartTime: { dateTime: '2026-07-20T15:00:00-07:00' },
            },
            EVENT,
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    const { bookings } = await google({ accessToken: 't' }).listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' },
    });
    expect(bookings.map((b) => b.seriesId)).toEqual(['abc123', undefined]);
  });
});
