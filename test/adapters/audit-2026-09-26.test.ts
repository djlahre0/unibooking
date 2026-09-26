import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { outlook } from '../../src/adapters/outlook';
import { microsoftBookings } from '../../src/adapters/microsoft_bookings';
import { setmore } from '../../src/adapters/setmore';
import { mindbody } from '../../src/adapters/mindbody';
import { phorest } from '../../src/adapters/phorest';
import { zenoti } from '../../src/adapters/zenoti';
import { boulevard } from '../../src/adapters/boulevard';
import { booker } from '../../src/adapters/booker';
import { vagaro } from '../../src/adapters/vagaro';
import { calendly } from '../../src/adapters/calendly';
import { withRetry } from '../../src/retry';
import { googleOAuth } from '../../src/oauth/google';
import { wixOAuth } from '../../src/oauth/wix';
import { setmoreOAuth } from '../../src/oauth/setmore';
import { isUnibookingError } from '../../src/errors';

/**
 * Regression tests for the bugs found in the 2026-09-26 audit. Each asserts the
 * corrected behavior so the fix can't silently regress.
 */

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

const failure = async (p: Promise<unknown>): Promise<any> =>
  p.then(() => undefined).catch((err) => err);

const RANGE = { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' };

// ---------------------------------------------------------------------------
// Credentials never leave the provider's host
// ---------------------------------------------------------------------------
describe('AUDIT http: an absolute URL off the base host is refused', () => {
  // A pageToken is a full Graph URL, and consumers pass it back from their own
  // request (a query string, a form). Following one that names another host
  // sent the user's bearer token there. MockAgent has net connect disabled and
  // no interceptor for evil.example, so a request would fail as NETWORK: the
  // INVALID_INPUT below proves nothing was sent.
  const EVIL = 'https://evil.example/v1.0/me/calendarView?$skiptoken=x';

  it('outlook listBookings refuses a foreign pageToken', async () => {
    const err = await failure(
      outlook({ accessToken: 'secret' }).listBookings({ range: RANGE, pageToken: EVIL }),
    );
    expect(isUnibookingError(err) && err.code).toBe('INVALID_INPUT');
    expect(String(err.message)).toContain('evil.example');
  });

  it('outlook syncBookings refuses a foreign syncToken', async () => {
    const err = await failure(
      outlook({ accessToken: 'secret' }).syncBookings!({ syncToken: EVIL }),
    );
    expect(err?.code).toBe('INVALID_INPUT');
  });

  it('outlook listCalendars refuses a foreign pageToken', async () => {
    const err = await failure(
      outlook({ accessToken: 'secret' }).listCalendars!({ pageToken: EVIL }),
    );
    expect(err?.code).toBe('INVALID_INPUT');
  });

  it('microsoft_bookings list reads refuse a foreign pageToken', async () => {
    const client = microsoftBookings({ accessToken: 'secret', businessId: 'b@x.com' });
    expect((await failure(client.listBookings({ range: RANGE, pageToken: EVIL })))?.code).toBe(
      'INVALID_INPUT',
    );
    expect((await failure(client.listStaff!({ pageToken: EVIL })))?.code).toBe('INVALID_INPUT');
  });

  it('still follows a nextLink on the configured host (national cloud)', async () => {
    const US = 'https://graph.microsoft.us';
    agent
      .get(US)
      .intercept({
        path: (p) => p.startsWith('/v1.0/me/calendarView') && p.includes('skiptoken=next'),
        method: 'GET',
      })
      .reply(200, JSON.stringify({ value: [] }), { headers: JSON_HEADERS });
    const page = await outlook({ accessToken: 't' }, { baseUrl: `${US}/v1.0/` }).listBookings({
      range: RANGE,
      pageToken: `${US}/v1.0/me/calendarView?$skiptoken=next`,
    });
    expect(page.bookings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Microsoft Bookings
// ---------------------------------------------------------------------------
describe('AUDIT microsoft_bookings: no silent no-ops', () => {
  const client = () => microsoftBookings({ accessToken: 't', businessId: 'b@x.com' });

  it('updateBooking rejects every status, not just cancelled, before any request', async () => {
    for (const status of ['confirmed', 'no_show', 'completed'] as const) {
      const err = await failure(client().updateBooking('A1', { status }));
      expect(err?.code).toBe('INVALID_INPUT');
      expect(String(err.message)).toContain(status);
    }
  });

  it('listServices refuses a non-URL pageToken instead of looping on page 1', async () => {
    const err = await failure(client().listServices!({ pageToken: 'abc' }));
    expect(err?.code).toBe('INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Setmore: `limit` must not cut a page that has a successor
// ---------------------------------------------------------------------------
describe('AUDIT setmore: listBookings limit on a non-terminal page', () => {
  it('returns the whole page and its cursor instead of dropping the tail', async () => {
    const appt = (key: string, hh: string) => ({
      key,
      label: key,
      start_time: `2026-07-20T${hh}:00Z`,
      end_time: `2026-07-20T${hh}:30Z`,
    });
    agent
      .get('https://developer.setmore.com')
      .intercept({ path: (p) => p.startsWith('/api/v1/bookingapi/appointments'), method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          response: true,
          data: { appointments: [appt('a', '09'), appt('b', '10'), appt('c', '11')], cursor: 'C2' },
        }),
        { headers: JSON_HEADERS },
      );
    const page = await setmore({ accessToken: 't' }).listBookings({ range: RANGE, limit: 1 });
    expect(page.bookings.map((b) => b.id)).toEqual(['a', 'b', 'c']);
    expect(page.nextPageToken).toBe('C2');
  });
});

// ---------------------------------------------------------------------------
// Catalog paging: every list must hand out a way to reach its next page
// ---------------------------------------------------------------------------
describe('AUDIT mindbody: staff/services/classes page by offset', () => {
  const client = () => mindbody({ apiKey: 'k', siteId: '-99', accessToken: 't' });

  it('listStaff returns the next offset while TotalResults says there is more', async () => {
    const staff = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ Id: i + 1, FirstName: 'S', LastName: String(i) }));
    const pool = agent.get('https://api.mindbodyonline.com');
    pool
      .intercept({
        path: (p) => p.startsWith('/public/v6/staff/staff') && !p.includes('offset'),
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({ StaffMembers: staff(100), PaginationResponse: { TotalResults: 120 } }),
        { headers: JSON_HEADERS },
      );
    pool
      .intercept({
        path: (p) => p.startsWith('/public/v6/staff/staff') && p.includes('offset=100'),
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({ StaffMembers: staff(20), PaginationResponse: { TotalResults: 120 } }),
        { headers: JSON_HEADERS },
      );
    const first = await client().listStaff!();
    expect(first.staff).toHaveLength(100);
    expect(first.nextPageToken).toBe('100');
    const second = await client().listStaff!({ pageToken: first.nextPageToken! });
    expect(second.staff).toHaveLength(20);
    expect(second.nextPageToken).toBeUndefined();
  });

  it('listServices returns a token too', async () => {
    agent
      .get('https://api.mindbodyonline.com')
      .intercept({ path: (p) => p.startsWith('/public/v6/site/sessiontypes'), method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          SessionTypes: [{ Id: 1, Name: 'Massage' }],
          PaginationResponse: { TotalResults: 2 },
        }),
        { headers: JSON_HEADERS },
      );
    expect((await client().listServices!()).nextPageToken).toBe('1');
  });
});

describe('AUDIT phorest: services/staff are paged models', () => {
  const client = () =>
    phorest({ username: 'global/u', password: 'p', businessId: 'B', branchId: 'R' });

  it('listServices asks for a page and hands out the next one', async () => {
    let seen = '';
    agent
      .get('https://platform.phorest.com')
      .intercept({ path: (p) => p.includes('/branch/R/service'), method: 'GET' })
      .reply(
        200,
        (opts: any) => {
          seen = String(opts.path);
          return JSON.stringify({
            _embedded: { services: [{ serviceId: 's1', name: 'Cut', duration: 30 }] },
            page: { size: 100, totalElements: 150, totalPages: 2, number: 0 },
          });
        },
        { headers: JSON_HEADERS },
      );
    const page = await client().listServices!();
    expect(seen).toContain('page=0');
    expect(seen).toContain('size=100');
    expect(page.nextPageToken).toBe('1');
  });

  it('listStaff stops on the last page', async () => {
    agent
      .get('https://platform.phorest.com')
      .intercept({
        path: (p) => p.includes('/branch/R/staff') && p.includes('page=1'),
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          _embedded: { staffs: [{ staffId: 't1', firstName: 'Ana', lastName: 'Silva' }] },
          page: { size: 100, totalElements: 101, totalPages: 2, number: 1 },
        }),
        { headers: JSON_HEADERS },
      );
    const page = await client().listStaff!({ pageToken: '1' });
    expect(page.staff.map((s) => s.id)).toEqual(['t1']);
    expect(page.nextPageToken).toBeUndefined();
  });
});

describe('AUDIT zenoti: services/staff page by number', () => {
  const client = () => zenoti({ apiKey: 'k', centerId: 'C1' });

  it('a full page hands out the next page; a short one ends the list', async () => {
    const pool = agent.get('https://api.zenoti.com');
    pool
      .intercept({
        path: (p) => p.startsWith('/v1/centers/C1/services') && p.includes('page=1'),
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          services: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
        }),
        { headers: JSON_HEADERS },
      );
    pool
      .intercept({
        path: (p) => p.startsWith('/v1/centers/C1/services') && p.includes('page=2'),
        method: 'GET',
      })
      .reply(200, JSON.stringify({ services: [{ id: 'c', name: 'C' }] }), {
        headers: JSON_HEADERS,
      });
    const first = await client().listServices!({ limit: 2 });
    expect(first.nextPageToken).toBe('2');
    const second = await client().listServices!({ limit: 2, pageToken: '2' });
    expect(second.services.map((s) => s.id)).toEqual(['c']);
    expect(second.nextPageToken).toBeUndefined();
  });
});

describe('AUDIT boulevard: services/staff connections are paged', () => {
  it('listStaff sends first/after and returns the end cursor', async () => {
    let body: any;
    agent
      .get('https://dashboard.boulevard.io')
      .intercept({ path: '/api/2020-01/admin', method: 'POST' })
      .reply(
        200,
        (opts: any) => {
          body = JSON.parse(String(opts.body));
          return JSON.stringify({
            data: {
              staff: {
                edges: [{ node: { id: 'st1', firstName: 'Ana', lastName: 'Silva' } }],
                pageInfo: { endCursor: 'CUR2', hasNextPage: true },
              },
            },
          });
        },
        { headers: JSON_HEADERS },
      );
    const page = await boulevard({
      businessId: 'biz',
      locationId: 'loc',
      apiKey: 'key',
      apiSecret: btoa('secret'),
    }).listStaff!({ pageToken: 'CUR1', limit: 10 });
    expect(body.variables).toMatchObject({ locationId: 'loc', first: 10, after: 'CUR1' });
    expect(body.query).toContain('pageInfo');
    expect(page.nextPageToken).toBe('CUR2');
  });
});

// ---------------------------------------------------------------------------
// Booker
// ---------------------------------------------------------------------------
describe('AUDIT booker', () => {
  const client = () =>
    booker({
      accessToken: 't',
      subscriptionKey: 's',
      locationId: 'L1',
      timezone: 'America/New_York',
    });
  const appt = (id: number) => ({
    ID: id,
    StartDateTime: `/Date(${Date.UTC(2026, 5, 11, 22)}-0400)/`,
    EndDateTime: `/Date(${Date.UTC(2026, 5, 11, 23)}-0400)/`,
  });

  it('getBooking walks past the first page of the lookup window', async () => {
    const pages: number[] = [];
    agent
      .get('https://api.booker.com')
      .intercept({ path: '/v4.1/merchant/appointments', method: 'POST' })
      .reply(
        200,
        (opts: any) => {
          const n = JSON.parse(String(opts.body)).PageNumber as number;
          pages.push(n);
          // Page 1 is full of other appointments; the one asked for is on page 2.
          const rows = n === 1 ? Array.from({ length: 500 }, (_, i) => appt(i + 1)) : [appt(9001)];
          return JSON.stringify({ Results: rows });
        },
        { headers: JSON_HEADERS },
      )
      .persist();
    const b = await client().getBooking('9001');
    expect(b.id).toBe('9001');
    expect(pages).toEqual([1, 2]);
  });

  it('listBookings validates the range before any request', async () => {
    const err = await failure(
      client().listBookings({ range: { start: RANGE.end, end: RANGE.start } }),
    );
    expect(err?.code).toBe('INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Vagaro: the per-day fan-out cap says so instead of dropping a date
// ---------------------------------------------------------------------------
describe('AUDIT vagaro: availability window touching 32 dates', () => {
  it('throws rather than silently answering for 31 of them', async () => {
    const err = await failure(
      vagaro({ region: 'us04', businessId: 'b', accessToken: 't' }).searchAvailability({
        // Under 31 * 24h, but 10:00 on Jul 1 .. 09:00 on Aug 1 touches 32 dates.
        range: { start: '2026-07-01T10:00:00Z', end: '2026-08-01T09:00:00Z' },
        serviceId: 'svc',
      }),
    );
    expect(err?.code).toBe('INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// Calendly: a reschedule whose cancel step fails
// ---------------------------------------------------------------------------
describe('AUDIT calendly: rebooked but the original could not be cancelled', () => {
  const ORIGIN = 'https://api.calendly.com';
  const event = (over: Record<string, unknown> = {}) => ({
    uri: `${ORIGIN}/scheduled_events/EVT1`,
    name: 'Consult',
    start_time: '2026-07-20T18:00:00Z',
    end_time: '2026-07-20T18:30:00Z',
    status: 'active',
    event_type: `${ORIGIN}/event_types/SVC1`,
    ...over,
  });

  it('names the new booking in a non-retryable error, and withRetry does not rebook again', async () => {
    const pool = agent.get(ORIGIN);
    let creates = 0;
    pool
      .intercept({ path: '/scheduled_events/EVT1', method: 'GET' })
      .reply(200, JSON.stringify({ resource: event() }), { headers: JSON_HEADERS })
      .persist();
    pool
      .intercept({ path: '/scheduled_events/EVT1/invitees', method: 'GET' })
      .reply(200, JSON.stringify({ collection: [{ email: 'j@x.com', name: 'J' }] }), {
        headers: JSON_HEADERS,
      })
      .persist();
    pool
      .intercept({ path: '/invitees', method: 'POST' })
      .reply(
        200,
        () => {
          creates++;
          return JSON.stringify({ resource: event({ uri: `${ORIGIN}/scheduled_events/EVT2` }) });
        },
        { headers: JSON_HEADERS },
      )
      .persist();
    pool
      .intercept({ path: '/scheduled_events/EVT1/cancellation', method: 'POST' })
      .reply(503, JSON.stringify({ title: 'Service Unavailable' }), { headers: JSON_HEADERS })
      .persist();

    const client = withRetry(calendly({ token: 't', user: `${ORIGIN}/users/U1` }), {
      sleep: async () => undefined,
    });
    const err = await failure(
      client.updateBooking('EVT1', {
        range: { start: '2026-07-21T18:00:00Z', end: '2026-07-21T18:30:00Z' },
      }),
    );
    expect(err?.code).toBe('CONFLICT');
    expect(String(err.message)).toContain('EVT2');
    expect(String(err.message)).toContain("cancelBooking('EVT1')");
    expect(creates).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// OAuth token requests
// ---------------------------------------------------------------------------
describe('AUDIT oauth: token requests', () => {
  /** A fetch that never answers, but honours abort like the real one. */
  const hangingFetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
    })) as unknown as typeof fetch;

  it('time out instead of hanging (standard, Wix and Setmore flows)', async () => {
    const app = { clientId: 'id', clientSecret: 'sec', redirectUri: 'https://app/cb' };
    const clients = [
      googleOAuth({ ...app, fetch: hangingFetch, timeoutMs: 20 }),
      wixOAuth({ clientId: 'id', clientSecret: 'sec', fetch: hangingFetch, timeoutMs: 20 }),
      setmoreOAuth({ fetch: hangingFetch, timeoutMs: 20 }),
    ];
    for (const c of clients) {
      const err = await failure(c.refresh('rt'));
      expect(err?.code).toBe('TIMEOUT');
      expect(String(err.message)).not.toContain('sec');
    }
  });

  it('wix and setmore take an injectable clock for expiresAt', async () => {
    const now = () => Date.UTC(2026, 0, 1);
    const reply = (body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const wix = await wixOAuth({
      clientId: 'id',
      clientSecret: 's',
      now,
      fetch: reply({ access_token: 'a', expires_in: 60 }),
    }).refresh('rt');
    expect(wix.expiresAt).toBe('2026-01-01T00:01:00.000Z');
    const sm = await setmoreOAuth({
      now,
      fetch: reply({ response: true, data: { token: { access_token: 'a', expires_in: 60 } } }),
    }).refresh('rt');
    expect(sm.expiresAt).toBe('2026-01-01T00:01:00.000Z');
  });
});
