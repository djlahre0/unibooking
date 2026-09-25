import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import {
  connectionFor,
  disconnect,
  type ConnectionRecord,
  type ConnectionStore,
} from '../src/connections';
import { UnibookingError } from '../src/errors';
import type { ProviderId } from '../src/types';

/**
 * A store implemented the way a consumer would, in memory. It lives here and
 * never in `src/`, so it cannot be imported from the package and mistaken for
 * something production-ready.
 */
class FakeStore implements ConnectionStore {
  readonly rows = new Map<string, ConnectionRecord>();
  readonly puts: Array<{ tenantId: string; record: ConnectionRecord }> = [];
  /** Set to make every write fail, standing in for a database outage. */
  failWrites = false;

  private key(tenantId: string, provider: ProviderId): string {
    return `${tenantId}::${provider}`;
  }
  async get(tenantId: string, provider: ProviderId): Promise<ConnectionRecord | undefined> {
    return this.rows.get(this.key(tenantId, provider));
  }
  async put(tenantId: string, provider: ProviderId, record: ConnectionRecord): Promise<void> {
    if (this.failWrites) throw new Error('database unavailable');
    this.puts.push({ tenantId, record });
    this.rows.set(this.key(tenantId, provider), record);
  }
  async delete(tenantId: string, provider: ProviderId): Promise<void> {
    this.rows.delete(this.key(tenantId, provider));
  }
}

const APP = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://example.test/callback',
};

/** A secret that must never surface in an error message or a thrown value. */
const SENTINEL = 'sentinel-secret-value-do-not-leak-4f2a';

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
  vi.restoreAllMocks();
});

describe('connectionFor: resolving a stored connection', () => {
  it('refuses when the tenant has no stored connection', async () => {
    const store = new FakeStore();
    await expect(
      connectionFor({ tenantId: 't1', provider: 'google', store }),
    ).rejects.toMatchObject({ code: 'AUTH', provider: 'google' });
  });

  it('builds a client from stored non-OAuth credentials', async () => {
    const store = new FakeStore();
    await store.put('t1', 'bookeo', {
      provider: 'bookeo',
      fields: { apiKey: 'k', secretKey: 's' },
    });
    const client = await connectionFor({ tenantId: 't1', provider: 'bookeo', store });
    expect(client.id).toBe('bookeo');
  });

  it('names the missing field, and never the supplied value', async () => {
    const store = new FakeStore();
    // Square needs locationId as well; supply only the token.
    await store.put('t1', 'square', { provider: 'square', fields: { accessToken: SENTINEL } });

    const err = await connectionFor({ tenantId: 't1', provider: 'square', store }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnibookingError);
    const message = (err as UnibookingError).message;
    expect(message).toMatch(/locationId/);
    expect(message).not.toContain(SENTINEL);
  });

  it("offers both of Acuity's alternatives when neither is complete", async () => {
    const store = new FakeStore();
    await store.put('t1', 'acuity', { provider: 'acuity', fields: { userId: 'u' } });
    const err = await connectionFor({ tenantId: 't1', provider: 'acuity', store }).catch(
      (e: unknown) => e,
    );
    const message = (err as UnibookingError).message;
    // Either the API key alongside the user id, or an OAuth token instead.
    expect(message).toMatch(/apiKey/);
    expect(message).toMatch(/accessToken/);
    expect(message).toMatch(/or/);
  });

  it('accepts either Acuity credential set', async () => {
    const store = new FakeStore();
    await store.put('t1', 'acuity', { provider: 'acuity', fields: { userId: 'u', apiKey: 'k' } });
    expect((await connectionFor({ tenantId: 't1', provider: 'acuity', store })).id).toBe('acuity');

    await store.put('t2', 'acuity', { provider: 'acuity', fields: { accessToken: 'tok' } });
    expect((await connectionFor({ tenantId: 't2', provider: 'acuity', store })).id).toBe('acuity');
  });

  it("folds a stored OAuth access token into the provider's own field name", async () => {
    const store = new FakeStore();
    // Calendly calls it `token`, not `accessToken`; the record stores tokens
    // uniformly and the wiring maps it.
    await store.put('t1', 'calendly', {
      provider: 'calendly',
      tokens: { accessToken: 'cal-token', raw: {} },
    });
    expect((await connectionFor({ tenantId: 't1', provider: 'calendly', store })).id).toBe(
      'calendly',
    );
  });
});

describe('connectionFor: refresh writes through the store', () => {
  /** An expired Google connection, so the next call must refresh. */
  async function seedExpired(store: FakeStore, tenantId = 't1'): Promise<void> {
    await store.put(tenantId, 'google', {
      provider: 'google',
      tokens: {
        accessToken: 'stale',
        refreshToken: `refresh-${tenantId}`,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        raw: {},
      },
      fields: { calendarId: 'primary' },
    });
    store.puts.length = 0;
  }

  function mockRefresh(accessToken: string): void {
    agent
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
      });
  }

  function mockCalendarList(): void {
    agent
      .get('https://www.googleapis.com')
      .intercept({ path: /\/calendar\/v3\/users\/me\/calendarList.*/, method: 'GET' })
      .reply(200, { items: [] });
  }

  it('persists refreshed tokens BEFORE the request goes out', async () => {
    const store = new FakeStore();
    await seedExpired(store);
    mockRefresh('fresh-token');
    mockCalendarList();

    const client = await connectionFor({
      tenantId: 't1',
      provider: 'google',
      store,
      app: APP,
    });
    await client.listCalendars!();

    expect(store.puts.length).toBe(1);
    const written = store.puts[0]!.record;
    expect(written.tokens?.accessToken).toBe('fresh-token');
    // Google omits the refresh token on refresh; it must not be erased.
    expect(written.tokens?.refreshToken).toBe('refresh-t1');
    // The non-token fields survive the write.
    expect(written.fields?.calendarId).toBe('primary');
  });

  it('aborts the request when the store write fails, rather than proceeding', async () => {
    // Continuing here is how a refresh token is lost permanently: the provider
    // has rotated it, and the only copy never reached the database.
    const store = new FakeStore();
    await seedExpired(store);
    mockRefresh('fresh-token');
    store.failWrites = true;

    const client = await connectionFor({ tenantId: 't1', provider: 'google', store, app: APP });
    await expect(client.listCalendars!()).rejects.toThrow(/database unavailable/);
  });

  it('leaves the stored token untouched when the provider rejects the refresh', async () => {
    const store = new FakeStore();
    await seedExpired(store);
    agent
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(400, { error: 'invalid_grant' });

    const client = await connectionFor({ tenantId: 't1', provider: 'google', store, app: APP });
    await expect(client.listCalendars!()).rejects.toThrow();
    expect(store.puts.length).toBe(0);
    expect((await store.get('t1', 'google'))?.tokens?.accessToken).toBe('stale');
  });

  it('refuses an expiring OAuth connection with no app supplied', async () => {
    const store = new FakeStore();
    await seedExpired(store);
    const err = await connectionFor({ tenantId: 't1', provider: 'google', store }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnibookingError);
    expect((err as UnibookingError).code).toBe('INVALID_INPUT');
    expect((err as UnibookingError).message).toMatch(/OAuth app/i);
  });

  it('does not refresh a token that is still valid', async () => {
    const store = new FakeStore();
    await store.put('t1', 'google', {
      provider: 'google',
      tokens: {
        accessToken: 'still-good',
        refreshToken: 'r',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        raw: {},
      },
    });
    store.puts.length = 0;
    mockCalendarList();

    const client = await connectionFor({ tenantId: 't1', provider: 'google', store, app: APP });
    await client.listCalendars!();
    // No refresh interception was registered; reaching the token endpoint
    // would have thrown on the disabled net connect.
    expect(store.puts.length).toBe(0);
  });
});

describe('tenant isolation', () => {
  it("keeps two tenants' credentials apart when interleaved", async () => {
    const store = new FakeStore();
    await store.put('tenant-a', 'bookeo', {
      provider: 'bookeo',
      fields: { apiKey: 'A-key', secretKey: 'A-secret' },
    });
    await store.put('tenant-b', 'bookeo', {
      provider: 'bookeo',
      fields: { apiKey: 'B-key', secretKey: 'B-secret' },
    });

    // Interleaved, not sequential: a cache keyed wrong shows up here and not
    // in a one-tenant-at-a-time test.
    const [a1, b1, a2] = await Promise.all([
      connectionFor({ tenantId: 'tenant-a', provider: 'bookeo', store }),
      connectionFor({ tenantId: 'tenant-b', provider: 'bookeo', store }),
      connectionFor({ tenantId: 'tenant-a', provider: 'bookeo', store }),
    ]);
    // Distinct client instances -- nothing is shared or cached across tenants.
    expect(a1).not.toBe(b1);
    expect(a1).not.toBe(a2);
  });

  it('writes a refresh back to the refreshing tenant only', async () => {
    const store = new FakeStore();
    for (const t of ['tenant-a', 'tenant-b']) {
      await store.put(t, 'google', {
        provider: 'google',
        tokens: {
          accessToken: `${t}-stale`,
          refreshToken: `${t}-refresh`,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          raw: {},
        },
      });
    }
    store.puts.length = 0;
    agent
      .get('https://oauth2.googleapis.com')
      .intercept({ path: '/token', method: 'POST' })
      .reply(200, { access_token: 'a-fresh', token_type: 'Bearer', expires_in: 3600 });
    agent
      .get('https://www.googleapis.com')
      .intercept({ path: /\/calendar\/v3\/users\/me\/calendarList.*/, method: 'GET' })
      .reply(200, { items: [] });

    const a = await connectionFor({ tenantId: 'tenant-a', provider: 'google', store, app: APP });
    await a.listCalendars!();

    expect(store.puts.map((p) => p.tenantId)).toEqual(['tenant-a']);
    expect((await store.get('tenant-b', 'google'))?.tokens?.accessToken).toBe('tenant-b-stale');
  });
});

describe('disconnect', () => {
  it('removes the stored connection', async () => {
    const store = new FakeStore();
    await store.put('t1', 'bookeo', {
      provider: 'bookeo',
      fields: { apiKey: 'k', secretKey: 's' },
    });
    await disconnect('t1', 'bookeo', store);
    expect(await store.get('t1', 'bookeo')).toBeUndefined();
  });
});
