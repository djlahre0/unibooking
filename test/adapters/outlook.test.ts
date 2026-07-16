import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { outlook } from '../../src/adapters/outlook';
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
      run: (c) => c.createBooking({ title: 'Sync', range: RANGE, customer: { email: 'jane@example.com' } }),
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
        '@odata.nextLink':
          'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=OPAQUE123',
      },
      run: (c) => c.listBookings({ range: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
      check: (r) => {
        expect(r.bookings).toHaveLength(1);
        // The page token is the full @odata.nextLink so any Graph paging param works.
        expect(r.nextPageToken).toBe(
          'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=OPAQUE123',
        );
      },
    },
  ],
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
      .reply(200, JSON.stringify({ ...EVENT, isCancelled: false, responseStatus: { response: 'declined' } }), {
        headers: { 'content-type': 'application/json' },
      });
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
      .intercept({ path: (p) => p.startsWith('/v1.0/me/calendarView') && !p.includes('skip'), method: 'GET' })
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
