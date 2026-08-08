import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { setmore } from '../../src/adapters/setmore';
import { square } from '../../src/adapters/square';
import { microsoftBookings } from '../../src/adapters/microsoft_bookings';
import { acuity } from '../../src/adapters/acuity';
import { zenoti } from '../../src/adapters/zenoti';
import { phorest } from '../../src/adapters/phorest';
import { bookeo } from '../../src/adapters/bookeo';
import { calendly } from '../../src/adapters/calendly';
import { mindbody } from '../../src/adapters/mindbody';
import { boulevard } from '../../src/adapters/boulevard';
import { wix } from '../../src/adapters/wix';
import { assertCanonicalService, assertCanonicalStaff } from '../conformance';

const JSON_HEADERS = { 'content-type': 'application/json' };

function pathname(full: string): string {
  const q = full.indexOf('?');
  return q === -1 ? full : full.slice(0, q);
}

describe('enumeration', () => {
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

  // --- Setmore -------------------------------------------------------------
  // Payloads are copied verbatim from the integration doc §5.2-5.4.

  describe('setmore', () => {
    const ORIGIN = 'https://developer.setmore.com';

    function mockCatalog() {
      const pool = agent.get(ORIGIN);
      pool
        .intercept({
          path: (p) => pathname(p) === '/api/v1/bookingapi/services',
          method: 'GET',
        })
        .reply(
          200,
          JSON.stringify({
            response: true,
            data: {
              services: [
                {
                  key: 'service_key_12345',
                  service_name: 'Full Set Acrylics',
                  service_description: 'Beautiful acrylic extensions',
                  cost: '65.00',
                  duration: '60',
                  category_key: 'cat_key_98765',
                },
              ],
            },
          }),
          { headers: JSON_HEADERS },
        );
      pool
        .intercept({
          path: (p) => pathname(p) === '/api/v1/bookingapi/services/categories',
          method: 'GET',
        })
        .reply(
          200,
          JSON.stringify({
            response: true,
            data: { categories: [{ key: 'cat_key_98765', category_name: 'Nail Services' }] },
          }),
          { headers: JSON_HEADERS },
        );
    }

    it('maps services and resolves the category name', async () => {
      mockCatalog();
      const { services } = await setmore({ accessToken: 't', currency: 'USD' }).listServices!();

      expect(services).toHaveLength(1);
      const s = services[0]!;
      assertCanonicalService(s);
      expect(s.id).toBe('service_key_12345');
      expect(s.name).toBe('Full Set Acrylics');
      expect(s.description).toBe('Beautiful acrylic extensions');
      expect(s.durationMinutes).toBe(60);
      // "65.00" -> 6500 minor units, paired with the credential currency.
      expect(s.price).toEqual({ amount: 6500, currency: 'USD' });
      expect(s.categoryId).toBe('cat_key_98765');
      expect(s.categoryName).toBe('Nail Services');
      agent.assertNoPendingInterceptors();
    });

    it('omits price entirely when no currency is configured', async () => {
      mockCatalog();
      // Setmore sends a bare `cost` with no currency. Guessing one would be
      // worse than omitting the field — the raw cost is still reachable.
      const { services } = await setmore({ accessToken: 't' }).listServices!();
      expect(services[0]!.price).toBeUndefined();
      expect((services[0]!.raw as any).cost).toBe('65.00');
    });

    it('maps staff', async () => {
      agent
        .get(ORIGIN)
        .intercept({ path: (p) => pathname(p) === '/api/v1/bookingapi/staffs', method: 'GET' })
        .reply(
          200,
          JSON.stringify({
            response: true,
            data: {
              staffs: [
                {
                  key: 'staff_key_55555',
                  staff_name: 'Sarah Smith',
                  email_id: 'sarah@glowgirl.com',
                  cell_phone: '555-0199',
                },
              ],
            },
          }),
          { headers: JSON_HEADERS },
        );

      const { staff } = await setmore({ accessToken: 't' }).listStaff!();
      expect(staff).toHaveLength(1);
      assertCanonicalStaff(staff[0]!);
      expect(staff[0]).toMatchObject({
        id: 'staff_key_55555',
        name: 'Sarah Smith',
        email: 'sarah@glowgirl.com',
        phone: '555-0199',
        active: true,
      });
    });
  });

  // --- Square --------------------------------------------------------------

  describe('square', () => {
    const ORIGIN = 'https://connect.squareup.com';

    it('flattens each catalog item into one service per variation', async () => {
      let body: any;
      agent
        .get(ORIGIN)
        .intercept({
          path: (p) => pathname(p) === '/v2/catalog/search-catalog-items',
          method: 'POST',
        })
        .reply(
          200,
          (opts) => {
            body = JSON.parse(String(opts.body));
            return JSON.stringify({
              items: [
                {
                  type: 'ITEM',
                  id: 'ITEM_111',
                  item_data: {
                    name: 'Gel Nails',
                    description: 'Premium gel prep',
                    category_id: 'CAT_1',
                    variations: [
                      {
                        type: 'ITEM_VARIATION',
                        id: 'VAR_222',
                        item_variation_data: {
                          name: 'Regular',
                          service_duration: 1800000,
                          price_money: { amount: 4500, currency: 'USD' },
                        },
                      },
                      {
                        type: 'ITEM_VARIATION',
                        id: 'VAR_333',
                        item_variation_data: {
                          name: 'Deluxe',
                          service_duration: 3600000,
                          price_money: { amount: 9000, currency: 'USD' },
                        },
                      },
                    ],
                  },
                },
              ],
              cursor: 'NEXT',
            });
          },
          { headers: JSON_HEADERS },
        );

      const { services, nextPageToken } = await square({
        accessToken: 't',
        locationId: 'LOC1',
      }).listServices!({ limit: 50 });

      expect(body.product_types).toEqual(['APPOINTMENTS_SERVICE']);
      expect(body.enabled_location_ids).toEqual(['LOC1']);

      // Two variations -> two services. The id must be the VARIATION id, since
      // that is what createBooking takes as service_variation_id.
      expect(services).toHaveLength(2);
      services.forEach(assertCanonicalService);
      expect(services.map((s) => s.id)).toEqual(['VAR_222', 'VAR_333']);

      // "Regular" is the default variation name and is not appended.
      expect(services[0]!.name).toBe('Gel Nails');
      expect(services[1]!.name).toBe('Gel Nails - Deluxe');

      expect(services[0]!.durationMinutes).toBe(30);
      expect(services[1]!.durationMinutes).toBe(60);
      expect(services[0]!.price).toEqual({ amount: 4500, currency: 'USD' });
      expect(services[0]!.categoryId).toBe('CAT_1');
      // The owning item stays reachable for consumers that need to regroup.
      expect((services[0]!.raw as any).item.id).toBe('ITEM_111');
      expect(nextPageToken).toBe('NEXT');
    });

    it('marks a deactivated team member inactive rather than hiding it', async () => {
      let body: any;
      agent
        .get(ORIGIN)
        .intercept({ path: (p) => pathname(p) === '/v2/team-members/search', method: 'POST' })
        .reply(
          200,
          (opts) => {
            body = JSON.parse(String(opts.body));
            return JSON.stringify({
              team_members: [
                {
                  id: 'TM1',
                  given_name: 'Jane',
                  family_name: 'Doe',
                  email_address: 'jane@example.com',
                  phone_number: '+15550100',
                  status: 'ACTIVE',
                },
                { id: 'TM2', given_name: 'Gone', status: 'INACTIVE' },
              ],
            });
          },
          { headers: JSON_HEADERS },
        );

      const { staff } = await square({ accessToken: 't', locationId: 'LOC1' }).listStaff!();

      // The query must NOT filter by status — doing so would make `active`
      // always true and hide members still referenced by past bookings.
      expect(body.query.filter.status).toBeUndefined();
      expect(body.query.filter.location_ids).toEqual(['LOC1']);

      staff.forEach(assertCanonicalStaff);
      expect(staff[0]).toMatchObject({ id: 'TM1', name: 'Jane Doe', active: true });
      expect(staff[1]).toMatchObject({ id: 'TM2', active: false });
    });
  });

  // --- Microsoft Bookings --------------------------------------------------

  describe('microsoft_bookings', () => {
    const ORIGIN = 'https://graph.microsoft.com';
    const BIZ = '/v1.0/solutions/bookingBusinesses/BIZ1';

    it('parses ISO-8601 durations and takes currency from the business', async () => {
      const pool = agent.get(ORIGIN);
      pool.intercept({ path: (p) => pathname(p) === `${BIZ}/services`, method: 'GET' }).reply(
        200,
        JSON.stringify({
          value: [
            {
              id: 'SVC1',
              displayName: 'Haircut',
              description: 'Cut and finish',
              defaultDuration: 'PT1H15M',
              defaultPrice: 45.5,
            },
          ],
        }),
        { headers: JSON_HEADERS },
      );
      // Graph puts the currency on the business, not the service.
      pool
        .intercept({ path: (p) => pathname(p) === BIZ, method: 'GET' })
        .reply(200, JSON.stringify({ id: 'BIZ1', defaultCurrencyIso: 'GBP' }), {
          headers: JSON_HEADERS,
        });

      const { services } = await microsoftBookings({
        accessToken: 't',
        businessId: 'BIZ1',
      }).listServices!();

      expect(services).toHaveLength(1);
      assertCanonicalService(services[0]!);
      expect(services[0]!.durationMinutes).toBe(75);
      expect(services[0]!.price).toEqual({ amount: 4550, currency: 'GBP' });
    });

    it('still returns services when the business lookup fails, just without price', async () => {
      const pool = agent.get(ORIGIN);
      pool.intercept({ path: (p) => pathname(p) === `${BIZ}/services`, method: 'GET' }).reply(
        200,
        JSON.stringify({
          value: [
            { id: 'SVC1', displayName: 'Haircut', defaultDuration: 'PT30M', defaultPrice: 20 },
          ],
        }),
        { headers: JSON_HEADERS },
      );
      // A currency lookup failure must not sink the whole catalog read.
      pool
        .intercept({ path: (p) => pathname(p) === BIZ, method: 'GET' })
        .reply(403, JSON.stringify({ error: { message: 'no' } }), { headers: JSON_HEADERS });

      const { services } = await microsoftBookings({
        accessToken: 't',
        businessId: 'BIZ1',
      }).listServices!();

      expect(services).toHaveLength(1);
      expect(services[0]!.durationMinutes).toBe(30);
      expect(services[0]!.price).toBeUndefined();
    });

    it('maps staff members', async () => {
      agent
        .get(ORIGIN)
        .intercept({ path: (p) => pathname(p) === `${BIZ}/staffMembers`, method: 'GET' })
        .reply(
          200,
          JSON.stringify({
            value: [{ id: 'ST1', displayName: 'Jane Doe', emailAddress: 'jane@example.com' }],
          }),
          { headers: JSON_HEADERS },
        );

      const { staff } = await microsoftBookings({
        accessToken: 't',
        businessId: 'BIZ1',
      }).listStaff!();

      assertCanonicalStaff(staff[0]!);
      expect(staff[0]).toMatchObject({
        id: 'ST1',
        name: 'Jane Doe',
        email: 'jane@example.com',
        active: true,
      });
    });
  });
});

// --- Spec-derived providers ------------------------------------------------
// These mappings come from published API references, not live captures. See the
// verification-status note in the README.

describe('enumeration (spec-derived)', () => {
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

  it('acuity maps appointment types and calendars', async () => {
    agent
      .get('https://acuityscheduling.com')
      .intercept({ path: (p) => pathname(p) === '/api/v1/appointment-types', method: 'GET' })
      .reply(
        200,
        JSON.stringify([
          {
            id: 1,
            name: 'Gel Manicure',
            description: 'Gel polish',
            duration: 45,
            price: '45.00',
            category: 'Nails',
            active: true,
          },
          { id: 2, name: 'Retired', duration: 30, price: '10.00', active: false },
        ]),
        { headers: JSON_HEADERS },
      );

    const { services } = await acuity({
      userId: 'u',
      apiKey: 'k',
      currency: 'USD',
    }).listServices!();

    services.forEach(assertCanonicalService);
    expect(services[0]).toMatchObject({
      id: '1',
      name: 'Gel Manicure',
      durationMinutes: 45,
      categoryName: 'Nails',
      active: true,
    });
    expect(services[0]!.price).toEqual({ amount: 4500, currency: 'USD' });
    // Acuity has a real active flag, so an inactive type is reported, not hidden.
    expect(services[1]!.active).toBe(false);
  });

  it('acuity omits price when no currency is configured', async () => {
    agent
      .get('https://acuityscheduling.com')
      .intercept({ path: (p) => pathname(p) === '/api/v1/appointment-types', method: 'GET' })
      .reply(200, JSON.stringify([{ id: 1, name: 'X', duration: 30, price: '45.00' }]), {
        headers: JSON_HEADERS,
      });
    const { services } = await acuity({ userId: 'u', apiKey: 'k' }).listServices!();
    expect(services[0]!.price).toBeUndefined();
  });

  it('acuity staff are calendars, whose id is what createBooking sends', async () => {
    agent
      .get('https://acuityscheduling.com')
      .intercept({ path: (p) => pathname(p) === '/api/v1/calendars', method: 'GET' })
      .reply(200, JSON.stringify([{ id: 77, name: 'Jane', email: 'jane@example.com' }]), {
        headers: JSON_HEADERS,
      });
    const { staff } = await acuity({ userId: 'u', apiKey: 'k' }).listStaff!();
    assertCanonicalStaff(staff[0]!);
    // createBooking sends staffId as calendarID, so this must be the calendar id.
    expect(staff[0]).toMatchObject({ id: '77', name: 'Jane', email: 'jane@example.com' });
  });

  it('zenoti maps services and therapists for the configured center', async () => {
    const pool = agent.get('https://api.zenoti.com');
    pool.intercept({ path: (p) => pathname(p) === '/v1/centers/C1/services', method: 'GET' }).reply(
      200,
      JSON.stringify({
        services: [
          {
            id: 'S1',
            name: 'Facial',
            description: 'Deep clean',
            duration: 60,
            category: { id: 'CAT', name: 'Skin' },
            is_active: true,
          },
        ],
      }),
      { headers: JSON_HEADERS },
    );
    pool
      .intercept({ path: (p) => pathname(p) === '/v1/centers/C1/therapists', method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          therapists: [
            {
              id: 'T1',
              personal_info: { first_name: 'Ann', last_name: 'Lee', email: 'ann@example.com' },
            },
          ],
        }),
        { headers: JSON_HEADERS },
      );

    const client = zenoti({ apiKey: 'k', centerId: 'C1' });
    const { services } = await client.listServices!();
    const { staff } = await client.listStaff!();

    assertCanonicalService(services[0]!);
    assertCanonicalStaff(staff[0]!);
    expect(services[0]).toMatchObject({
      id: 'S1',
      name: 'Facial',
      durationMinutes: 60,
      categoryName: 'Skin',
    });
    expect(staff[0]).toMatchObject({ id: 'T1', name: 'Ann Lee', email: 'ann@example.com' });
  });

  it('phorest unwraps HAL _embedded for services and staff', async () => {
    const pool = agent.get('https://platform.phorest.com');
    const root = '/third-party-api-server/api/business/B1/branch/BR1';
    pool.intercept({ path: (p) => pathname(p) === root + '/service', method: 'GET' }).reply(
      200,
      JSON.stringify({
        _embedded: [{ serviceId: 'SV1', name: 'Cut', price: 30.5, duration: 45 }],
      }),
      { headers: JSON_HEADERS },
    );
    pool.intercept({ path: (p) => pathname(p) === root + '/staff', method: 'GET' }).reply(
      200,
      JSON.stringify({
        _embedded: [{ staffId: 'ST1', firstName: 'Bo', lastName: 'Ng', archived: false }],
      }),
      { headers: JSON_HEADERS },
    );

    const client = phorest({
      username: 'global/a@b.com',
      password: 'p',
      businessId: 'B1',
      branchId: 'BR1',
      currency: 'EUR',
    });
    const { services } = await client.listServices!();
    const { staff } = await client.listStaff!();

    assertCanonicalService(services[0]!);
    assertCanonicalStaff(staff[0]!);
    expect(services[0]!.price).toEqual({ amount: 3050, currency: 'EUR' });
    expect(staff[0]).toMatchObject({ id: 'ST1', name: 'Bo Ng', active: true });
  });

  it('bookeo maps products and parses ISO-8601 durations', async () => {
    agent
      .get('https://api.bookeo.com')
      .intercept({ path: (p) => pathname(p) === '/v2/settings/products', method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          data: [{ productId: 'P1', name: 'Tour', description: 'Walking', duration: 'PT1H30M' }],
        }),
        { headers: JSON_HEADERS },
      );

    const { services } = await bookeo({ apiKey: 'k', secretKey: 's' }).listServices!();
    assertCanonicalService(services[0]!);
    expect(services[0]).toMatchObject({ id: 'P1', name: 'Tour', durationMinutes: 90 });
    // Bookeo prices are per people-category tiers, so there is no single price.
    expect(services[0]!.price).toBeUndefined();
  });

  it('bookeo exposes no staff directory (it has no staff concept here)', () => {
    const client = bookeo({ apiKey: 'k', secretKey: 's' });
    expect(client.capabilities.staffDirectory).toBe(false);
    expect(client.listStaff).toBeUndefined();
  });
});

describe('enumeration (spec-derived, part 2)', () => {
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

  it('calendly resolves the current user, then lists event types by URI', async () => {
    const pool = agent.get('https://api.calendly.com');
    pool
      .intercept({ path: (p) => pathname(p) === '/users/me', method: 'GET' })
      .reply(200, JSON.stringify({ resource: { uri: 'https://api.calendly.com/users/U1' } }), {
        headers: JSON_HEADERS,
      });
    let sawUser: string | null = null;
    pool.intercept({ path: (p) => pathname(p) === '/event_types', method: 'GET' }).reply(
      200,
      (opts) => {
        sawUser = new URL('https://x' + String(opts.path)).searchParams.get('user');
        return JSON.stringify({
          collection: [
            {
              uri: 'https://api.calendly.com/event_types/ET1',
              name: 'Consult',
              description_plain: 'A chat',
              duration: 30,
              active: true,
            },
          ],
          pagination: { next_page_token: 'NEXT' },
        });
      },
      { headers: JSON_HEADERS },
    );

    const { services, nextPageToken } = await calendly({ token: 't' }).listServices!();

    // event_types is scoped to a user; the token alone does not say which.
    expect(sawUser).toBe('https://api.calendly.com/users/U1');
    assertCanonicalService(services[0]!);
    // createBooking takes the event type URI as serviceId, so the URI must
    // round-trip -- not a slug or name.
    expect(services[0]!.id).toBe('https://api.calendly.com/event_types/ET1');
    expect(services[0]).toMatchObject({ name: 'Consult', durationMinutes: 30, active: true });
    expect(nextPageToken).toBe('NEXT');
  });

  it('calendly exposes no staff directory', () => {
    const client = calendly({ token: 't' });
    expect(client.capabilities.staffDirectory).toBe(false);
    expect(client.listStaff).toBeUndefined();
  });

  it('mindbody enumerates session types, which is what createBooking takes', async () => {
    const pool = agent.get('https://api.mindbodyonline.com');
    pool
      .intercept({ path: (p) => pathname(p) === '/public/v6/site/sessiontypes', method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          SessionTypes: [{ Id: 55, Name: 'Massage', DefaultTimeLength: 60, ProgramId: 3 }],
        }),
        { headers: JSON_HEADERS },
      );
    pool.intercept({ path: (p) => pathname(p) === '/public/v6/staff/staff', method: 'GET' }).reply(
      200,
      JSON.stringify({
        StaffMembers: [
          { Id: 9, FirstName: 'Ann', LastName: 'Lee', Email: 'ann@example.com', isActive: true },
        ],
      }),
      { headers: JSON_HEADERS },
    );

    const client = mindbody({
      apiKey: 'k',
      siteId: '-99',
      accessToken: 't',
      timezone: 'America/New_York',
    });
    const { services } = await client.listServices!();
    const { staff } = await client.listStaff!();

    assertCanonicalService(services[0]!);
    assertCanonicalStaff(staff[0]!);
    // createBooking sends serviceId as SessionTypeId.
    expect(services[0]).toMatchObject({ id: '55', name: 'Massage', durationMinutes: 60 });
    expect(staff[0]).toMatchObject({ id: '9', name: 'Ann Lee', active: true });
  });

  it('boulevard unwraps Relay edges for services and staff', async () => {
    const pool = agent.get('https://dashboard.boulevard.io');
    pool.intercept({ path: (p) => pathname(p) === '/api/2020-01/admin', method: 'POST' }).reply(
      200,
      JSON.stringify({
        data: {
          services: {
            edges: [
              { node: { id: 'SV1', name: 'Blowout', description: 'Wash', defaultDuration: 45 } },
            ],
          },
        },
      }),
      { headers: JSON_HEADERS },
    );
    pool.intercept({ path: (p) => pathname(p) === '/api/2020-01/admin', method: 'POST' }).reply(
      200,
      JSON.stringify({
        data: {
          staff: {
            edges: [{ node: { id: 'ST1', firstName: 'Cy', lastName: 'Ro', email: 'cy@x.com' } }],
          },
        },
      }),
      { headers: JSON_HEADERS },
    );

    const client = boulevard({
      businessId: 'B1',
      locationId: 'L1',
      apiKey: 'k',
      apiSecret: btoa('secret'),
    });
    const { services } = await client.listServices!();
    const { staff } = await client.listStaff!();

    assertCanonicalService(services[0]!);
    assertCanonicalStaff(staff[0]!);
    expect(services[0]).toMatchObject({ id: 'SV1', name: 'Blowout', durationMinutes: 45 });
    expect(staff[0]).toMatchObject({ id: 'ST1', name: 'Cy Ro', email: 'cy@x.com' });
  });

  it('wix maps services with their fixed price and currency', async () => {
    agent
      .get('https://www.wixapis.com')
      .intercept({ path: (p) => pathname(p) === '/bookings/v2/services', method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          services: [
            {
              id: 'SVC1',
              name: 'Facial',
              description: 'Glow',
              payment: { fixed: { price: { value: '80.00', currency: 'GBP' } } },
              category: { id: 'C1', name: 'Skin' },
              hidden: false,
            },
          ],
          pagingMetadata: { cursors: { next: 'CUR' } },
        }),
        { headers: JSON_HEADERS },
      );

    const { services, nextPageToken } = await wix({ accessToken: 't' }).listServices!();
    assertCanonicalService(services[0]!);
    // Wix supplies its own currency, so price does not need a credential.
    expect(services[0]!.price).toEqual({ amount: 8000, currency: 'GBP' });
    expect(services[0]).toMatchObject({ id: 'SVC1', categoryName: 'Skin', active: true });
    expect(nextPageToken).toBe('CUR');
  });

  it('wix exposes no staff directory (resource-id shape unconfirmed)', () => {
    // A directory returning ids createBooking would reject is worse than none:
    // it fails later, at booking time, as an opaque provider error.
    const client = wix({ accessToken: 't' });
    expect(client.capabilities.staffDirectory).toBe(false);
    expect(client.listStaff).toBeUndefined();
  });
});
