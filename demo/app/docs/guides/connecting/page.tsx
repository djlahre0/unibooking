import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import Link from 'next/link';
import { Callout, Code, DocPage, H2, H3 } from '../../_components/Doc';

export const metadata: Metadata = docMetadata({
  title: 'Connecting a provider',
  description: 'Collect the right credentials and prove they work.',
  href: '/docs/guides/connecting',
});

export default function Connecting() {
  return (
    <DocPage
      href="/docs/guides/connecting"
      title="Connecting a provider"
      lead="Connecting is three steps: know which fields the provider needs, collect them from the account owner (or through OAuth), and prove they work before you save them."
    >
      <H2>1. Know what the provider needs</H2>
      <p>
        The credential schema is exported as data, so your connect form never hard-codes a field
        list. It says which fields are required, which are secret, and where each value comes from:
      </p>
      <Code>{`
import { PROVIDER_CREDENTIALS, requiredCredentials, isSecretField } from 'unibooking';

requiredCredentials('square');
// → [{ key: 'accessToken', label: 'Access Token', secret: true, required: true, help: '…' },
//    { key: 'locationId',  label: 'Location ID',  secret: false, required: true, … }]

isSecretField('square', 'accessToken'); // true: mask it, never log it
`}</Code>
      <p>
        A provider with more than one way to authenticate lists several credential sets. Acuity is
        the example: an API key pair <em>or</em> an OAuth token. <code>matchCredentialSet</code>{' '}
        tells you which set a filled-in form satisfies.
      </p>
      <p>
        The schema is safe in a browser (it holds field names, never values), so the same data can
        render your form client-side. Each <Link href="/docs/providers">provider page</Link> shows
        its fields and where to find them.
      </p>

      <H2>2. Collect the credentials</H2>
      <H3>API keys and passwords</H3>
      <p>
        For providers such as Square (personal access token), Acuity, Bookeo, Mindbody or Apple, the
        account owner copies values from the provider&apos;s dashboard into your form. Send them to
        your server over HTTPS and store them encrypted.
      </p>
      <H3>OAuth</H3>
      <p>
        For Google, Microsoft, Square, Acuity, Calendly and Wix, send the user through consent
        instead of asking for a token. See{' '}
        <Link href="/docs/guides/oauth">OAuth &amp; token refresh</Link>.
      </p>

      <H2>3. Prove they work</H2>
      <p>
        Call <code>checkConnection()</code> before saving. It makes the cheapest authenticated
        request the provider offers and reports the account it reached:
      </p>
      <Code>{`
const client = square({ accessToken, locationId });
const status = await client.checkConnection();

if (status.ok) {
  await db.saveConnection(tenantId, 'square', { accessToken, locationId });
  console.log('Connected to', status.account?.name);
} else {
  // 'AUTH' | 'FORBIDDEN' | 'NOT_FOUND': the credentials do not work
  showError(status.message);
}
`}</Code>
      <Callout type="note" title="Dead connections are answers, faults are exceptions">
        A revoked token is the expected answer to &ldquo;does this work?&rdquo;, so it is returned
        as <code>ok: false</code>. A network blip, timeout, rate limit or 5xx throws instead, so a
        transient failure can never be mistaken for a revoked integration and disconnect a healthy
        one.
      </Callout>

      <H2>Credentials that change</H2>
      <p>
        Instead of an object, pass a function. It is called before every request, which is how
        short-lived tokens are kept fresh without a race:
      </p>
      <Code>{`
const client = vagaro(async () => ({
  region: 'us04',
  businessId,
  accessToken: await tokens.getFreshVagaroToken(), // mint when older than an hour
}));
`}</Code>
      <p>
        For OAuth providers, <code>withAutoRefresh</code> builds that function for you.
      </p>
    </DocPage>
  );
}
