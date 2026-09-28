import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import Link from 'next/link';
import { Callout, Card, Cards, Code, DocPage, H2 } from './_components/Doc';
import { BookIcon, PlugIcon, ShieldIcon, TerminalIcon } from '../components/icons';
import { PROVIDER_GUIDES, PROVIDER_ORDER } from '@/lib/docs/provider-guides';

export const metadata: Metadata = docMetadata({
  title: 'Introduction',
  description: 'One TypeScript API for 17 booking and calendar providers.',
  href: '/docs',
});

const calendars = PROVIDER_ORDER.filter((id) => PROVIDER_GUIDES[id].kind === 'calendar');
const platforms = PROVIDER_ORDER.filter(
  (id) => PROVIDER_GUIDES[id].kind === 'booking' && PROVIDER_GUIDES[id].maturity !== 'planned',
);

/** Structured data: tells search engines this is a software library, with
 *  its repository and package. `<` is escaped so no string can close the tag. */
const JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'SoftwareSourceCode',
  name: 'unibooking',
  description: 'One TypeScript API for 17 booking and calendar providers.',
  codeRepository: 'https://github.com/djlahre0/unibooking',
  programmingLanguage: 'TypeScript',
  runtimePlatform: 'Node.js',
  license: 'https://opensource.org/licenses/MIT',
  url: 'https://www.npmjs.com/package/unibooking',
}).replace(/</g, '\\u003c');

export default function Introduction() {
  return (
    <DocPage
      href="/docs"
      title="Introduction"
      lead="unibooking is one TypeScript API for booking and calendar providers. Write your integration once against a single client, and switch providers by changing one import."
    >
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON_LD }} />
      <Code title="The same call, any provider">{`
import { google } from 'unibooking/adapters/google';
import { square } from 'unibooking/adapters/square';

const calendar = google({ accessToken });
const salon = square({ accessToken, locationId });

// Identical method, identical result shape.
const { bookings } = await salon.listBookings({ range });
`}</Code>

      <H2>Start here</H2>
      <Cards>
        <Card href="/docs/quickstart" title="Quickstart" icon={<TerminalIcon size={18} />}>
          Install the package and make your first call in five minutes.
        </Card>
        <Card href="/docs/providers" title="Set up a provider" icon={<PlugIcon size={18} />}>
          What each provider needs, where to get it, and what to know.
        </Card>
        <Card href="/docs/reference/client" title="API reference" icon={<BookIcon size={18} />}>
          Every method on a client, with its inputs and results.
        </Card>
        <Card
          href="/docs/guides/production"
          title="Production checklist"
          icon={<ShieldIcon size={18} />}
        >
          The list to work through before real customers depend on it.
        </Card>
      </Cards>

      <H2>What you get</H2>
      <ul>
        <li>
          <strong>One booking model.</strong> A <code>Booking</code> has the same fields whichever
          provider it came from, with times as offset-bearing instants and a known status.
        </li>
        <li>
          <strong>One error type.</strong> Every failure is a <code>UnibookingError</code> with one
          of ten codes, so you branch on <code>AUTH</code> or <code>RATE_LIMIT</code> instead of on
          seventeen error formats.
        </li>
        <li>
          <strong>Capability flags.</strong> Each client says what its provider can do, so your UI
          can hide what is not there instead of failing at runtime.
        </li>
        <li>
          <strong>Helpers you would otherwise write yourself:</strong> retries with backoff,
          pagination, OAuth with automatic refresh, webhook signature verification, and slot
          computation from busy time.
        </li>
        <li>
          <strong>No runtime dependencies.</strong> It runs anywhere with <code>fetch</code> and Web
          Crypto: Node 20+, Bun, Deno and edge runtimes.
        </li>
      </ul>

      <H2>What it is not</H2>
      <p>
        unibooking is <strong>stateless</strong>. It stores nothing, no tokens, no bookings, no
        cache, and it ships no credentials of its own. Your application owns the database, the OAuth
        apps and the keys; unibooking is the layer that talks to each provider in one consistent
        shape. It is also not a scheduling engine: it reads and writes the provider&apos;s own
        bookings, and the provider remains the source of truth.
      </p>

      <H2>Supported providers</H2>
      <p>
        <strong>Calendars:</strong>{' '}
        {calendars.map((id, i) => (
          <span key={id}>
            {i > 0 && ', '}
            <Link href={`/docs/providers/${id}`}>{PROVIDER_GUIDES[id].name}</Link>
          </span>
        ))}
        .
      </p>
      <p>
        <strong>Booking platforms:</strong>{' '}
        {platforms.map((id, i) => (
          <span key={id}>
            {i > 0 && ', '}
            <Link href={`/docs/providers/${id}`}>{PROVIDER_GUIDES[id].name}</Link>
          </span>
        ))}
        . Mangomint is planned.
      </p>
      <Callout type="tip" title="Try it without writing code">
        The <Link href="/">Explorer</Link> runs every method of every provider in your browser. Pick{' '}
        <strong>Sample Data</strong> to try it with no account at all.
      </Callout>

      <H2>How these docs are organised</H2>
      <ul>
        <li>
          <strong>Get started</strong> takes you from install to a working call.
        </li>
        <li>
          <strong>Core concepts</strong> explains the model every provider is mapped onto: clients,
          capabilities, time, errors and pagination.
        </li>
        <li>
          <strong>Guides</strong> are task-oriented: connecting providers, OAuth, many tenants,
          webhooks, retries and going to production.
        </li>
        <li>
          <strong>Reference</strong> lists every method and capability flag.
        </li>
        <li>
          <strong>Providers</strong> has one setup page per provider.
        </li>
      </ul>
    </DocPage>
  );
}
