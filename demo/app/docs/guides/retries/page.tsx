import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import { Callout, Code, DocPage, H2 } from '../../_components/Doc';

export const metadata: Metadata = docMetadata({
  title: 'Retries & idempotency',
  description: 'Retry transient failures without double-booking anyone.',
  href: '/docs/guides/retries',
});

export default function Retries() {
  return (
    <DocPage
      href="/docs/guides/retries"
      title="Retries & idempotency"
      lead="withRetry wraps a client so transient failures retry with exponential backoff, and refuses to retry anything that could create a duplicate."
    >
      <H2>Wrap the client</H2>
      <Code>{`
import { withRetry } from 'unibooking';

const client = withRetry(square(creds), {
  retries: 3,        // after the first attempt (default 3)
  baseDelayMs: 200,  // default 200, doubled each time
  maxDelayMs: 10_000 // ceiling, also applied to Retry-After (default 10000)
});
`}</Code>
      <p>
        It retries <code>RATE_LIMIT</code>, <code>UPSTREAM</code>, <code>NETWORK</code> and{' '}
        <code>TIMEOUT</code>, with jitter, and waits for a server&apos;s <code>Retry-After</code>{' '}
        when one is sent. Everything else (<code>AUTH</code>, <code>CONFLICT</code>,{' '}
        <code>INVALID_INPUT</code>) fails immediately, because a retry cannot fix it.
      </p>

      <H2>What is never retried</H2>
      <p>
        A request can succeed at the provider and still fail on the way back. Retrying a create then
        makes a second booking. So these are not retried automatically:
      </p>
      <ul>
        <li>
          <code>createBooking</code> and <code>enrollInClass</code>, unless you pass an{' '}
          <code>idempotencyKey</code>.
        </li>
        <li>
          <code>createService</code>, <code>createStaff</code>, <code>customers.create</code> and{' '}
          <code>customers.findOrCreate</code>.
        </li>
        <li>
          <code>createCalendar</code>, <code>watchBookings</code> and <code>renewWatch</code>.
        </li>
      </ul>

      <H2>Idempotency keys</H2>
      <p>
        Where the provider supports them (<code>capabilities.idempotency</code>: Square, Outlook,
        Apple), an <code>idempotencyKey</code> stops a repeated create from making a duplicate:
        Square and Outlook recognise the key, and Apple uses it as the event UID, so a repeat fails
        with <code>CONFLICT</code>. That is what makes a create safe to retry:
      </p>
      <Code>{`
const key = \`booking-\${orderId}\`; // stable for this one intended booking

await client.createBooking({
  title: 'Haircut',
  range,
  serviceId,
  staffId,
  idempotencyKey: key,
});
`}</Code>
      <p>
        Derive the key from your own record (an order or request id), not from a random value per
        attempt: a new key on every retry defeats the point.
      </p>
      <Callout type="warning" title="Reschedules that re-book">
        Calendly has no reschedule endpoint, so a new time books first and then cancels the old
        event. If the cancel fails, you get a <code>CONFLICT</code> naming both ids instead of a
        retryable error, so the reschedule is never run twice.
      </Callout>
    </DocPage>
  );
}
