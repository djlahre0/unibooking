import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import type { BookingClient } from '../../src/types';

import { acuity } from '../../src/adapters/acuity';
import { apple } from '../../src/adapters/apple';
import { bookeo } from '../../src/adapters/bookeo';
import { boulevard } from '../../src/adapters/boulevard';
import { calendly } from '../../src/adapters/calendly';
import { google } from '../../src/adapters/google';
import { mangomint } from '../../src/adapters/mangomint';
import { microsoftBookings } from '../../src/adapters/microsoft_bookings';
import { mindbody } from '../../src/adapters/mindbody';
import { outlook } from '../../src/adapters/outlook';
import { phorest } from '../../src/adapters/phorest';
import { setmore } from '../../src/adapters/setmore';
import { square } from '../../src/adapters/square';
import { vagaro } from '../../src/adapters/vagaro';
import { wix } from '../../src/adapters/wix';
import { zenoti } from '../../src/adapters/zenoti';

const JSON_HEADERS = { 'content-type': 'application/json' };

interface Probe {
  name: string;
  origin: string;
  /** Pathname prefix the probe is expected to hit. */
  path: string;
  method: string;
  /** A healthy response body. */
  ok: unknown;
  /** Identity the probe should surface from `ok`, if any. */
  account?: { id?: string; name?: string; email?: string };
  make: () => BookingClient;
  /** Content type of the healthy reply. CalDAV answers XML, not JSON. */
  headers?: Record<string, string>;
}

const PROBES: Probe[] = [
  {
    name: 'google',
    origin: 'https://www.googleapis.com',
    path: '/calendar/v3/users/me/calendarList',
    method: 'GET',
    ok: { items: [{ id: 'primary' }] },
    account: { id: 'primary' },
    make: () => google({ accessToken: 't' }),
  },
  {
    name: 'outlook',
    origin: 'https://graph.microsoft.com',
    path: '/v1.0/me',
    method: 'GET',
    ok: { id: 'u1', displayName: 'Salon Owner', mail: 'owner@example.com' },
    account: { id: 'u1', name: 'Salon Owner', email: 'owner@example.com' },
    make: () => outlook({ accessToken: 't' }),
  },
  {
    name: 'microsoft_bookings',
    origin: 'https://graph.microsoft.com',
    path: '/v1.0/solutions/bookingBusinesses/BIZ1',
    method: 'GET',
    ok: { id: 'BIZ1', displayName: 'Glow Salon', email: 'biz@example.com' },
    account: { id: 'BIZ1', name: 'Glow Salon', email: 'biz@example.com' },
    make: () => microsoftBookings({ accessToken: 't', businessId: 'BIZ1' }),
  },
  {
    name: 'square',
    origin: 'https://connect.squareup.com',
    path: '/v2/locations',
    method: 'GET',
    // Two locations, and the credentials name the second — the probe must
    // report the bound one, not simply the first.
    ok: {
      locations: [
        { id: 'OTHER', name: 'Brooklyn' },
        { id: 'LOC1', name: 'Manhattan Glow' },
      ],
    },
    account: { id: 'LOC1', name: 'Manhattan Glow' },
    make: () => square({ accessToken: 't', locationId: 'LOC1' }),
  },
  {
    name: 'acuity',
    origin: 'https://acuityscheduling.com',
    path: '/api/v1/me',
    method: 'GET',
    ok: { id: 42, firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
    account: { id: '42', name: 'Jane Doe', email: 'jane@example.com' },
    make: () => acuity({ userId: 'u', apiKey: 'k' }),
  },
  {
    name: 'calendly',
    origin: 'https://api.calendly.com',
    path: '/users/me',
    method: 'GET',
    ok: {
      resource: {
        uri: 'https://api.calendly.com/users/U1',
        name: 'Jane',
        email: 'jane@example.com',
      },
    },
    account: {
      id: 'https://api.calendly.com/users/U1',
      name: 'Jane',
      email: 'jane@example.com',
    },
    make: () => calendly({ token: 't' }),
  },
  {
    name: 'setmore',
    origin: 'https://developer.setmore.com',
    path: '/api/v1/bookingapi/services',
    method: 'GET',
    ok: { response: true, data: { services: [] } },
    make: () => setmore({ accessToken: 't' }),
  },
  {
    name: 'zenoti',
    origin: 'https://api.zenoti.com',
    path: '/v1/centers',
    method: 'GET',
    ok: { centers: [{ id: 'C1', name: 'Downtown' }] },
    account: { id: 'C1', name: 'Downtown' },
    make: () => zenoti({ apiKey: 'k', centerId: 'C1' }),
  },
  {
    name: 'phorest',
    origin: 'https://platform.phorest.com',
    path: '/third-party-api-server/api/business/BIZ1',
    method: 'GET',
    ok: { businessId: 'BIZ1', name: 'Glow' },
    account: { id: 'BIZ1', name: 'Glow' },
    make: () =>
      phorest({ username: 'global/a@b.com', password: 'p', businessId: 'BIZ1', branchId: 'BR1' }),
  },
  {
    name: 'bookeo',
    origin: 'https://api.bookeo.com',
    path: '/v2/settings/business',
    method: 'GET',
    ok: { name: 'Glow Salon' },
    account: { name: 'Glow Salon' },
    make: () => bookeo({ apiKey: 'k', secretKey: 's' }),
  },
  {
    name: 'mindbody',
    origin: 'https://api.mindbodyonline.com',
    path: '/public/v6/site/sites',
    method: 'GET',
    ok: { Sites: [{ Id: 12345, Name: 'Glow' }] },
    account: { id: '12345', name: 'Glow' },
    make: () =>
      mindbody({ apiKey: 'k', siteId: '-99', accessToken: 't', timezone: 'America/New_York' }),
  },
  {
    name: 'boulevard',
    origin: 'https://dashboard.boulevard.io',
    path: '/api/2020-01/admin',
    method: 'POST',
    ok: { data: { myBusiness: { id: 'B1', name: 'Glow' } } },
    account: { id: 'B1', name: 'Glow' },
    make: () =>
      boulevard({ businessId: 'B1', locationId: 'L1', apiKey: 'k', apiSecret: btoa('secret') }),
  },
  {
    name: 'wix',
    origin: 'https://www.wixapis.com',
    path: '/bookings/v2/services',
    method: 'GET',
    ok: { services: [] },
    make: () => wix({ accessToken: 't' }),
  },
  {
    name: 'vagaro',
    origin: 'https://api.vagaro.com',
    path: '/us04/api/v2/locations',
    method: 'POST',
    ok: { data: [{ locationId: 'L1' }] },
    account: { id: 'BIZ1' },
    make: () => vagaro({ region: 'us04', businessId: 'BIZ1', accessToken: 't' }),
  },
  {
    name: 'apple',
    origin: 'https://caldav.icloud.com',
    path: '/123/calendars/home/',
    method: 'PROPFIND',
    ok: '<?xml version="1.0"?><multistatus xmlns="DAV:"></multistatus>',
    account: { name: 'user@icloud.com' },
    headers: { 'content-type': 'application/xml' },
    make: () =>
      apple({
        username: 'user@icloud.com',
        appPassword: 'p',
        calendarUrl: 'https://caldav.icloud.com/123/calendars/home/',
      }),
  },
];

function pathname(full: string): string {
  const q = full.indexOf('?');
  return q === -1 ? full : full.slice(0, q);
}

describe('checkConnection', () => {
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

  for (const p of PROBES) {
    it(`${p.name}: reports ok and the account it found`, async () => {
      agent
        .get(p.origin)
        .intercept({ path: (x) => pathname(x).startsWith(p.path), method: p.method })
        .reply(200, typeof p.ok === 'string' ? p.ok : JSON.stringify(p.ok), {
          headers: p.headers ?? JSON_HEADERS,
        });

      const status = await p.make().checkConnection();
      expect(status.ok).toBe(true);
      if (p.account) expect(status.account).toEqual(p.account);
      expect('raw' in status).toBe(true);
    });

    it(`${p.name}: reports a revoked token rather than throwing`, async () => {
      agent
        .get(p.origin)
        .intercept({ path: (x) => pathname(x).startsWith(p.path), method: p.method })
        .reply(401, JSON.stringify({ error: { message: 'revoked' } }), { headers: JSON_HEADERS });

      const status = await p.make().checkConnection();
      expect(status.ok).toBe(false);
      expect(status.reason).toBe('AUTH');
    });

    it(`${p.name}: a 500 throws rather than reporting a dead connection`, async () => {
      agent
        .get(p.origin)
        .intercept({ path: (x) => pathname(x).startsWith(p.path), method: p.method })
        .reply(500, JSON.stringify({ error: { message: 'boom' } }), { headers: JSON_HEADERS });

      // The distinction that matters: a server fault is not evidence that a
      // salon revoked access. Reporting ok:false here would make consumers
      // disconnect healthy integrations on a transient blip.
      await expect(p.make().checkConnection()).rejects.toMatchObject({ code: 'UPSTREAM' });
    });
  }

  it('mangomint: throws UNSUPPORTED (the adapter is a stub)', async () => {
    await expect(mangomint({ apiKey: 'k' }).checkConnection()).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });
});
