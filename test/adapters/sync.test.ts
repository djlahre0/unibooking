import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { google } from '../../src/adapters/google';
import { outlook } from '../../src/adapters/outlook';
import { apple } from '../../src/adapters/apple';
import { square } from '../../src/adapters/square';

/**
 * Change sync, change notifications and versioned writes on the three calendar
 * providers. Fixtures are the providers' documented envelopes: Google
 * events.list / api#channel, Graph calendarView delta / subscription, and a
 * DAV:sync-collection multistatus (RFC 6578 §3.4).
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=UTF-8' };
const XML = { 'content-type': 'application/xml; charset=utf-8' };
const CLOCK = { now: () => new Date('2026-09-22T10:00:00Z') };

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

function lower(h: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries((h ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

const G_EVENT = {
  kind: 'calendar#event',
  etag: '"3450000000000000"',
  id: 'ev1',
  status: 'confirmed',
  summary: 'Haircut',
  start: { dateTime: '2026-09-23T10:00:00+05:30', timeZone: 'Asia/Kolkata' },
  end: { dateTime: '2026-09-23T10:30:00+05:30', timeZone: 'Asia/Kolkata' },
  created: '2026-09-01T00:00:00.000Z',
  updated: '2026-09-02T00:00:00.000Z',
};

describe('google: syncBookings', () => {
  const pool = () => agent.get('https://www.googleapis.com');
  const events = (p: string) => p.startsWith('/calendar/v3/calendars/primary/events?');

  it('runs a windowed full sync and hands back the sync token', async () => {
    let q: URLSearchParams | undefined;
    pool()
      .intercept({ path: events, method: 'GET' })
      .reply(
        200,
        (opts) => {
          q = new URL(String(opts.path), 'https://x').searchParams;
          return JSON.stringify({
            kind: 'calendar#events',
            etag: '"p1"',
            summary: 'me@example.com',
            timeZone: 'Asia/Kolkata',
            accessRole: 'owner',
            items: [
              G_EVENT,
              // A long-deleted instance: nothing to remove on a first sync.
              {
                kind: 'calendar#event',
                etag: '"x"',
                id: 'old_20260101T000000Z',
                status: 'cancelled',
              },
            ],
            nextSyncToken: 'CPDAlvWDx70CEPDAlvWDx70CGAU=',
          });
        },
        { headers: JSON_HEADERS },
      );
    const res = await google({ accessToken: 't' }).syncBookings!({
      range: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
    });
    expect(q?.get('timeMin')).toBe('2026-09-01T00:00:00Z');
    expect(q?.get('singleEvents')).toBe('true');
    expect(q?.get('showDeleted')).toBe('true');
    expect(q?.has('syncToken')).toBe(false);
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]).toMatchObject({
      type: 'upsert',
      booking: { id: 'ev1', version: '"3450000000000000"' },
    });
    expect(res.syncToken).toBe('CPDAlvWDx70CEPDAlvWDx70CGAU=');
    expect(res.nextPageToken).toBeUndefined();
  });

  it('reports incremental changes, with deletions, and never sends a window alongside the token', async () => {
    let q: URLSearchParams | undefined;
    pool()
      .intercept({ path: events, method: 'GET' })
      .reply(
        200,
        (opts) => {
          q = new URL(String(opts.path), 'https://x').searchParams;
          return JSON.stringify({
            kind: 'calendar#events',
            items: [
              { ...G_EVENT, summary: 'Haircut (moved)' },
              { kind: 'calendar#event', etag: '"y"', id: 'gone', status: 'cancelled' },
            ],
            nextPageToken: 'page-2',
          });
        },
        { headers: JSON_HEADERS },
      );
    const res = await google({ accessToken: 't' }).syncBookings!({
      syncToken: 'tok-1',
      range: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
    });
    expect(q?.get('syncToken')).toBe('tok-1');
    expect(q?.has('timeMin')).toBe(false);
    expect(res.changes.map((c) => c.type)).toEqual(['upsert', 'delete']);
    expect(res.changes[1]).toEqual({ type: 'delete', id: 'gone' });
    expect(res.nextPageToken).toBe('page-2');
    expect(res.syncToken).toBeUndefined();
  });

  it('answers an expired sync token with fullSyncRequired', async () => {
    pool()
      .intercept({ path: events, method: 'GET' })
      .reply(
        410,
        JSON.stringify({
          error: {
            errors: [
              {
                domain: 'global',
                reason: 'fullSyncRequired',
                message: 'Sync token is no longer valid, a full sync is required.',
              },
            ],
            code: 410,
            message: 'Sync token is no longer valid, a full sync is required.',
          },
        }),
        { headers: JSON_HEADERS },
      );
    expect(await google({ accessToken: 't' }).syncBookings!({ syncToken: 'stale' })).toEqual({
      changes: [],
      fullSyncRequired: true,
    });
  });
});

describe('google: watch channels', () => {
  const pool = () => agent.get('https://www.googleapis.com');
  const CHANNEL = {
    kind: 'api#channel',
    id: 'ch-1',
    resourceId: 'o3hgv1538sdjfh',
    resourceUri: 'https://www.googleapis.com/calendar/v3/calendars/primary/events?alt=json',
    expiration: '1790000000000',
  };

  it('opens a channel with the caller token and reports its expiry', async () => {
    let body: any;
    pool()
      .intercept({ path: '/calendar/v3/calendars/primary/events/watch', method: 'POST' })
      .reply(
        200,
        (opts) => {
          body = JSON.parse(String(opts.body));
          return JSON.stringify(CHANNEL);
        },
        { headers: JSON_HEADERS },
      );
    const w = await google({ accessToken: 't' }).watchBookings!({
      address: 'https://app.example.com/hooks/google',
      token: 'shared-secret',
      ttlSeconds: 3600,
    });
    expect(body).toMatchObject({
      type: 'web_hook',
      address: 'https://app.example.com/hooks/google',
      token: 'shared-secret',
      params: { ttl: '3600' },
    });
    expect(typeof body.id).toBe('string');
    expect(w).toMatchObject({
      id: 'ch-1',
      provider: 'google',
      resourceId: 'o3hgv1538sdjfh',
      expiresAt: new Date(1790000000000).toISOString(),
    });
  });

  it('refuses a non-https address before any request', async () => {
    await expect(
      google({ accessToken: 't' }).watchBookings!({ address: 'http://insecure', token: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('renews by opening a new channel and stopping the old one', async () => {
    let stopped: any;
    pool()
      .intercept({ path: '/calendar/v3/calendars/primary/events/watch', method: 'POST' })
      .reply(200, JSON.stringify({ ...CHANNEL, id: 'ch-2' }), { headers: JSON_HEADERS });
    pool()
      .intercept({ path: '/calendar/v3/channels/stop', method: 'POST' })
      .reply(204, (opts) => {
        stopped = JSON.parse(String(opts.body));
        return '';
      });
    const next = await google({ accessToken: 't' }).renewWatch!(
      { id: 'ch-1', provider: 'google', resourceId: 'o3hgv1538sdjfh', raw: {} },
      { address: 'https://app.example.com/hooks/google', token: 'shared-secret' },
    );
    expect(next.id).toBe('ch-2');
    expect(stopped).toEqual({ id: 'ch-1', resourceId: 'o3hgv1538sdjfh' });
  });

  it('treats stopping an expired channel as done', async () => {
    pool()
      .intercept({ path: '/calendar/v3/channels/stop', method: 'POST' })
      .reply(404, JSON.stringify({ error: { code: 404, message: 'Channel not found' } }), {
        headers: JSON_HEADERS,
      });
    await expect(
      google({ accessToken: 't' }).stopWatch!({
        id: 'ch-1',
        provider: 'google',
        resourceId: 'r',
        raw: {},
      }),
    ).resolves.toBeUndefined();
  });
});

describe('google: versioned writes', () => {
  const pool = () => agent.get('https://www.googleapis.com');

  it('sends If-Match and turns a stale version into CONFLICT', async () => {
    let headers: Record<string, string> = {};
    pool()
      .intercept({
        path: (p) => p.startsWith('/calendar/v3/calendars/primary/events/ev1'),
        method: 'PATCH',
      })
      .reply(
        412,
        (opts) => {
          headers = lower(opts.headers);
          return JSON.stringify({
            error: {
              errors: [
                { domain: 'global', reason: 'conditionNotMet', message: 'Precondition Failed' },
              ],
              code: 412,
              message: 'Precondition Failed',
            },
          });
        },
        { headers: JSON_HEADERS },
      );
    await expect(
      google({ accessToken: 't' }).updateBooking('ev1', { title: 'x', ifVersion: '"old"' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(headers['if-match']).toBe('"old"');
  });

  it('guards a delete the same way', async () => {
    let headers: Record<string, string> = {};
    pool()
      .intercept({
        path: (p) => p.startsWith('/calendar/v3/calendars/primary/events/ev1'),
        method: 'DELETE',
      })
      .reply(204, (opts) => {
        headers = lower(opts.headers);
        return '';
      });
    await google({ accessToken: 't' }).cancelBooking('ev1', { ifVersion: '"v2"' });
    expect(headers['if-match']).toBe('"v2"');
  });
});

describe('ifVersion on a provider without versioned writes', () => {
  it('throws UNSUPPORTED before any request instead of writing unguarded', async () => {
    // No interceptor: a request would surface as NETWORK, not UNSUPPORTED.
    const client = square({ accessToken: 't', locationId: 'L1' });
    await expect(client.updateBooking('b1', { title: 'x', ifVersion: 'v' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(client.cancelBooking('b1', { ifVersion: 'v' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });
});

const O_EVENT = {
  '@odata.etag': 'W/"DwAAABYAAAB"',
  id: 'AAMk-1',
  subject: 'Sync',
  type: 'singleInstance',
  isCancelled: false,
  start: { dateTime: '2026-09-23T04:30:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-09-23T05:00:00.0000000', timeZone: 'UTC' },
};

describe('outlook: syncBookings', () => {
  const pool = () => agent.get('https://graph.microsoft.com');

  it('starts a delta round over the window and follows nextLink then deltaLink', async () => {
    let prefer = '';
    pool()
      .intercept({ path: (p) => p.startsWith('/v1.0/me/calendarView/delta?'), method: 'GET' })
      .reply(
        200,
        (opts) => {
          prefer = lower(opts.headers).prefer ?? '';
          return JSON.stringify({
            '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#Collection(event)',
            '@odata.nextLink':
              'https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=S1',
            value: [O_EVENT],
          });
        },
        { headers: JSON_HEADERS },
      );
    const client = outlook({ accessToken: 't' });
    const first = await client.syncBookings!({
      range: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
    });
    expect(prefer).toContain('odata.maxpagesize=100');
    expect(first.changes[0]).toMatchObject({
      type: 'upsert',
      booking: { id: 'AAMk-1', version: 'W/"DwAAABYAAAB"' },
    });
    expect(first.nextPageToken).toBe(
      'https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=S1',
    );

    pool()
      .intercept({ path: (p) => p.includes('skiptoken=S1'), method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          '@odata.deltaLink':
            'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=D1',
          value: [
            {
              '@odata.type': '#microsoft.graph.event',
              id: 'AAMk-2',
              '@removed': { reason: 'deleted' },
            },
          ],
        }),
        { headers: JSON_HEADERS },
      );
    const second = await client.syncBookings!({ pageToken: first.nextPageToken! });
    expect(second.changes).toEqual([{ type: 'delete', id: 'AAMk-2' }]);
    expect(second.syncToken).toBe(
      'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=D1',
    );
  });

  it('needs a window for the first round', async () => {
    await expect(outlook({ accessToken: 't' }).syncBookings!({})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('refuses a calendarId: Graph v1.0 delta covers the default calendar only', async () => {
    await expect(
      outlook({ accessToken: 't', calendarId: 'cal-2' }).syncBookings!({
        range: { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('answers an expired delta token with fullSyncRequired', async () => {
    pool()
      .intercept({ path: (p) => p.includes('deltatoken=OLD'), method: 'GET' })
      .reply(
        410,
        JSON.stringify({
          error: { code: 'SyncStateNotFound', message: 'The sync state generation is not found.' },
        }),
        { headers: JSON_HEADERS },
      );
    expect(
      await outlook({ accessToken: 't' }).syncBookings!({
        syncToken: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=OLD',
      }),
    ).toEqual({ changes: [], fullSyncRequired: true });
  });
});

describe('outlook: subscriptions', () => {
  const pool = () => agent.get('https://graph.microsoft.com');
  const SUB = {
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#subscriptions/$entity',
    id: '7f105c7d-2dc5-4530-97cd-4e7ae6534c07',
    resource: 'me/calendars/cal-1/events',
    applicationId: '24d3b144-21ae-4080-943f-7067b395b913',
    changeType: 'created,updated,deleted',
    clientState: 'shared-secret',
    notificationUrl: 'https://app.example.com/hooks/outlook',
    expirationDateTime: '2026-09-29T09:50:00Z',
    creatorId: '8ee44408-0679-472c-bc2a-692812af3437',
    latestSupportedTlsVersion: 'v1_2',
  };

  it('subscribes to the calendar with clientState and a capped expiry', async () => {
    let body: any;
    pool()
      .intercept({ path: '/v1.0/subscriptions', method: 'POST' })
      .reply(
        201,
        (opts) => {
          body = JSON.parse(String(opts.body));
          return JSON.stringify(SUB);
        },
        { headers: JSON_HEADERS },
      );
    const w = await outlook({ accessToken: 't', calendarId: 'cal-1' }, CLOCK).watchBookings!({
      address: 'https://app.example.com/hooks/outlook',
      token: 'shared-secret',
      // A month: more than Graph allows for events.
      ttlSeconds: 30 * 86_400,
      lifecycleAddress: 'https://app.example.com/hooks/outlook/lifecycle',
    });
    expect(body).toMatchObject({
      changeType: 'created,updated,deleted',
      notificationUrl: 'https://app.example.com/hooks/outlook',
      resource: 'me/calendars/cal-1/events',
      clientState: 'shared-secret',
      lifecycleNotificationUrl: 'https://app.example.com/hooks/outlook/lifecycle',
    });
    const ttlMin =
      (Date.parse(body.expirationDateTime) - Date.parse('2026-09-22T10:00:00Z')) / 60_000;
    expect(ttlMin).toBeLessThan(10_080);
    expect(ttlMin).toBeGreaterThan(10_000);
    expect(w).toMatchObject({ id: SUB.id, provider: 'outlook', expiresAt: '2026-09-29T09:50:00Z' });
  });

  it('refuses a clientState longer than Graph allows', async () => {
    await expect(
      outlook({ accessToken: 't' }).watchBookings!({
        address: 'https://app.example.com/h',
        token: 'x'.repeat(129),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('renews with a PATCH and stops with a DELETE, tolerating one already gone', async () => {
    let patched: any;
    pool()
      .intercept({ path: `/v1.0/subscriptions/${SUB.id}`, method: 'PATCH' })
      .reply(
        200,
        (opts) => {
          patched = JSON.parse(String(opts.body));
          return JSON.stringify({ ...SUB, expirationDateTime: '2026-09-29T10:00:00Z' });
        },
        { headers: JSON_HEADERS },
      );
    pool()
      .intercept({ path: `/v1.0/subscriptions/${SUB.id}`, method: 'DELETE' })
      .reply(404, JSON.stringify({ error: { code: 'ResourceNotFound', message: 'gone' } }), {
        headers: JSON_HEADERS,
      });
    const client = outlook({ accessToken: 't' }, CLOCK);
    const watch = { id: SUB.id, provider: 'outlook' as const, raw: SUB };
    const renewed = await client.renewWatch!(watch, {
      address: 'https://app.example.com/hooks/outlook',
      token: 'shared-secret',
    });
    expect(Object.keys(patched)).toEqual(['expirationDateTime']);
    expect(renewed.expiresAt).toBe('2026-09-29T10:00:00Z');
    await expect(client.stopWatch!(watch)).resolves.toBeUndefined();
  });
});

describe('outlook: versioned writes', () => {
  const pool = () => agent.get('https://graph.microsoft.com');

  it('sends If-Match on PATCH and DELETE', async () => {
    const seen: string[] = [];
    pool()
      .intercept({ path: (p) => p.startsWith('/v1.0/me/events/AAMk-1'), method: 'PATCH' })
      .reply(
        200,
        (opts) => {
          seen.push(lower(opts.headers)['if-match']!);
          return JSON.stringify(O_EVENT);
        },
        { headers: JSON_HEADERS },
      );
    pool()
      .intercept({ path: (p) => p.startsWith('/v1.0/me/events/AAMk-1'), method: 'DELETE' })
      .reply(204, (opts) => {
        seen.push(lower(opts.headers)['if-match']!);
        return '';
      });
    const client = outlook({ accessToken: 't' });
    await client.updateBooking('AAMk-1', { title: 'x', ifVersion: 'W/"A"' });
    await client.cancelBooking('AAMk-1', { ifVersion: 'W/"B"' });
    expect(seen).toEqual(['W/"A"', 'W/"B"']);
  });

  it('checks the version before a cancel-with-message, which takes no If-Match', async () => {
    pool()
      .intercept({ path: (p) => p.startsWith('/v1.0/me/events/AAMk-1'), method: 'GET' })
      .reply(200, JSON.stringify({ '@odata.etag': 'W/"NEWER"', id: 'AAMk-1' }), {
        headers: JSON_HEADERS,
      });
    // No /cancel interceptor: reaching it would be the bug.
    await expect(
      outlook({ accessToken: 't' }).cancelBooking('AAMk-1', {
        reason: 'sick',
        ifVersion: 'W/"OLD"',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

const CAL = 'https://p57-caldav.icloud.com/123/calendars/home/';
const ICS_A = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:a',
  'SUMMARY:Dentist',
  'DTSTART:20260923T100000Z',
  'DTEND:20260923T110000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('apple: syncBookings (sync-collection)', () => {
  const pool = () => agent.get('https://p57-caldav.icloud.com');
  const client = () => apple({ username: 'u', appPassword: 'p', calendarUrl: CAL });

  it('reports upserts and deletes, and hands back the new token', async () => {
    let body = '';
    let depth = '';
    pool()
      .intercept({ path: '/123/calendars/home/', method: 'REPORT' })
      .reply(
        207,
        (opts) => {
          body = String(opts.body);
          depth = lower(opts.headers).depth ?? '';
          return (
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<multistatus xmlns="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">` +
            `<response><href>/123/calendars/home/a.ics</href><propstat><prop>` +
            `<getetag>"e-a-2"</getetag><cal:calendar-data>${ICS_A}</cal:calendar-data>` +
            `</prop><status>HTTP/1.1 200 OK</status></propstat></response>` +
            `<response><href>/123/calendars/home/b.ics</href><status>HTTP/1.1 404 Not Found</status></response>` +
            `<sync-token>HwoQEgwAAAAAAAAAAAAAAAAYARgAIhUIqbKJ6-vs4c0kEMml6Pmb0r7gjAEoAA==</sync-token>` +
            `</multistatus>`
          );
        },
        { headers: XML },
      );
    const res = await client().syncBookings!({ syncToken: 'HwoQ-previous' });
    expect(depth).toBe('0');
    expect(body).toContain('<d:sync-token>HwoQ-previous</d:sync-token>');
    expect(res.changes).toEqual([
      expect.objectContaining({
        type: 'upsert',
        booking: expect.objectContaining({ id: 'a', version: '"e-a-2"', title: 'Dentist' }),
      }),
      { type: 'delete', id: 'b' },
    ]);
    expect(res.syncToken).toBe('HwoQEgwAAAAAAAAAAAAAAAAYARgAIhUIqbKJ6-vs4c0kEMml6Pmb0r7gjAEoAA==');
  });

  it('fetches members reported without data via calendar-multiget', async () => {
    pool()
      .intercept({ path: '/123/calendars/home/', method: 'REPORT' })
      .reply(
        207,
        (opts) =>
          String(opts.body).includes('sync-collection')
            ? `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/123/calendars/home/a.ics</d:href>` +
              `<d:propstat><d:prop><d:getetag>"e1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>` +
              `</d:response><d:sync-token>T2</d:sync-token></d:multistatus>`
            : `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/123/calendars/home/a.ics</d:href>` +
              `<d:propstat><d:prop><d:getetag>"e1"</d:getetag><c:calendar-data>${ICS_A}</c:calendar-data></d:prop>` +
              `<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
        { headers: XML },
      )
      .times(2);
    const res = await client().syncBookings!();
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]).toMatchObject({ type: 'upsert', booking: { id: 'a', version: '"e1"' } });
    expect(res.syncToken).toBe('T2');
  });

  it('turns a truncated result into a page token', async () => {
    pool()
      .intercept({ path: '/123/calendars/home/', method: 'REPORT' })
      .reply(
        207,
        `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/123/calendars/home/</d:href>` +
          `<d:status>HTTP/1.1 507 Insufficient Storage</d:status><d:error><d:number-of-matches-within-limits/></d:error></d:response>` +
          `<d:sync-token>T-partial</d:sync-token></d:multistatus>`,
        { headers: XML },
      );
    const res = await client().syncBookings!();
    expect(res.nextPageToken).toBe('T-partial');
    expect(res.syncToken).toBeUndefined();
  });

  it('answers an out-of-date token with fullSyncRequired', async () => {
    pool()
      .intercept({ path: '/123/calendars/home/', method: 'REPORT' })
      .reply(
        403,
        `<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>`,
        { headers: XML },
      );
    expect(await client().syncBookings!({ syncToken: 'expired' })).toEqual({
      changes: [],
      fullSyncRequired: true,
    });
  });
});

describe('apple: versioned writes', () => {
  const pool = () => agent.get('https://p57-caldav.icloud.com');
  const client = () => apple({ username: 'u', appPassword: 'p', calendarUrl: CAL });

  it('reports the ETag as version and honours the caller ifVersion over the one it reads', async () => {
    pool()
      .intercept({ path: '/123/calendars/home/a.ics', method: 'GET' })
      .reply(200, ICS_A, { headers: { 'content-type': 'text/calendar', etag: '"read-now"' } })
      .times(2);
    let ifMatch = '';
    pool()
      .intercept({ path: '/123/calendars/home/a.ics', method: 'PUT' })
      .reply(412, (opts) => {
        ifMatch = lower(opts.headers)['if-match'] ?? '';
        return '';
      });
    expect((await client().getBooking('a')).version).toBe('"read-now"');
    await expect(
      client().updateBooking('a', { title: 'x', ifVersion: '"read-earlier"' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(ifMatch).toBe('"read-earlier"');
  });

  it('guards a whole-resource delete with ifVersion', async () => {
    let ifMatch = '';
    pool()
      .intercept({ path: '/123/calendars/home/a.ics', method: 'DELETE' })
      .reply(204, (opts) => {
        ifMatch = lower(opts.headers)['if-match'] ?? '';
        return '';
      });
    await client().cancelBooking('a', { ifVersion: '"v9"' });
    expect(ifMatch).toBe('"v9"');
  });
});
