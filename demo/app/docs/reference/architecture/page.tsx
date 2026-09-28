import type { Metadata } from 'next';
import Link from 'next/link';
import { docMetadata } from '@/lib/docs/meta';
import { Callout, Code, DocPage, H2, H3 } from '../../_components/Doc';

export const metadata: Metadata = docMetadata({
  title: 'Architecture',
  description:
    'How unibooking is built: the adapter layers, the request pipeline, security guarantees, and how the explorer and its API routes fit together.',
  href: '/docs/reference/architecture',
});

const ROUTES: Array<[string, string, string]> = [
  ['POST /api/call', 'Explorer', 'Runs one operation for a provider that blocks browser calls.'],
  [
    'GET /api/calendar/status',
    'My Calendar',
    'Which sign-in options are configured, and who is connected.',
  ],
  [
    'GET /api/calendar/connect/[provider]',
    'My Calendar',
    'Starts Google or Microsoft sign-in (PKCE).',
  ],
  [
    'GET /api/calendar/callback/[provider]',
    'My Calendar',
    'Finishes sign-in and seals the session cookie.',
  ],
  [
    'POST /api/calendar/apple',
    'My Calendar',
    'Checks an Apple ID and app-specific password, then seals them.',
  ],
  ['POST /api/calendar/call', 'My Calendar', 'Calendar operations for the signed-in account.'],
  [
    'POST /api/calendar/explore',
    'Explorer',
    'Explorer operations using the My Calendar session instead of a pasted token.',
  ],
  ['POST /api/calendar/disconnect', 'My Calendar', 'Clears the session cookie.'],
  [
    '/api/calendar/oauth-app/[provider]',
    'My Calendar',
    'Saves or resets an OAuth app, from localhost only.',
  ],
];

export default function Architecture() {
  return (
    <DocPage
      href="/docs/reference/architecture"
      title="Architecture"
      lead="unibooking is a set of adapters behind one interface, a small shared core, and helpers that stay out of your way. This page explains how the pieces fit, how a request travels, and what the library guarantees."
    >
      <H2>The layers</H2>
      <Code lang="text" title="From your code to a provider">{`
Your application
   │  BookingClient: one interface for every provider
   ▼
Adapter (unibooking/adapters/<id>)
   │  maps canonical input to the provider's API and back
   ▼
Adapter kit (defineAdapter)
   │  shared guarantees: status filter, slot order, page limits,
   │  version guards, get-by-id fallbacks
   ▼
HTTP layer (createHttp)
   │  credentials, timeouts, error mapping, host guard
   ▼
Provider API (Google, Square, Acuity, ...)
`}</Code>
      <ul>
        <li>
          <strong>Adapters</strong> (<code>src/adapters/</code>) hold everything provider-specific:
          endpoints, field names, time conventions, quirks. Each one is a <code>defineAdapter</code>{' '}
          call, so every adapter gets the same guarantees.
        </li>
        <li>
          <strong>The core</strong> (<code>src/</code>) holds the canonical types, errors, retries,
          pagination, time and availability helpers. It has no provider knowledge.
        </li>
        <li>
          <strong>Helpers</strong> live on their own entry points so they are only bundled when
          imported: <code>unibooking/oauth</code> for OAuth, <code>unibooking/webhooks</code> for
          webhook verifiers, and <code>unibooking/connections</code> for per-tenant connections.
        </li>
      </ul>

      <H2>Life of a request</H2>
      <ol>
        <li>
          Your code calls a method, for example <code>client.createBooking(input)</code>.
        </li>
        <li>
          The adapter validates the input first. A bad range or a missing required field fails as{' '}
          <code>INVALID_INPUT</code> before anything is sent.
        </li>
        <li>
          Credentials are resolved once for the call. With the function form (or{' '}
          <code>withAutoRefresh</code>), this is where an expiring token is refreshed and saved.
        </li>
        <li>
          The adapter builds the provider request and hands it to the HTTP layer, which adds
          authentication, applies the timeout (15 seconds by default) and sends it.
        </li>
        <li>
          A provider error becomes a <code>UnibookingError</code> with a stable code, the
          provider&apos;s own code, its request id and any <code>Retry-After</code>.
        </li>
        <li>
          A success is mapped back to canonical types: offset-bearing times, a known status, the ids
          that later calls accept, and the untouched original in <code>raw</code>.
        </li>
      </ol>

      <H2>Guarantees</H2>
      <H3>Stateless</H3>
      <p>
        The library stores nothing: no tokens, no bookings, no cache. It ships no credentials of its
        own. Persistence is always yours, through a callback (<code>onRefresh</code>) or an
        interface you implement (<code>ConnectionStore</code>).
      </p>
      <H3>Credentials stay on the provider&apos;s host</H3>
      <p>
        Every request is checked before authentication is added: its URL must be on the
        adapter&apos;s configured host. A page token or id that names another host is refused, so
        credentials can never be sent anywhere else. CalDAV is the one exception, because iCloud
        serves each account from its own partition host; its calendar changes are confined to the
        account&apos;s own calendar home.
      </p>
      <H3>Server-only code stays out of browsers</H3>
      <p>
        No adapter imports the OAuth or connections modules, which handle client secrets. A test
        checks that the package root has no path to them, so it is safe to bundle for a browser.
      </p>
      <H3>Honest capabilities</H3>
      <p>
        Every method beyond the core exists only when its capability flag is true, and a conformance
        test runs against every adapter to keep flags and methods in step. What a provider cannot do
        fails as <code>UNSUPPORTED</code> with a reason, never silently.
      </p>
      <H3>No surprise writes</H3>
      <p>
        <code>withRetry</code> never retries a create without an idempotency key. Versioned writes (
        <code>ifVersion</code>) fail with <code>CONFLICT</code> instead of overwriting a change. A
        reschedule that has to re-book reports both ids if its second step fails.
      </p>

      <H2>The explorer</H2>
      <p>
        This site is a Next.js app in <code>demo/</code> that links the library from the repository
        root. It has three parts: the Explorer, which runs every method against a provider; My
        Calendar, a complete sign-in and calendar flow; and these docs.
      </p>
      <H3>How explorer calls run</H3>
      <ul>
        <li>
          <strong>Sample Data</strong> runs in the browser against local storage. No network.
        </li>
        <li>
          <strong>Providers that accept browser calls</strong> (7) run the adapter in the browser.
          The pasted token goes straight to the provider and never reaches this site&apos;s server.
        </li>
        <li>
          <strong>Providers that block browser calls</strong> (10) are sent once to{' '}
          <code>POST /api/call</code>, which runs the same operation server-side and forgets the
          credentials.
        </li>
        <li>
          <strong>Signed in through My Calendar</strong> (Google, Outlook): calls go to{' '}
          <code>POST /api/calendar/explore</code>, which uses the sealed session cookie. The token
          never reaches the page.
        </li>
      </ul>
      <p>
        All four paths call one shared dispatcher (<code>lib/dispatch.ts</code>), so an operation
        behaves the same whichever way it runs.
      </p>

      <H3>API routes</H3>
      <table>
        <thead>
          <tr>
            <th>Route</th>
            <th>Used by</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          {ROUTES.map(([route, by, what]) => (
            <tr key={route}>
              <td>
                <code>{route}</code>
              </td>
              <td>{by}</td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <H3>Protections on every route</H3>
      <ul>
        <li>
          <strong>Same origin only.</strong> Every POST must come from this site, so no other site
          can use it as a relay.
        </li>
        <li>
          <strong>Allowlists.</strong> <code>/api/call</code> serves only the providers that block
          browser calls, and only known operations.
        </li>
        <li>
          <strong>SSRF guards.</strong> A custom base URL must be one the provider publishes, and an
          Apple calendar URL must be on iCloud; both require HTTPS.
        </li>
        <li>
          <strong>Rate limit.</strong> 20 requests a minute per IP, as cost control.
        </li>
        <li>
          <strong>Sealed sessions.</strong> My Calendar tokens are sealed with AES-256-GCM in an{' '}
          <code>HttpOnly</code>, <code>SameSite=Lax</code> cookie scoped to{' '}
          <code>/api/calendar</code>. The server keeps no database.
        </li>
        <li>
          <strong>Nothing logged.</strong> Credentials are never logged or stored on the server. The
          browser keeps pasted credentials only while <em>Remember</em> is on.
        </li>
      </ul>

      <H2>Quality gates</H2>
      <p>Every change has to pass, for the library and the explorer separately:</p>
      <Code lang="bash">{`
# Library (repository root)
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build

# Explorer (demo/), after building the library
npx tsc --noEmit && npm run lint && npm test && npm run build
`}</Code>
      <Callout type="note" title="What the tests prove, and what they cannot">
        Adapter tests run against recorded provider responses with the network disabled. They pin
        the canonical shapes, errors and paging, but cannot prove a provider accepts each request.
        See <Link href="/docs/guides/production">Going to production</Link> for which adapters to
        validate on a real account first.
      </Callout>
    </DocPage>
  );
}
