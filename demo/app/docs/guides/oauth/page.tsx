import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import Link from 'next/link';
import { Callout, Code, DocPage, H2, Step, Steps } from '../../_components/Doc';

export const metadata: Metadata = docMetadata({
  title: 'OAuth & token refresh',
  description: 'Send users to consent, exchange the code, and keep tokens fresh.',
  href: '/docs/guides/oauth',
});

const HELPERS: Array<[string, string, string, string]> = [
  ['Google Calendar', 'googleOAuth', 'unibooking/oauth/google', 'Always requests offline access.'],
  ['Outlook', 'outlookOAuth', 'unibooking/oauth/microsoft', 'Pass `tenant` to restrict sign-in.'],
  ['Microsoft Bookings', 'microsoftBookingsOAuth', 'unibooking/oauth/microsoft', ''],
  [
    'Square',
    'squareOAuth',
    'unibooking/oauth/square',
    'Add SQUARE_WRITE_SCOPES for catalog writes.',
  ],
  ['Acuity', 'acuityOAuth', 'unibooking/oauth/acuity', ''],
  ['Calendly', 'calendlyOAuth', 'unibooking/oauth/calendly', 'Rotates refresh tokens.'],
  [
    'Wix',
    'wixOAuth',
    'unibooking/oauth/wix',
    'Exchange the install instanceId; no authorize step.',
  ],
  ['Setmore', 'setmoreOAuth', 'unibooking/oauth/setmore', 'Refresh only.'],
];

export default function OAuth() {
  return (
    <DocPage
      href="/docs/guides/oauth"
      title="OAuth & token refresh"
      lead="The OAuth helpers run the authorization-code flow and refresh tokens. They are stateless: they return tokens, and storing them is yours."
    >
      <Callout type="warning" title="Server only">
        Every OAuth client takes your client secret. Import <code>unibooking/oauth/*</code> only in
        server code, never in a browser bundle.
      </Callout>

      <H2>Register your app first</H2>
      <p>
        unibooking ships no client ids or secrets. Register your own app with each provider and read
        the id, secret and redirect URI from your environment. The{' '}
        <Link href="/docs/providers">provider pages</Link> walk through each registration.
      </p>

      <H2>The flow</H2>
      <Steps>
        <Step title="Create the OAuth client">
          <Code>{`
import { googleOAuth } from 'unibooking/oauth/google';

const oauth = googleOAuth({
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: 'https://app.example.com/oauth/google/callback',
});
`}</Code>
        </Step>
        <Step title="Send the user to consent">
          <p>
            Store the returned <code>state</code> (and <code>codeVerifier</code> with PKCE) against
            the user&apos;s session before redirecting.
          </p>
          <Code>{`
const { url, state, codeVerifier } = await oauth.authorizationUrl({ pkce: true });
await session.save({ oauthState: state, codeVerifier });
return redirect(url);
`}</Code>
        </Step>
        <Step title="Handle the callback">
          <p>
            Compare <code>state</code> before anything else, it is your CSRF protection, then
            exchange the code.
          </p>
          <Code>{`
const params = new URL(request.url).searchParams;
if (params.get('state') !== session.oauthState) throw new Error('state mismatch');

const tokens = await oauth.exchangeCode(params.get('code')!, {
  codeVerifier: session.codeVerifier,
});
await db.saveTokens(userId, 'google', tokens);
// { accessToken, refreshToken?, expiresAt?, scope?, raw }
`}</Code>
        </Step>
        <Step title="Use the tokens, refreshing as needed">
          <Code>{`
import { withAutoRefresh } from 'unibooking/oauth';
import { google } from 'unibooking/adapters/google';

const client = google(
  withAutoRefresh({
    oauth,
    tokens: await db.loadTokens(userId, 'google'),
    onRefresh: (next) => db.saveTokens(userId, 'google', next),
    toCreds: (t) => ({ accessToken: t.accessToken }),
  }),
);
`}</Code>
        </Step>
      </Steps>

      <H2>How refresh behaves</H2>
      <ul>
        <li>
          Tokens are refreshed 60 seconds before <code>expiresAt</code> (<code>skewMs</code>), just
          before a request.
        </li>
        <li>
          <code>onRefresh</code> runs <strong>before</strong> the new token is used. If your
          database write throws, the request stops: continuing would lose a rotated refresh token
          for good.
        </li>
        <li>
          Parallel requests on one client share one refresh. Separate clients for the same grant
          (one per request, one per server) refresh independently: if the provider rotates refresh
          tokens (Calendly does), serialise refreshes with a row lock.
        </li>
        <li>
          A revoked grant (<code>invalid_grant</code> and similar) fails as <code>AUTH</code>: ask
          the user to reconnect. Token requests time out after 15 seconds.
        </li>
      </ul>

      <H2>Helpers by provider</H2>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Helper</th>
            <th>Import</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {HELPERS.map(([name, fn, mod, note]) => (
            <tr key={fn}>
              <td>{name}</td>
              <td>
                <code>{fn}</code>
              </td>
              <td>
                <code>{mod}</code>
              </td>
              <td>{note.replace(/`/g, '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Providers without a helper use API keys or passwords (Apple, Bookeo, Mindbody, Phorest,
        Zenoti, Boulevard) or a client-credentials token you mint yourself (Booker, Vagaro).
      </p>
    </DocPage>
  );
}
