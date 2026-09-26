import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import Link from 'next/link';
import { Callout, Card, Cards, Code, DocPage, H2, Step, Steps } from '../_components/Doc';

export const metadata: Metadata = docMetadata({
  title: 'Quickstart',
  description: 'Install unibooking and make your first call in five minutes.',
  href: '/docs/quickstart',
});

export default function Quickstart() {
  return (
    <DocPage
      href="/docs/quickstart"
      title="Quickstart"
      lead="Install the package, connect one provider, and list, create and cancel a booking. This page uses Google Calendar; every other provider works the same way."
    >
      <H2>Before you begin</H2>
      <ul>
        <li>Node.js 20 or later (or Bun, Deno, or an edge runtime with fetch).</li>
        <li>
          An access token for one provider. For Google, the{' '}
          <Link href="/docs/providers/google">Google setup guide</Link> shows how to get one; to
          experiment first, the{' '}
          <a href="https://developers.google.com/oauthplayground" target="_blank" rel="noreferrer">
            OAuth 2.0 Playground
          </a>{' '}
          issues a short-lived token for the Calendar API.
        </li>
      </ul>

      <H2>Steps</H2>
      <Steps>
        <Step title="Install">
          <Code lang="bash">{`npm install unibooking`}</Code>
          <p>unibooking has no runtime dependencies and ships ESM and CommonJS builds.</p>
        </Step>

        <Step title="Create a client">
          <p>
            Import only the adapter you need. Each adapter is a function: call it with credentials
            and it returns a <code>BookingClient</code>.
          </p>
          <Code title="client.ts">{`
import { google } from 'unibooking/adapters/google';

export const client = google({
  accessToken: process.env.GOOGLE_ACCESS_TOKEN!,
});
`}</Code>
        </Step>

        <Step title="Check the connection">
          <p>
            <code>checkConnection()</code> proves the credentials work. A dead connection is an
            answer, not an exception, so it is returned; network faults still throw.
          </p>
          <Code>{`
const status = await client.checkConnection();
if (!status.ok) {
  console.error('Reconnect needed:', status.reason); // 'AUTH' | 'FORBIDDEN' | 'NOT_FOUND'
}
`}</Code>
        </Step>

        <Step title="List bookings">
          <p>
            Ranges are RFC 3339 instants <strong>with an offset</strong>. <code>timezone</code> is
            for display only and never changes which instant is meant.
          </p>
          <Code>{`
const { bookings, nextPageToken } = await client.listBookings({
  range: {
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-08T00:00:00Z',
    timezone: 'Europe/London',
  },
});

for (const b of bookings) {
  console.log(b.id, b.title, b.range.start, b.status);
}
`}</Code>
        </Step>

        <Step title="Create, then cancel">
          <Code>{`
const booking = await client.createBooking({
  title: 'Consultation',
  range: { start: '2026-10-02T14:00:00+01:00', end: '2026-10-02T14:30:00+01:00' },
  customer: { name: 'Ana Silva', email: 'ana@example.com' },
  notify: false,
});

await client.cancelBooking(booking.id);
`}</Code>
        </Step>

        <Step title="Handle errors">
          <p>
            Every failure is a <code>UnibookingError</code> with a stable <code>code</code>.
          </p>
          <Code>{`
import { isUnibookingError } from 'unibooking';

try {
  await client.getBooking('missing-id');
} catch (e) {
  if (isUnibookingError(e) && e.code === 'NOT_FOUND') {
    // show "this booking no longer exists"
  } else {
    throw e;
  }
}
`}</Code>
        </Step>
      </Steps>

      <Callout type="tip" title="Switching providers">
        To use Square instead, change the import to <code>unibooking/adapters/square</code> and pass
        its credentials (<code>accessToken</code>, <code>locationId</code>). The calls above stay
        the same. Booking platforms usually also need a <code>serviceId</code> and{' '}
        <code>staffId</code> to create a booking: see each provider&apos;s page.
      </Callout>

      <H2>Next steps</H2>
      <Cards>
        <Card href="/docs/guides/oauth" title="Add OAuth">
          Let your users connect their own accounts, with automatic token refresh.
        </Card>
        <Card href="/docs/concepts/capabilities" title="Check capabilities">
          Find out what each provider supports before you call it.
        </Card>
        <Card href="/docs/guides/retries" title="Make it resilient">
          Retry transient failures without double-booking.
        </Card>
        <Card href="/?provider=sample&tab=bookings" title="Try it in the Explorer">
          Run these calls against sample data, no account needed.
        </Card>
      </Cards>
    </DocPage>
  );
}
