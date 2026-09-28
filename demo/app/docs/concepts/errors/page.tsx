import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import { Callout, Code, DocPage, H2 } from '../../_components/Doc';

export const metadata: Metadata = docMetadata({
  title: 'Errors',
  description: 'One error type with ten codes, whatever the provider said.',
  href: '/docs/concepts/errors',
});

const CODES: Array<[string, string, string, boolean]> = [
  ['AUTH', '401', 'Credentials missing, invalid, expired or revoked.', false],
  ['FORBIDDEN', '403', 'Authenticated, but not allowed (scope, plan or permission).', false],
  ['NOT_FOUND', '404 / 410', 'The booking or resource does not exist.', false],
  ['CONFLICT', '409 / 412', 'Slot taken, duplicate, or a version (ETag) mismatch.', false],
  ['RATE_LIMIT', '429', 'Throttled. `retryAfterMs` says how long to wait.', true],
  ['INVALID_INPUT', '400 / 422', 'The request was malformed, or rejected before sending.', false],
  ['UNSUPPORTED', '-', 'The provider (or its plan) cannot do this.', false],
  ['UPSTREAM', '5xx', 'Provider failure, or a response the adapter could not read.', true],
  ['NETWORK', '-', 'The request never completed (DNS, connection).', true],
  ['TIMEOUT', '-', 'No answer within `timeoutMs`.', true],
];

export default function Errors() {
  return (
    <DocPage
      href="/docs/concepts/errors"
      title="Errors"
      lead="Adapters never throw a raw provider exception. Every failure is a UnibookingError with one of ten codes, so your handling is written once."
    >
      <H2>The error</H2>
      <Code>{`
class UnibookingError extends Error {
  provider: ProviderId;   // which adapter threw
  code: ErrorCode;        // one of the ten below
  httpStatus?: number;    // when it came from an HTTP response
  providerCode?: string;  // the provider's own code, for debugging
  retryAfterMs?: number;  // on RATE_LIMIT, from Retry-After
  requestId?: string;     // the provider's request id, for support tickets
}
`}</Code>

      <H2>Codes</H2>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Usually</th>
            <th>Meaning</th>
            <th>Retryable</th>
          </tr>
        </thead>
        <tbody>
          {CODES.map(([code, status, meaning, retry]) => (
            <tr key={code}>
              <td>
                <code>{code}</code>
              </td>
              <td>{status}</td>
              <td>{meaning.replace(/`/g, '')}</td>
              <td>{retry ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <H2>Handling errors</H2>
      <Code>{`
import { isUnibookingError, isRetryable } from 'unibooking';

try {
  await client.createBooking(input);
} catch (e) {
  if (!isUnibookingError(e)) throw e;
  switch (e.code) {
    case 'CONFLICT':
      return showMessage('That time was just taken. Pick another slot.');
    case 'AUTH':
    case 'FORBIDDEN':
      return askToReconnect(e.provider);
    case 'UNSUPPORTED':
      return showMessage(e.message); // says what is missing and why
    default:
      if (isRetryable(e.code)) return retryLater();
      throw e;
  }
}
`}</Code>

      <H2>Validation happens first</H2>
      <p>
        Inputs are checked before any request is sent: a range without an offset, an end before its
        start, a missing required field. These fail as <code>INVALID_INPUT</code> with a message
        that names the field, so a mistake never costs a round trip or leaves a half-written
        booking.
      </p>

      <H2>Status codes that lie</H2>
      <p>
        Some provider statuses are misleading, and the adapters correct them. Square answers a
        merchant without an Appointments plan with <code>401</code>, which would read as a revoked
        grant; the adapter reports <code>UNSUPPORTED</code> with the remedy instead. Boulevard
        returns GraphQL errors with <code>200</code>; they are classified by their code.
      </p>
      <Callout type="note" title="Secrets never appear in messages">
        Error messages carry the provider&apos;s explanation, never the request body or credentials,
        so they are safe to log.
      </Callout>
    </DocPage>
  );
}
