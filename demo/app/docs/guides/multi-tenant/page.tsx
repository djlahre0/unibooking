import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import { Callout, Code, DocPage, H2 } from '../../_components/Doc';

export const metadata: Metadata = docMetadata({
  title: 'Multi-tenant connections',
  description: 'Many businesses, many providers, one store you own.',
  href: '/docs/guides/multi-tenant',
});

export default function MultiTenant() {
  return (
    <DocPage
      href="/docs/guides/multi-tenant"
      title="Multi-tenant connections"
      lead="When each of your customers connects their own provider, unibooking/connections turns a stored connection into a ready client, with OAuth refresh wired in, from a store you implement."
    >
      <H2>Implement the store</H2>
      <p>
        <code>ConnectionStore</code> is an interface over your own database. The library defines it
        and never implements it: it still stores nothing.
      </p>
      <Code title="store.ts">{`
import type { ConnectionStore } from 'unibooking/connections';

export const store: ConnectionStore = {
  async get(tenantId, provider) {
    const row = await db.connections.find({ tenantId, provider });
    return row ? decrypt(row.data) : undefined;
  },
  async put(tenantId, provider, record) {
    await db.connections.upsert({ tenantId, provider, data: encrypt(record) });
  },
  async delete(tenantId, provider) {
    await db.connections.remove({ tenantId, provider });
  },
};
`}</Code>
      <p>
        A record holds <code>tokens</code> for OAuth providers and <code>fields</code> for keys and
        ids (<code>locationId</code>, <code>calendarId</code>, <code>siteId</code>…).
      </p>

      <H2>Get a client</H2>
      <Code>{`
import { connectionFor } from 'unibooking/connections';

const client = await connectionFor({
  tenantId: 'acme',
  provider: 'google',
  store,
  app: {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    redirectUri: process.env.GOOGLE_REDIRECT_URI!,
  },
});

await client.listBookings({ range });
`}</Code>
      <ul>
        <li>
          No stored connection fails as <code>AUTH</code>; incomplete fields fail as{' '}
          <code>INVALID_INPUT</code>, naming the missing keys (never their values).
        </li>
        <li>
          An expiring token is refreshed and written back through <code>store.put</code>{' '}
          <strong>before</strong> the request goes out.
        </li>
        <li>
          <code>app</code> is required only for a provider with a refresh token to use.
        </li>
      </ul>

      <H2>Disconnect</H2>
      <Code>{`
import { disconnect } from 'unibooking/connections';

await disconnect('acme', 'google', store);
`}</Code>

      <Callout type="warning" title="Encrypt at rest, and never cache across tenants">
        Tokens and fields are live credentials: encrypt them with your platform&apos;s KMS or{' '}
        <code>node:crypto</code> and a key from your environment. <code>connectionFor</code> returns
        a fresh client every call on purpose: a cache keyed wrong hands one tenant another&apos;s
        credentials.
      </Callout>
    </DocPage>
  );
}
