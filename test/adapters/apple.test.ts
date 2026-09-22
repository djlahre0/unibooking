import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { apple } from '../../src/adapters/apple';
import { assertCanonicalCalendar, runConformance } from '../conformance';
import { HOME_XML, LIST_XML, PARTITION, PRINCIPAL_XML, ROOT as DAV_ROOT } from '../caldav-fixtures';

const ORIGIN = 'https://caldav.icloud.com';
const CAL = 'https://caldav.icloud.com/123/calendars/home/';
const COLLECTION = '/123/calendars/home';

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:evt-1',
  'SUMMARY:Haircut',
  'STATUS:CONFIRMED',
  'DTSTART:20260720T220000Z',
  'DTEND:20260720T224500Z',
  'ATTENDEE;CN=Jane Doe:mailto:jane@example.com',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const MULTISTATUS =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
  `<D:response><D:href>/123/calendars/home/evt-1.ics</D:href>` +
  `<D:propstat><D:prop><C:calendar-data>${ICS}</C:calendar-data></D:prop>` +
  `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;

const RANGE = { start: '2026-07-20T22:00:00Z', end: '2026-07-20T22:45:00Z' };

runConformance({
  provider: 'apple',
  origin: ORIGIN,
  makeClient: () => apple({ username: 'u', appPassword: 'p', calendarUrl: CAL }),
  errorProbe: { method: 'GET', path: COLLECTION, run: (c) => c.getBooking('evt-1') },
  cases: [
    {
      name: 'createBooking PUTs an ICS and echoes the booking',
      method: 'PUT',
      path: COLLECTION,
      reply: '',
      run: (c) =>
        c.createBooking({
          title: 'Haircut',
          range: RANGE,
          idempotencyKey: 'evt-1',
          customer: { email: 'jane@example.com', name: 'Jane Doe' },
        }),
      check: (b) => {
        expect(b.id).toBe('evt-1');
        expect(b.range.end).toBe('2026-07-20T22:45:00Z');
      },
    },
    {
      name: 'getBooking parses the ICS',
      method: 'GET',
      path: COLLECTION,
      reply: ICS,
      run: (c) => c.getBooking('evt-1'),
      check: (b) => {
        expect(b.title).toBe('Haircut');
        expect(b.customer?.email).toBe('jane@example.com');
        expect(b.range.start).toBe('2026-07-20T22:00:00Z');
      },
    },
    {
      name: 'cancelBooking deletes the resource',
      method: 'DELETE',
      path: COLLECTION,
      reply: '',
      run: (c) => c.cancelBooking('evt-1'),
    },
    {
      name: 'listBookings runs a calendar-query REPORT',
      method: 'REPORT',
      path: COLLECTION,
      reply: MULTISTATUS,
      run: (c) =>
        c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => {
        expect(r.bookings).toHaveLength(1);
        expect(r.bookings[0].id).toBe('evt-1');
      },
    },
  ],
});

describe('apple: update does GET then PUT', () => {
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

  it('preserves fields it was not asked to change', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/evt-1.ics'), method: 'GET' })
      .reply(200, ICS, { headers: { 'content-type': 'text/calendar' } });
    let putBody = '';
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/evt-1.ics'), method: 'PUT' })
      .reply(201, (opts) => {
        putBody = String(opts.body);
        return '';
      });

    const client = apple({ username: 'u', appPassword: 'p', calendarUrl: CAL });
    const b = await client.updateBooking('evt-1', { title: 'Renamed' });

    expect(b.title).toBe('Renamed');
    expect(putBody).toContain('SUMMARY:Renamed');
    expect(putBody).toContain('DTSTART:20260720T220000Z'); // unchanged
    agent.assertNoPendingInterceptors();
  });

  it('maps a canonical status update onto the iCal STATUS', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/evt-1.ics'), method: 'GET' })
      .reply(200, ICS, { headers: { 'content-type': 'text/calendar' } });
    let putBody = '';
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/evt-1.ics'), method: 'PUT' })
      .reply(201, (opts) => {
        putBody = String(opts.body);
        return '';
      });

    const client = apple({ username: 'u', appPassword: 'p', calendarUrl: CAL });
    await client.updateBooking('evt-1', { status: 'pending' });
    expect(putBody).toContain('STATUS:TENTATIVE');
    expect(putBody).not.toContain('STATUS:CONFIRMED');
  });

  it('requests server-side expansion and maps each recurring instance to its own booking', async () => {
    // The server honors <C:expand> and returns two concrete instances (each with a
    // RECURRENCE-ID and its own DTSTART, RRULE removed) under one resource href.
    const EXPANDED = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:series-1',
      'RECURRENCE-ID:20260720T220000Z',
      'SUMMARY:Weekly sync',
      'DTSTART:20260720T220000Z',
      'DTEND:20260720T223000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:series-1',
      'RECURRENCE-ID:20260727T220000Z',
      'SUMMARY:Weekly sync',
      'DTSTART:20260727T220000Z',
      'DTEND:20260727T223000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const MS =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
      `<D:response><D:href>/123/calendars/home/series-1.ics</D:href>` +
      `<D:propstat><D:prop><C:calendar-data>${EXPANDED}</C:calendar-data></D:prop>` +
      `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;

    const pool = agent.get(ORIGIN);
    let reportBody = '';
    pool.intercept({ path: (p) => p.startsWith('/123/calendars/home'), method: 'REPORT' }).reply(
      207,
      (opts) => {
        reportBody = String(opts.body);
        return MS;
      },
      { headers: { 'content-type': 'application/xml' } },
    );

    const client = apple({ username: 'u', appPassword: 'p', calendarUrl: CAL });
    const { bookings } = await client.listBookings({
      range: { start: '2026-07-20T00:00:00Z', end: '2026-07-28T00:00:00Z' },
    });

    expect(reportBody).toContain('<C:expand');
    expect(bookings).toHaveLength(2);
    expect(bookings.map((b) => b.range.start)).toEqual([
      '2026-07-20T22:00:00Z',
      '2026-07-27T22:00:00Z',
    ]);
  });

  it('expands an unexpanded weekly RRULE master client-side when the server ignores <C:expand>', async () => {
    // The server ignored <C:expand> and returned the UNEXPANDED master: its
    // original DTSTART (at the window start) plus an RRULE, as one VEVENT under
    // one resource href. listBookings must expand it locally to the per-week
    // occurrences rather than report a single booking at the master's time.
    const MASTER = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:series-weekly',
      'SUMMARY:Weekly sync',
      'DTSTART:20260706T090000Z', // Monday, at the window start
      'DTEND:20260706T093000Z',
      'RRULE:FREQ=WEEKLY',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const MS =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
      `<D:response><D:href>/123/calendars/home/series-weekly.ics</D:href>` +
      `<D:propstat><D:prop><C:calendar-data>${MASTER}</C:calendar-data></D:prop>` +
      `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;

    const pool = agent.get(ORIGIN);
    let reportBody = '';
    pool.intercept({ path: (p) => p.startsWith('/123/calendars/home'), method: 'REPORT' }).reply(
      207,
      (opts) => {
        reportBody = String(opts.body);
        return MS;
      },
      { headers: { 'content-type': 'application/xml' } },
    );

    const client = apple({ username: 'u', appPassword: 'p', calendarUrl: CAL });
    const { bookings } = await client.listBookings({
      range: { start: '2026-07-06T00:00:00Z', end: '2026-07-27T00:00:00Z' },
    });

    // The request still asks the server to expand; the fallback only kicks in
    // because the server returned the master instead.
    expect(reportBody).toContain('<C:expand');
    // One booking per in-window week at the correct per-week times.
    expect(bookings.map((b) => b.range.start)).toEqual([
      '2026-07-06T09:00:00Z',
      '2026-07-13T09:00:00Z',
      '2026-07-20T09:00:00Z',
    ]);
    // All occurrences of one resource share its re-fetchable id (the href name);
    // they are told apart by their distinct per-week start.
    expect(bookings.every((b) => b.id === 'series-weekly')).toBe(true);
    expect(new Set(bookings.map((b) => b.range.start)).size).toBe(bookings.length);
    // raw stays the honest master (still carries the RRULE) — there is no
    // per-occurrence server payload to attribute to each instance.
    expect(bookings.every((b) => String(b.raw).includes('RRULE:FREQ=WEEKLY'))).toBe(true);
  });

  it('sends If-Match with the current ETag on update, If-None-Match:* on create', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/evt-1.ics'), method: 'GET' })
      .reply(200, ICS, { headers: { 'content-type': 'text/calendar', etag: '"etag-123"' } });
    let updateHeaders: Record<string, unknown> = {};
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/evt-1.ics'), method: 'PUT' })
      .reply(201, (opts) => {
        updateHeaders = (opts.headers ?? {}) as Record<string, unknown>;
        return '';
      });
    let createHeaders: Record<string, unknown> = {};
    pool
      .intercept({ path: (p) => p.startsWith('/123/calendars/home/new-1.ics'), method: 'PUT' })
      .reply(201, (opts) => {
        createHeaders = (opts.headers ?? {}) as Record<string, unknown>;
        return '';
      });

    const client = apple({ username: 'u', appPassword: 'p', calendarUrl: CAL });
    await client.updateBooking('evt-1', { title: 'Renamed' });
    await client.createBooking({ title: 'New', range: RANGE, idempotencyKey: 'new-1' });

    const lower = (h: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    expect(lower(updateHeaders)['if-match']).toBe('"etag-123"');
    expect(lower(createHeaders)['if-none-match']).toBe('*');
  });
});

describe('apple: discovery, event details and all-day events', () => {
  const XML = { 'content-type': 'application/xml; charset=utf-8' };
  const CREDS = { username: 'jane@icloud.com', appPassword: 'abcd-efgh-ijkl-mnop' };
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

  it('lists calendars by discovery, needing no calendarUrl', async () => {
    agent
      .get(DAV_ROOT)
      .intercept({ path: '/', method: 'PROPFIND' })
      .reply(207, PRINCIPAL_XML, { headers: XML });
    agent
      .get(DAV_ROOT)
      .intercept({ path: '/123456/principal/', method: 'PROPFIND' })
      .reply(207, HOME_XML, { headers: XML });
    agent
      .get(PARTITION)
      .intercept({ path: '/123456/calendars/', method: 'PROPFIND' })
      .reply(207, LIST_XML, { headers: XML });

    const { calendars } = await apple(CREDS).listCalendars!();
    expect(calendars.map((c) => c.name)).toEqual(['Home & Family', 'Shared']);
    expect(calendars[0]?.id).toBe('https://p57-caldav.icloud.com/123456/calendars/home/');
    for (const c of calendars) assertCanonicalCalendar(c);
  });

  it('checks the connection against the principal when no calendarUrl is set', async () => {
    agent
      .get(DAV_ROOT)
      .intercept({ path: '/', method: 'PROPFIND' })
      .reply(207, PRINCIPAL_XML, { headers: XML });
    const status = await apple(CREDS).checkConnection();
    expect(status).toMatchObject({ ok: true, account: { name: 'jane@icloud.com' } });

    agent.get(DAV_ROOT).intercept({ path: '/', method: 'PROPFIND' }).reply(401, '');
    expect(await apple(CREDS).checkConnection()).toMatchObject({ ok: false, reason: 'AUTH' });
  });

  it('rejects event operations without a calendarUrl before sending anything', async () => {
    const client = apple(CREDS);
    for (const call of [
      () => client.getBooking('x'),
      () => client.cancelBooking('x'),
      () => client.createBooking({ title: 't', range: RANGE }),
      () => client.listBookings({ range: RANGE }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('listCalendars()'),
      });
    }
    agent.assertNoPendingInterceptors();
  });

  it('creates an all-day event with description and location', async () => {
    let body = '';
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith(COLLECTION), method: 'PUT' })
      .reply(201, (opts) => {
        body = String(opts.body);
        return '';
      });
    const b = await apple({ ...CREDS, calendarUrl: CAL }).createBooking({
      title: 'Offsite',
      range: { start: '2026-09-21T00:00:00+05:30', end: '2026-09-22T00:00:00+05:30' },
      allDay: true,
      description: 'Bring laptops',
      location: 'HQ',
      idempotencyKey: 'off-1',
    });
    expect(body).toContain('DTSTART;VALUE=DATE:20260921');
    expect(body).toContain('DTEND;VALUE=DATE:20260922');
    expect(body).toContain('DESCRIPTION:Bring laptops');
    expect(body).toContain('LOCATION:HQ');
    expect(b).toMatchObject({
      id: 'off-1',
      allDay: true,
      range: { start: '2026-09-21T00:00:00Z', end: '2026-09-22T00:00:00Z' },
      description: 'Bring laptops',
      location: 'HQ',
    });
  });

  it('patches description and location on update, and reads them back', async () => {
    const stored = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:evt-9',
      'SUMMARY:Planning',
      'DTSTART:20260921T100000Z',
      'DTEND:20260921T110000Z',
      'DESCRIPTION:old notes',
      'LOCATION:Old room',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    let put = '';
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: (p) => p.startsWith(COLLECTION), method: 'GET' })
      .reply(200, stored, { headers: { etag: '"e1"' } });
    pool.intercept({ path: (p) => p.startsWith(COLLECTION), method: 'PUT' }).reply(204, (opts) => {
      put = String(opts.body);
      return '';
    });
    const b = await apple({ ...CREDS, calendarUrl: CAL }).updateBooking('evt-9', {
      location: 'Room 12',
      description: '',
    });
    expect(put).toContain('LOCATION:Room 12');
    expect(put).not.toContain('DESCRIPTION');
    expect(b.location).toBe('Room 12');
    expect(b.description).toBeUndefined();

    await expect(
      apple({ ...CREDS, calendarUrl: CAL }).updateBooking('evt-9', { allDay: true }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
