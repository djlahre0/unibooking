import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import { Callout, Code, DocPage, H2, H3 } from '../_components/Doc';
import { DIRECT_PROVIDERS, PROVIDER_META } from '@/lib/providers';

export const metadata: Metadata = docMetadata({
  title: 'Installation',
  description: 'Requirements, entry points, and which imports are server-only.',
  href: '/docs/installation',
});

const browserOk = [...DIRECT_PROVIDERS].map((id) => PROVIDER_META[id]?.label ?? id).join(', ');

export default function Installation() {
  return (
    <DocPage
      href="/docs/installation"
      title="Installation"
      lead="unibooking is one npm package with no runtime dependencies. Each part is a separate entry point, so you bundle only what you import."
    >
      <H2>Install</H2>
      <Code lang="bash">{`
npm install unibooking
# or
pnpm add unibooking
# or
yarn add unibooking
`}</Code>

      <H2>Requirements</H2>
      <ul>
        <li>
          <strong>
            A runtime with <code>fetch</code> and Web Crypto:
          </strong>{' '}
          Node.js 20 or later, Bun, Deno, Cloudflare Workers or Vercel Edge. Webhook verification
          and PKCE use <code>crypto.subtle</code>.
        </li>
        <li>
          <strong>TypeScript 5+</strong> for the types (optional). The package is written under{' '}
          <code>strict</code> and <code>exactOptionalPropertyTypes</code>, so it type-checks in the
          strictest configurations.
        </li>
        <li>
          On an older runtime, pass your own <code>fetch</code> through <code>ClientOptions</code>.
        </li>
      </ul>

      <H2>Entry points</H2>
      <table>
        <thead>
          <tr>
            <th>Import</th>
            <th>Contains</th>
            <th>Where it runs</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>unibooking</code>
            </td>
            <td>
              Types, errors, <code>withRetry</code>, <code>listAll</code>, time and availability
              helpers, the credential schema, the registry, and the adapter kit.
            </td>
            <td>Anywhere</td>
          </tr>
          <tr>
            <td>
              <code>unibooking/adapters/&lt;id&gt;</code>
            </td>
            <td>
              One provider&apos;s adapter, e.g. <code>unibooking/adapters/square</code>.
            </td>
            <td>Anywhere*</td>
          </tr>
          <tr>
            <td>
              <code>unibooking/webhooks/&lt;id&gt;</code>
            </td>
            <td>Signature verifiers and notification parsers.</td>
            <td>Server</td>
          </tr>
          <tr>
            <td>
              <code>unibooking/oauth</code>, <code>unibooking/oauth/&lt;id&gt;</code>
            </td>
            <td>
              OAuth clients and <code>withAutoRefresh</code>. They take a client secret.
            </td>
            <td>
              <strong>Server only</strong>
            </td>
          </tr>
          <tr>
            <td>
              <code>unibooking/connections</code>
            </td>
            <td>Per-tenant clients from a store you implement.</td>
            <td>
              <strong>Server only</strong>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="doc-footnote">
        * An adapter runs in a browser only when the provider accepts cross-origin requests. Tested
        from a real browser, these do: {browserOk}. Everything else must be called from your server.
      </p>

      <Callout type="warning" title="Keep OAuth on the server">
        Nothing under <code>unibooking/oauth</code> or <code>unibooking/connections</code> may be
        imported into browser code, both handle client secrets. No adapter imports them, so bundling
        an adapter can never pull them in by accident.
      </Callout>

      <H2>Module formats</H2>
      <H3>ES modules</H3>
      <Code>{`
import { withRetry, listAll } from 'unibooking';
import { square } from 'unibooking/adapters/square';
`}</Code>
      <H3>CommonJS</H3>
      <Code lang="js">{`
const { withRetry } = require('unibooking');
const { square } = require('unibooking/adapters/square');
`}</Code>

      <H2>Client options</H2>
      <p>Every adapter takes an optional second argument:</p>
      <Code>{`
const client = square(creds, {
  timeoutMs: 10_000, // per request; default 15000
  baseUrl: 'https://connect.squareupsandbox.com/v2/', // sandbox or regional host
  fetch: customFetch, // e.g. a proxy-aware fetch
});
`}</Code>
      <p>
        A <code>baseUrl</code> override is how you reach a provider&apos;s sandbox, a regional host,
        or a self-hosted CalDAV server. Each provider page lists the hosts it publishes.
      </p>
    </DocPage>
  );
}
