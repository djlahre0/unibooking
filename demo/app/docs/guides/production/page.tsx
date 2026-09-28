import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import Link from 'next/link';
import { Callout, DocPage, H2 } from '../../_components/Doc';
import { PROVIDER_GUIDES, PROVIDER_ORDER } from '@/lib/docs/provider-guides';

export const metadata: Metadata = docMetadata({
  title: 'Going to production',
  description: 'The checklist to work through before real customers depend on it.',
  href: '/docs/guides/production',
});

const established = PROVIDER_ORDER.filter((id) => PROVIDER_GUIDES[id].maturity === 'established');
const validate = PROVIDER_ORDER.filter((id) => PROVIDER_GUIDES[id].maturity === 'validate');

function Check({ children }: { children: React.ReactNode }) {
  return <li className="doc-check">{children}</li>;
}

export default function Production() {
  return (
    <DocPage
      href="/docs/guides/production"
      title="Going to production"
      lead="Work through this list before customers depend on your integration. Each item names the failure it prevents."
    >
      <H2>Validate each provider on a real account</H2>
      <p>
        Every adapter passes a shared conformance suite against mocked HTTP. That proves the
        canonical shapes, errors and paging: it cannot prove the provider accepts the requests.{' '}
        <strong>No adapter has been verified against a live tenant</strong>, so run your own flows
        against a real (or sandbox) account first.
      </p>
      <ul className="doc-checklist">
        <Check>
          <strong>Best exercised:</strong>{' '}
          {established.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <Link href={`/docs/providers/${id}`}>{PROVIDER_GUIDES[id].name}</Link>
            </span>
          ))}
          .
        </Check>
        <Check>
          <strong>Built from published specs: validate before relying on them:</strong>{' '}
          {validate.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <Link href={`/docs/providers/${id}`}>{PROVIDER_GUIDES[id].name}</Link>
            </span>
          ))}
          .
        </Check>
        <Check>Read the &ldquo;Before production&rdquo; notes on each provider page you use.</Check>
      </ul>

      <H2>Credentials</H2>
      <ul className="doc-checklist">
        <Check>
          Store tokens and keys <strong>encrypted at rest</strong> (KMS, or <code>node:crypto</code>{' '}
          with a key from your environment). They are live credentials.
        </Check>
        <Check>
          Keep <code>unibooking/oauth</code> and <code>unibooking/connections</code> in server code
          only; both handle client secrets.
        </Check>
        <Check>
          Mask secret fields in forms and never log them: <code>isSecretField()</code> tells you
          which ones they are.
        </Check>
        <Check>
          Persist every refreshed token before using it (<code>withAutoRefresh</code> and{' '}
          <code>connectionFor</code> do this). Otherwise a rotated refresh token is lost for good.
        </Check>
        <Check>
          If several servers can refresh the same grant, serialise refreshes (a row lock): some
          providers reject the second use of a refresh token.
        </Check>
      </ul>

      <H2>OAuth apps</H2>
      <ul className="doc-checklist">
        <Check>Register your production redirect URIs, not just localhost.</Check>
        <Check>
          Compare <code>state</code> on every callback, and use PKCE (<code>pkce: true</code>).
        </Check>
        <Check>
          Google: the <code>calendar</code> scope is sensitive, so complete Google&apos;s app
          verification before opening sign-in to the public.
        </Check>
        <Check>
          Square: request <code>SQUARE_WRITE_SCOPES</code> up front if you will write the catalog;
          adding a scope later means every merchant must consent again.
        </Check>
      </ul>

      <H2>Reliability</H2>
      <ul className="doc-checklist">
        <Check>
          Wrap clients with <Link href="/docs/guides/retries">withRetry</Link> and set a{' '}
          <code>timeoutMs</code> that fits your request budget (default 15 seconds).
        </Check>
        <Check>
          Pass an <code>idempotencyKey</code> derived from your own record on every create where the
          provider supports it.
        </Check>
        <Check>
          Never assume one page: use <Link href="/docs/concepts/pagination">listAll</Link> with a
          sensible <code>maxPages</code>.
        </Check>
        <Check>
          Check <code>capabilities</code> before calling optional methods, and show{' '}
          <code>UNSUPPORTED</code> messages to users: they say what is missing and why.
        </Check>
      </ul>

      <H2>Webhooks and sync</H2>
      <ul className="doc-checklist">
        <Check>
          Verify signatures against the <strong>raw</strong> body, with a replay window where the
          provider signs a timestamp.
        </Check>
        <Check>Answer quickly (2xx) and process in a queue; providers retry slow endpoints.</Check>
        <Check>
          Renew watches before <code>expiresAt</code>, and handle <code>fullSyncRequired</code> by
          resyncing from scratch.
        </Check>
        <Check>Boulevard: never answer 410: it unsubscribes your endpoint.</Check>
      </ul>

      <H2>Monitoring</H2>
      <ul className="doc-checklist">
        <Check>
          Run <code>checkConnection()</code> on a schedule. <code>ok: false</code> means reconnect;
          a thrown error is a transient fault, never disconnect on one.
        </Check>
        <Check>
          Log <code>error.code</code>, <code>provider</code>, <code>httpStatus</code> and{' '}
          <code>requestId</code>; the request id is what provider support will ask for.
        </Check>
        <Check>
          Alert on sustained <code>RATE_LIMIT</code> and <code>UPSTREAM</code> rates per provider.
        </Check>
      </ul>

      <Callout type="note" title="Known limitations">
        A few provider limits cannot be hidden: Acuity lists at most one page of appointments,
        Zenoti cancels a whole invoice, Vagaro lists only per customer. Each provider page lists its
        own.
      </Callout>
    </DocPage>
  );
}
