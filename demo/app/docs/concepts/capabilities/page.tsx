import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import Link from 'next/link';
import { Callout, Code, DocPage, H2 } from '../../_components/Doc';

export const metadata: Metadata = docMetadata({
  title: 'Clients & capabilities',
  description: 'One client per provider, and flags that say what each one can do.',
  href: '/docs/concepts/capabilities',
});

export default function Capabilities() {
  return (
    <DocPage
      href="/docs/concepts/capabilities"
      title="Clients & capabilities"
      lead="Every adapter returns the same BookingClient. Providers differ in what they can do, and each client says so up front through its capability flags."
    >
      <H2>The client</H2>
      <p>
        An adapter is a function. Call it with credentials and you get a <code>BookingClient</code>{' '}
        with the core methods every provider has:
      </p>
      <ul>
        <li>
          <code>createBooking</code>, <code>getBooking</code>, <code>updateBooking</code>,{' '}
          <code>cancelBooking</code>, <code>listBookings</code>
        </li>
        <li>
          <code>searchAvailability</code> (throws <code>UNSUPPORTED</code> where there is none)
        </li>
        <li>
          <code>checkConnection</code>
        </li>
      </ul>
      <p>
        Everything else, services, staff, customers, calendars, classes, change sync, is{' '}
        <strong>optional</strong>. A method exists on the client only when the provider supports it,
        and TypeScript marks it optional so you cannot call it without checking.
      </p>

      <H2>Checking a capability</H2>
      <Code>{`
if (client.capabilities.serviceCatalog) {
  const { services } = await client.listServices!();
}

// Or check the method itself: the two always agree.
if (client.listCalendars) {
  const { calendars } = await client.listCalendars();
}
`}</Code>
      <p>
        Flags and methods are kept in step by a conformance test that runs against every adapter: a
        flag is <code>true</code> exactly when its methods are present. See{' '}
        <Link href="/docs/reference/capabilities">Capability flags</Link> for every flag and which
        providers set it.
      </p>

      <H2>Picking an adapter at runtime</H2>
      <p>
        When the provider comes from data (a SaaS where each business connects its own), register
        the adapters you use and look one up by id:
      </p>
      <Code>{`
import { createRegistry } from 'unibooking';
import { google } from 'unibooking/adapters/google';
import { square } from 'unibooking/adapters/square';

const registry = createRegistry([google, square]);

const adapter = registry.get(account.provider); // 'google' | 'square'
const client = adapter(account.credentials);
`}</Code>
      <p>
        Registration is explicit, so there are no import side effects and your bundle holds only the
        adapters you imported. For many tenants with stored credentials, prefer{' '}
        <Link href="/docs/guides/multi-tenant">connectionFor</Link>, which also handles OAuth
        refresh.
      </p>

      <H2>Provider-specific data</H2>
      <p>
        The canonical types hold only what makes sense across providers. Everything else is kept:
      </p>
      <ul>
        <li>
          <strong>
            <code>raw</code>
          </strong>{' '}
          on every result holds the provider&apos;s original object, untouched.
        </li>
        <li>
          <strong>
            <code>providerOptions</code>
          </strong>{' '}
          on every write is merged into the outgoing request, for fields that have no canonical
          equivalent: Square&apos;s <code>service_variation_version</code>, Bookeo&apos;s{' '}
          <code>participants</code>.
        </li>
      </ul>
      <Callout type="note">
        <code>providerOptions</code> is merged last, so it can override what the adapter built. Each
        provider page names the keys that provider reads.
      </Callout>
    </DocPage>
  );
}
