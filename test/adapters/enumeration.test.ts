import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { setmore } from '../../src/adapters/setmore';
import { square } from '../../src/adapters/square';
import { microsoftBookings } from '../../src/adapters/microsoft_bookings';
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
