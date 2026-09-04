import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { square } from '../../src/adapters/square';
import { google } from '../../src/adapters/google';
import { setmore } from '../../src/adapters/setmore';
import { assertCanonicalService, assertCanonicalStaff } from '../conformance';

const ORIGIN = 'https://connect.squareup.com';
const JSON_HEADERS = { 'content-type': 'application/json' };

function pathname(full: string): string {
  const q = full.indexOf('?');
  return q === -1 ? full : full.slice(0, q);
}

/** A catalog ITEM with two variations, as Square returns it. */
function item(overrides: Record<string, unknown> = {}) {
  return {
    type: 'ITEM',
    id: 'ITEM_1',
    version: 100,
    item_data: {
      name: 'Gel Nails',
      description: 'Premium gel prep',
      product_type: 'APPOINTMENTS_SERVICE',
      variations: [
        {
          type: 'ITEM_VARIATION',
          id: 'VAR_1',
          version: 200,
          item_variation_data: {
            item_id: 'ITEM_1',
            name: 'Regular',
            service_duration: 1800000,
            price_money: { amount: 4500, currency: 'USD' },
            available_for_booking: true,
          },
        },
        {
          type: 'ITEM_VARIATION',
          id: 'VAR_2',
          version: 201,
          item_variation_data: {
            item_id: 'ITEM_1',
            name: 'Deluxe',
            service_duration: 3600000,
            price_money: { amount: 9000, currency: 'USD' },
            available_for_booking: true,
          },
        },
      ],
    },
    ...overrides,
  };
}

/**
 * UpsertCatalogObject's reply envelope — verified against live Square.
 *
 * Note this is NOT the RetrieveCatalogObject envelope: the retrieve returns
 * `{ object }`, the upsert returns `{ catalog_object, id_mappings }`. Mocking
 * the upsert with the retrieve's field is exactly how a broken write passed its
 * tests, so the two shapes are kept deliberately distinct here.
 */
function upsertReply(overrides: Record<string, unknown> = {}) {
  return {
    catalog_object: item(overrides),
    id_mappings: [
      { client_object_id: '#service', object_id: 'ITEM_1' },
      { client_object_id: '#variation', object_id: 'VAR_1' },
    ],
  };
}

function client() {
  return square({ accessToken: 't', locationId: 'LOC1' });
}

describe('square catalog writes', () => {
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

  /** Mock the two reads an update performs: the variation, then its parent. */
  function mockReads() {
    const pool = agent.get(ORIGIN);
    pool
      .intercept({ path: (p) => pathname(p) === '/v2/catalog/object/VAR_1', method: 'GET' })
      .reply(200, JSON.stringify({ object: item().item_data.variations[0] }), {
        headers: JSON_HEADERS,
      });
    pool
      .intercept({ path: (p) => pathname(p) === '/v2/catalog/object/ITEM_1', method: 'GET' })
      .reply(200, JSON.stringify({ object: item() }), { headers: JSON_HEADERS });
    return pool;
  }

  it('createService builds an appointments item with a nested variation', async () => {
    let body: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => pathname(p) === '/v2/catalog/object', method: 'POST' })
      .reply(
        200,
        (opts) => {
          body = JSON.parse(String(opts.body));
          return JSON.stringify(upsertReply());
        },
        { headers: JSON_HEADERS },
      );

    const service = await client().createService!({
      name: 'Gel Nails',
      description: 'Premium gel prep',
      durationMinutes: 30,
      price: { amount: 4500, currency: 'USD' },
    });

    const sent = body.object;
    expect(sent.type).toBe('ITEM');
    // Square requires this product type for a service to be bookable at all.
    expect(sent.item_data.product_type).toBe('APPOINTMENTS_SERVICE');
    // Placeholder ids must be '#'-prefixed; Square swaps them for real ones.
    expect(String(sent.id).startsWith('#')).toBe(true);
    const vd = sent.item_data.variations[0].item_variation_data;
    expect(vd.service_duration).toBe(1_800_000);
    expect(vd.price_money).toEqual({ amount: 4500, currency: 'USD' });
    expect(vd.pricing_type).toBe('FIXED_PRICING');
    expect(vd.available_for_booking).toBe(true);

    assertCanonicalService(service);
    // The returned id is the VARIATION id, matching what createBooking takes.
    expect(service.id).toBe('VAR_1');
  });

  it('createService without a price uses variable pricing rather than zero', async () => {
    let body: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => pathname(p) === '/v2/catalog/object', method: 'POST' })
      .reply(
        200,
        (opts) => {
          body = JSON.parse(String(opts.body));
          return JSON.stringify(upsertReply());
        },
        { headers: JSON_HEADERS },
      );

    await client().createService!({ name: 'Consult' });
    const vd = body.object.item_data.variations[0].item_variation_data;
    // A missing price is "ask at checkout", not "free".
    expect(vd.pricing_type).toBe('VARIABLE_PRICING');
    expect(vd.price_money).toBeUndefined();
  });

  it('updateService preserves fields the caller did not mention', async () => {
    const pool = mockReads();
    let body: any;
    pool.intercept({ path: (p) => pathname(p) === '/v2/catalog/object', method: 'POST' }).reply(
      200,
      (opts) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify(upsertReply());
      },
      { headers: JSON_HEADERS },
    );

    await client().updateService!('VAR_1', { name: 'Gel Nails Deluxe' });

    const sent = body.object;
    expect(sent.item_data.name).toBe('Gel Nails Deluxe');
    // Square's upsert REPLACES the object, so anything dropped here is erased.
    // The description, the untouched variation, and the version must survive.
    expect(sent.item_data.description).toBe('Premium gel prep');
    expect(sent.version).toBe(100);
    expect(sent.item_data.variations).toHaveLength(2);
    const v1 = sent.item_data.variations[0].item_variation_data;
    expect(v1.service_duration).toBe(1_800_000);
    expect(v1.price_money).toEqual({ amount: 4500, currency: 'USD' });
  });

  it('updateService writes duration and price onto the right variation', async () => {
    const pool = mockReads();
    let body: any;
    pool.intercept({ path: (p) => pathname(p) === '/v2/catalog/object', method: 'POST' }).reply(
      200,
      (opts) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify(upsertReply());
      },
      { headers: JSON_HEADERS },
    );

    await client().updateService!('VAR_1', {
      durationMinutes: 90,
      price: { amount: 12000, currency: 'USD' },
    });

    const vars = body.object.item_data.variations;
    expect(vars[0].item_variation_data.service_duration).toBe(5_400_000);
    expect(vars[0].item_variation_data.price_money).toEqual({ amount: 12000, currency: 'USD' });
    // The sibling variation must be untouched.
    expect(vars[1].item_variation_data.service_duration).toBe(3_600_000);
    expect(vars[1].item_variation_data.price_money).toEqual({ amount: 9000, currency: 'USD' });
  });

  it('setServiceActive flips available_for_booking without deleting anything', async () => {
    const pool = mockReads();
    let body: any;
    pool.intercept({ path: (p) => pathname(p) === '/v2/catalog/object', method: 'POST' }).reply(
      200,
      (opts) => {
        body = JSON.parse(String(opts.body));
        return JSON.stringify(upsertReply());
      },
      { headers: JSON_HEADERS },
    );

    await client().setServiceActive!('VAR_1', false);

    const vars = body.object.item_data.variations;
    expect(vars[0].item_variation_data.available_for_booking).toBe(false);
    // Nothing is removed: Square's real delete cascades from the item through
    // every variation, which is why setServiceActive exists instead.
    expect(vars).toHaveLength(2);
    expect(vars[1].item_variation_data.available_for_booking).toBe(true);
    expect(body.object.item_data.name).toBe('Gel Nails');
  });

  /**
   * `Service.active` must reflect `available_for_booking`, because that is the
   * exact field `setServiceActive` writes. Deriving `active` only from
   * `is_deleted` made the method contradict itself against live Square:
   * `setServiceActive(id, false)` returned a Service still claiming
   * `active: true`, and `listServices` reported unbookable services as active.
   */
  it('setServiceActive(false) returns a service that reports itself inactive', async () => {
    const pool = mockReads();
    // Echo the saved object back, the way Square does -- otherwise the mock
    // asserts nothing about what was actually written.
    pool.intercept({ path: (p) => pathname(p) === '/v2/catalog/object', method: 'POST' }).reply(
      200,
      (opts) => {
        const sent = JSON.parse(String(opts.body)).object;
        return JSON.stringify({ catalog_object: sent, id_mappings: [] });
      },
      { headers: JSON_HEADERS },
    );

    const service = await client().setServiceActive!('VAR_1', false);

    expect(service.id).toBe('VAR_1');
    expect(service.active).toBe(false);
  });

  it('listServices reports an unbookable variation as inactive', async () => {
    const unbookable = item();
    unbookable.item_data.variations[0]!.item_variation_data.available_for_booking = false;
    agent
      .get(ORIGIN)
      .intercept({
        path: (p) => pathname(p) === '/v2/catalog/search-catalog-items',
        method: 'POST',
      })
      .reply(200, JSON.stringify({ items: [unbookable] }), { headers: JSON_HEADERS });

    const { services } = await client().listServices!();

    // VAR_1 is switched off, VAR_2 is not -- the flag is per-variation.
    expect(services.find((s) => s.id === 'VAR_1')!.active).toBe(false);
    expect(services.find((s) => s.id === 'VAR_2')!.active).toBe(true);
  });

  it('updateService rejects an id that is not a service variation', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => pathname(p) === '/v2/catalog/object/ITEM_1', method: 'GET' })
      .reply(200, JSON.stringify({ object: { type: 'ITEM', id: 'ITEM_1' } }), {
        headers: JSON_HEADERS,
      });

    // Passing an ITEM id where a variation id belongs is the likeliest mistake,
    // so it must fail loudly rather than upserting something unintended.
    await expect(client().updateService!('ITEM_1', { name: 'x' })).rejects.toMatchObject({
      code: 'UPSTREAM',
      message: expect.stringContaining('not a service variation'),
    });
  });
});

describe('square staff writes', () => {
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

  it('createStaff splits the name and assigns the configured location', async () => {
    let body: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => pathname(p) === '/v2/team-members', method: 'POST' })
      .reply(
        200,
        (opts) => {
          body = JSON.parse(String(opts.body));
          return JSON.stringify({
            team_member: {
              id: 'TM1',
              given_name: 'Jane',
              family_name: 'Doe',
              email_address: 'jane@example.com',
              status: 'ACTIVE',
            },
          });
        },
        { headers: JSON_HEADERS },
      );

    const staff = await client().createStaff!({ name: 'Jane Doe', email: 'jane@example.com' });

    expect(body.team_member.given_name).toBe('Jane');
    expect(body.team_member.family_name).toBe('Doe');
    // Without an explicit assignment the member is bookable nowhere, and
    // listStaff's location filter would never surface them again.
    expect(body.team_member.assigned_locations).toEqual({
      assignment_type: 'EXPLICIT_LOCATIONS',
      location_ids: ['LOC1'],
    });
    assertCanonicalStaff(staff);
    expect(staff).toMatchObject({ id: 'TM1', name: 'Jane Doe', active: true });
  });

  it('setStaffActive deactivates rather than deletes', async () => {
    let body: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => pathname(p) === '/v2/team-members/TM1', method: 'PUT' })
      .reply(
        200,
        (opts) => {
          body = JSON.parse(String(opts.body));
          return JSON.stringify({
            team_member: { id: 'TM1', given_name: 'Jane', status: 'INACTIVE' },
          });
        },
        { headers: JSON_HEADERS },
      );

    const staff = await client().setStaffActive!('TM1', false);

    // Square has no team-member delete at all, so this is the only removal it
    // offers -- and past bookings keep resolving their staff member.
    expect(body.team_member.status).toBe('INACTIVE');
    expect(staff.active).toBe(false);
  });

  it('updateStaff sends only what was named', async () => {
    let body: any;
    agent
      .get(ORIGIN)
      .intercept({ path: (p) => pathname(p) === '/v2/team-members/TM1', method: 'PUT' })
      .reply(
        200,
        (opts) => {
          body = JSON.parse(String(opts.body));
          return JSON.stringify({
            team_member: { id: 'TM1', given_name: 'Jane', email_address: 'new@example.com' },
          });
        },
        { headers: JSON_HEADERS },
      );

    await client().updateStaff!('TM1', { email: 'new@example.com' });

    expect(body.team_member.email_address).toBe('new@example.com');
    // A partial update must not blank the name.
    expect(body.team_member.given_name).toBeUndefined();
    expect(body.team_member.status).toBeUndefined();
  });
});

describe('catalog write capability contract', () => {
  it('exposes write methods only where the flags claim them', () => {
    const sq = square({ accessToken: 't', locationId: 'L' });
    expect(sq.capabilities.serviceCatalogWrite).toBe(true);
    expect(typeof sq.createService).toBe('function');
    expect(typeof sq.setStaffActive).toBe('function');

    // Read-only providers must not pretend. Setmore can enumerate but its
    // Booking API has no service or staff create endpoint at all.
    const sm = setmore({ accessToken: 't' });
    expect(sm.capabilities.serviceCatalog).toBe(true);
    expect(sm.capabilities.serviceCatalogWrite).toBe(false);
    expect(sm.createService).toBeUndefined();

    // A plain calendar has no catalog in either direction.
    const g = google({ accessToken: 't' });
    expect(g.capabilities.serviceCatalogWrite).toBe(false);
    expect(g.createService).toBeUndefined();
    expect(g.updateStaff).toBeUndefined();
  });

  it('offers no delete on any provider', () => {
    // Deliberate: Square has no team-member delete, and its catalog delete
    // cascades from the item through every variation -- so a canonical
    // `delete` would mean something different, and irreversible, per provider.
    const sq = square({ accessToken: 't', locationId: 'L' }) as unknown as Record<string, unknown>;
    expect(sq.deleteService).toBeUndefined();
    expect(sq.deleteStaff).toBeUndefined();
  });
});
