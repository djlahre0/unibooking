import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { apple } from '../../src/adapters/apple';
import { runConformance } from '../conformance';

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
      run: (c) => c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
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
