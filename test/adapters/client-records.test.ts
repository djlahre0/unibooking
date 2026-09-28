import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { phorest } from '../../src/adapters/phorest';
import { wix } from '../../src/adapters/wix';
import { zenoti } from '../../src/adapters/zenoti';
import { boulevard } from '../../src/adapters/boulevard';

// customers.list / get / create / update / delete against each provider's
// documented request shapes. Square and Microsoft Bookings are covered in
// their own adapter tests.

const JSON_HEADERS = { 'content-type': 'application/json' };
const json = (body: unknown) => JSON.stringify(body);

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

describe('phorest: client records', () => {
  const ORIGIN = 'https://platform.phorest.com';
  const CLIENTS = '/third-party-api-server/api/business/biz1/client';
  const client = () =>
    phorest({
      username: 'global/api@salon.com',
      password: 'p',
      businessId: 'biz1',
      branchId: 'br1',
    });
  const ANA = {
    clientId: 'cl1',
    version: 3,
    firstName: 'Ana',
    lastName: 'Silva',
    email: 'ana@x.com',
    mobile: '0871234567',
    notes: 'Prefers mornings',
    createdAt: '2026-01-01T00:00:00Z',
  };

  it('reads the documented `_embedded.clients` list and pages by number', async () => {
    let path = '';
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith(`${CLIENTS}?`), method: 'GET' })
      .reply(
        200,
        (o) => {
          path = String(o.path);
          return json({
            _embedded: { clients: [ANA] },
            page: { size: 100, totalElements: 150, totalPages: 2, number: 0 },
          });
        },
        { headers: JSON_HEADERS },
      );
    const r = await client().customers!.list!({ email: 'ana@x.com' });
    expect(path).toContain('email=ana%40x.com');
    expect(r.customers[0]).toMatchObject({
      id: 'cl1',
      name: 'Ana Silva',
      phone: '0871234567',
      note: 'Prefers mornings',
    });
    expect(r.nextPageToken).toBe('1');
  });

  it('findOrCreate now finds an existing client instead of creating a duplicate', async () => {
    // Regression: the list was read as a bare array, so the search always came
    // back empty and every call created a new client.
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith(`${CLIENTS}?`), method: 'GET' })
      .reply(200, json({ _embedded: { clients: [ANA] }, page: { totalPages: 1 } }), {
        headers: JSON_HEADERS,
      });
    expect(await client().customers!.findOrCreate({ email: 'ana@x.com' })).toBe('cl1');
  });

  it('update keeps the required names and sends the current version', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: `${CLIENTS}/cl1`, method: 'GET' })
      .reply(200, json(ANA), { headers: JSON_HEADERS });
    let body: any;
    pool.intercept({ path: `${CLIENTS}/cl1`, method: 'PUT' }).reply(
      200,
      (o) => {
        body = JSON.parse(String(o.body));
        return json({ ...ANA, mobile: '0879999999', version: 4 });
      },
      { headers: JSON_HEADERS },
    );
    const u = await client().customers!.update!('cl1', { phone: '0879999999' });
    expect(body).toMatchObject({
      clientId: 'cl1',
      version: 3,
      firstName: 'Ana',
      lastName: 'Silva',
      email: 'ana@x.com',
      mobile: '0879999999',
    });
    expect(u.phone).toBe('0879999999');
  });

  it('staff lists read the same object-shaped `_embedded` (shared helper)', async () => {
    agent
      .get(ORIGIN)
      .intercept({
        path: (p) => p.startsWith('/third-party-api-server/api/business/biz1/branch/br1/staff'),
        method: 'GET',
      })
      .reply(
        200,
        json({ _embedded: { staffs: [{ staffId: 's1', firstName: 'Bo', lastName: 'Li' }] } }),
        {
          headers: JSON_HEADERS,
        },
      );
    const r = await client().listStaff!();
    expect(r.staff.map((m) => m.name)).toEqual(['Bo Li']);
  });

  it('has no delete: Phorest only archives', () => {
    const c = client();
    expect(c.capabilities.customerDelete).toBe(false);
    expect(c.customers!.delete).toBeUndefined();
  });
});

describe('wix: client records', () => {
  const ORIGIN = 'https://www.wixapis.com';
  const client = () => wix({ accessToken: 'token' });
  const CONTACT = {
    id: 'ct1',
    revision: 7,
    info: {
      name: { first: 'Ana', last: 'Silva' },
      emails: { items: [{ email: 'ana@x.com', primary: true }] },
      company: 'Keep me',
    },
    primaryInfo: { email: 'ana@x.com', phone: '+15550100' },
    createdDate: '2026-01-01T00:00:00Z',
  };

  it('list queries with a filter and pages by offset', async () => {
    let body: any;
    agent
      .get(ORIGIN)
      .intercept({ path: '/contacts/v4/contacts/query', method: 'POST' })
      .reply(
        200,
        (o) => {
          body = JSON.parse(String(o.body));
          return json({
            contacts: [CONTACT],
            pagingMetadata: { count: 1, offset: 100, total: 250 },
          });
        },
        { headers: JSON_HEADERS },
      );
    const r = await client().customers!.list!({ pageToken: '100', email: 'ana@x.com' });
    expect(body.query).toEqual({
      filter: { 'info.emails.email': 'ana@x.com' },
      paging: { limit: 100, offset: 100 },
    });
    expect(r.customers[0]).toMatchObject({ id: 'ct1', name: 'Ana Silva', phone: '+15550100' });
    expect(r.nextPageToken).toBe('101');
  });

  it('update sends the current revision and keeps the rest of info', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: '/contacts/v4/contacts/ct1', method: 'GET' })
      .reply(200, json({ contact: CONTACT }), { headers: JSON_HEADERS });
    let body: any;
    pool.intercept({ path: '/contacts/v4/contacts/ct1', method: 'PATCH' }).reply(
      200,
      (o) => {
        body = JSON.parse(String(o.body));
        return json({ contact: { ...CONTACT, revision: 8, info: body.info } });
      },
      { headers: JSON_HEADERS },
    );
    const u = await client().customers!.update!('ct1', { name: 'Ana Costa' });
    expect(body.revision).toBe(7);
    // info is replaced wholesale, so untouched fields must be sent back.
    expect(body.info).toMatchObject({
      name: { first: 'Ana', last: 'Costa' },
      company: 'Keep me',
      emails: { items: [{ email: 'ana@x.com', primary: true }] },
    });
    expect(u.name).toBe('Ana Costa');
  });

  it('delete removes the contact', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/contacts/v4/contacts/ct1', method: 'DELETE' })
      .reply(200, '{}', { headers: JSON_HEADERS });
    await client().customers!.delete!('ct1');
  });
});

describe('zenoti: client records (guests)', () => {
  const ORIGIN = 'https://api.zenoti.com';
  const client = () => zenoti({ apiKey: 'k', centerId: 'c1' });
  const GUEST = {
    id: 'g1',
    code: 'G001',
    center_id: 'c1',
    personal_info: {
      first_name: 'Ana',
      last_name: 'Silva',
      email: 'ana@x.com',
      mobile_phone: { country_code: 1, number: '5550100' },
      gender: 1,
    },
    preferences: { receive_marketing_email: true },
  };

  it('list reads the center’s guests and offers the next page when full', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => p.startsWith('/v1/guests?'), method: 'GET' })
      .reply(200, json({ guests: [GUEST, { ...GUEST, id: 'g2' }] }), { headers: JSON_HEADERS });
    const r = await client().customers!.list!({ limit: 2 });
    expect(r.customers.map((x) => x.id)).toEqual(['g1', 'g2']);
    expect(r.customers[0]).toMatchObject({ name: 'Ana Silva', phone: '5550100' });
    expect(r.nextPageToken).toBe('2');
  });

  it('update PUTs the whole guest back with only personal_info changed', async () => {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: '/v1/guests/g1', method: 'GET' })
      .reply(200, json(GUEST), { headers: JSON_HEADERS });
    let body: any;
    pool.intercept({ path: '/v1/guests/g1', method: 'PUT' }).reply(
      200,
      (o) => {
        body = JSON.parse(String(o.body));
        return json(body);
      },
      { headers: JSON_HEADERS },
    );
    const u = await client().customers!.update!('g1', { email: 'ana.s@x.com' });
    // "send all the fields obtained from Retrieve guest details"
    expect(body).toMatchObject({
      id: 'g1',
      code: 'G001',
      center_id: 'c1',
      preferences: { receive_marketing_email: true },
      personal_info: {
        first_name: 'Ana',
        email: 'ana.s@x.com',
        gender: 1,
        mobile_phone: { country_code: 1, number: '5550100' },
      },
    });
    expect(u.email).toBe('ana.s@x.com');
  });
});

describe('boulevard: client records (read)', () => {
  it('lists the clients connection and pages by cursor', async () => {
    let body: any;
    agent
      .get('https://dashboard.boulevard.io')
      .intercept({ path: '/api/2020-01/admin', method: 'POST' })
      .reply(
        200,
        (o) => {
          body = JSON.parse(String(o.body));
          return json({
            data: {
              clients: {
                edges: [
                  {
                    node: {
                      id: 'urn:blvd:Client:1',
                      firstName: 'Ana',
                      lastName: 'Silva',
                      email: 'ana@x.com',
                      mobilePhone: '+15550100',
                    },
                  },
                ],
                pageInfo: { endCursor: 'CUR2', hasNextPage: true },
              },
            },
          });
        },
        { headers: JSON_HEADERS },
      );
    const c = boulevard({
      apiKey: 'k',
      apiSecret: 'c2VjcmV0',
      businessId: 'b1',
      locationId: 'urn:blvd:Location:L1',
    });
    const r = await c.customers!.list!({ pageToken: 'CUR1', email: 'ana@x.com' });
    expect(body.variables).toMatchObject({ after: 'CUR1', emails: ['ana@x.com'] });
    expect(r.customers[0]).toMatchObject({ id: 'urn:blvd:Client:1', name: 'Ana Silva' });
    expect(r.nextPageToken).toBe('CUR2');
    expect(c.customers!.update).toBeUndefined();
  });
});
