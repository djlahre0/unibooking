import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import { square } from '../../src/adapters/square';
import { acuity } from '../../src/adapters/acuity';

const JSON_HEADERS = { 'content-type': 'application/json' };
const SQ = 'https://connect.squareup.com';
const AC = 'https://acuityscheduling.com';

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

function on(origin: string, prefix: string, method = 'GET') {
  return agent.get(origin).intercept({ path: (p) => p.split('?')[0]!.startsWith(prefix), method });
}

const sq = () => square({ accessToken: 't', locationId: 'L1' });
const ac = () => acuity({ userId: 'u', apiKey: 'k' });

/** A Square catalog item with two variations, each with its own staff. */
function squareItems() {
  return {
    items: [
      {
        id: 'item_1',
        item_data: {
          name: 'Haircut',
          category_id: 'cat_1',
          variations: [
            {
              id: 'var_1',
              item_variation_data: {
                name: 'Regular',
                service_duration: 1_800_000,
                team_member_ids: ['tm_1', 'tm_2'],
              },
            },
            {
              id: 'var_2',
              item_variation_data: {
                name: 'Long',
                service_duration: 3_600_000,
                team_member_ids: ['tm_2'],
              },
            },
          ],
        },
      },
    ],
  };
}

describe('square staff/service assignment', () => {
  it('reads staffIds off the variation, which is what Service.id already is', async () => {
    on(SQ, '/v2/catalog/search-catalog-items', 'POST').reply(200, JSON.stringify(squareItems()), {
      headers: JSON_HEADERS,
    });

    const { services } = await sq().listServices!();
    expect(services.map((s) => [s.id, s.staffIds])).toEqual([
      ['var_1', ['tm_1', 'tm_2']],
      ['var_2', ['tm_2']],
    ]);
  });

  it('filters services by staffId', async () => {
    on(SQ, '/v2/catalog/search-catalog-items', 'POST').reply(200, JSON.stringify(squareItems()), {
      headers: JSON_HEADERS,
    });

    const { services } = await sq().listServices!({ staffId: 'tm_1' });
    expect(services.map((s) => s.id)).toEqual(['var_1']);
  });

  it('filters services by categoryId', async () => {
    on(SQ, '/v2/catalog/search-catalog-items', 'POST').reply(200, JSON.stringify(squareItems()), {
      headers: JSON_HEADERS,
    });
    const { services } = await sq().listServices!({ categoryId: 'nope' });
    expect(services).toEqual([]);
  });

  it('leaves staffIds undefined when Square omits the field, rather than inventing []', async () => {
    // "did not say" and "said nobody" are different answers.
    on(SQ, '/v2/catalog/search-catalog-items', 'POST').reply(
      200,
      JSON.stringify({
        items: [
          {
            id: 'i',
            item_data: {
              name: 'X',
              variations: [
                { id: 'v', item_variation_data: { name: 'Regular', service_duration: 60_000 } },
              ],
            },
          },
        ],
      }),
      { headers: JSON_HEADERS },
    );
    const { services } = await sq().listServices!();
    expect(services[0]!.staffIds).toBeUndefined();

    const empty = squareItems();
    empty.items[0]!.item_data.variations[0]!.item_variation_data.team_member_ids = [];
    on(SQ, '/v2/catalog/search-catalog-items', 'POST').reply(200, JSON.stringify(empty), {
      headers: JSON_HEADERS,
    });
    const second = await sq().listServices!();
    expect(second.services[0]!.staffIds).toEqual([]);
  });

  it('filters staff by serviceId using the variation the link lives on', async () => {
    on(SQ, '/v2/team-members/search', 'POST').reply(
      200,
      JSON.stringify({
        team_members: [
          { id: 'tm_1', given_name: 'Ana', status: 'ACTIVE' },
          { id: 'tm_2', given_name: 'Bo', status: 'ACTIVE' },
        ],
      }),
      { headers: JSON_HEADERS },
    );
    on(SQ, '/v2/catalog/object/var_2').reply(
      200,
      JSON.stringify({
        object: { id: 'var_2', item_variation_data: { team_member_ids: ['tm_2'] } },
      }),
      { headers: JSON_HEADERS },
    );

    const { staff } = await sq().listStaff!({ serviceId: 'var_2' });
    expect(staff.map((s) => s.id)).toEqual(['tm_2']);
  });

  it('does not make the extra catalog call when no serviceId filter is given', async () => {
    on(SQ, '/v2/team-members/search', 'POST').reply(
      200,
      JSON.stringify({ team_members: [{ id: 'tm_1', given_name: 'Ana', status: 'ACTIVE' }] }),
      { headers: JSON_HEADERS },
    );
    // No catalog interceptor registered — a call would fail outright.
    const { staff } = await sq().listStaff!();
    expect(staff).toHaveLength(1);
    agent.assertNoPendingInterceptors();
  });
});

describe('square categories', () => {
  it('lists catalog categories', async () => {
    on(SQ, '/v2/catalog/search-catalog-objects', 'POST').reply(
      200,
      JSON.stringify({
        objects: [
          { id: 'cat_1', category_data: { name: 'Hair' } },
          { id: 'cat_2', category_data: { name: 'Nails' } },
          { id: '', category_data: { name: 'broken' } },
        ],
      }),
      { headers: JSON_HEADERS },
    );

    const { categories } = await sq().listCategories!();
    expect(categories.map((c) => [c.id, c.name])).toEqual([
      ['cat_1', 'Hair'],
      ['cat_2', 'Nails'],
    ]);
    expect(categories.every((c) => c.provider === 'square')).toBe(true);
  });
});

/** Acuity appointment types; `calendarIDs` is the staff link. */
function acTypes() {
  return [
    { id: 1, name: 'Haircut', duration: 30, category: 'Hair', calendarIDs: [11, 12] },
    { id: 2, name: 'Colour', duration: 90, category: 'Hair', calendarIDs: [12] },
    { id: 3, name: 'Manicure', duration: 45, category: 'Nails', calendarIDs: [] },
  ];
}

describe('acuity staff/service assignment and categories', () => {
  it('maps calendarIDs to staffIds as strings, matching Staff.id', async () => {
    on(AC, '/api/v1/appointment-types').reply(200, JSON.stringify(acTypes()), {
      headers: JSON_HEADERS,
    });
    const { services } = await ac().listServices!();
    expect(services.map((s) => s.staffIds)).toEqual([['11', '12'], ['12'], []]);
  });

  it('filters by staffId', async () => {
    on(AC, '/api/v1/appointment-types').reply(200, JSON.stringify(acTypes()), {
      headers: JSON_HEADERS,
    });
    const { services } = await ac().listServices!({ staffId: '11' });
    expect(services.map((s) => s.name)).toEqual(['Haircut']);
  });

  it('sets categoryId to the category name so it joins with listCategories', async () => {
    on(AC, '/api/v1/appointment-types').reply(200, JSON.stringify(acTypes()), {
      headers: JSON_HEADERS,
    });
    const { services } = await ac().listServices!({ categoryId: 'Nails' });
    expect(services.map((s) => s.name)).toEqual(['Manicure']);
  });

  it('derives a de-duplicated, sorted category list', async () => {
    on(AC, '/api/v1/appointment-types').reply(200, JSON.stringify(acTypes()), {
      headers: JSON_HEADERS,
    });
    const { categories } = await ac().listCategories!();
    // Hair appears on two types but must be listed once.
    expect(categories.map((c) => c.id)).toEqual(['Hair', 'Nails']);
    expect(categories.every((c) => c.id === c.name)).toBe(true);
  });

  it('ignores blank categories rather than emitting an empty grouping', async () => {
    on(AC, '/api/v1/appointment-types').reply(
      200,
      JSON.stringify([{ id: 1, name: 'X', duration: 30, category: '   ' }]),
      { headers: JSON_HEADERS },
    );
    const { categories } = await ac().listCategories!();
    expect(categories).toEqual([]);
  });
});
