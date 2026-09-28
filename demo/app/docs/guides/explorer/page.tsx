import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import Link from 'next/link';
import { Callout, Code, DocPage, H2, H3, Step, Steps } from '../../_components/Doc';

export const metadata: Metadata = docMetadata({
  title: 'Running the explorer',
  description: 'Run and deploy this site, including one-click calendar sign-in.',
  href: '/docs/guides/explorer',
});

const ENV: Array<[string, string]> = [
  ['GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET', 'One-click Google sign-in in My Calendar.'],
  [
    'MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT',
    'One-click Microsoft sign-in. MICROSOFT_TENANT defaults to common.',
  ],
  ['SESSION_SECRET', 'Cookie-sealing key (32+ characters). Required on serverless hosts.'],
  ['APP_URL', 'The public origin, when a proxy hides the real request host.'],
];

export default function Explorer() {
  return (
    <DocPage
      href="/docs/guides/explorer"
      title="Running the explorer"
      lead="The explorer is this site: a Next.js app that runs every unibooking method against real providers, or against built-in sample data. It needs no environment variables to start."
    >
      <H2>Run it locally</H2>
      <Steps>
        <Step title="Build the library">
          <p>The explorer links the package from the repository root, so build that first.</p>
          <Code lang="bash">{`
git clone https://github.com/djlahre0/unibooking.git
cd unibooking
npm ci && npm run build
`}</Code>
        </Step>
        <Step title="Start the explorer">
          <Code lang="bash">{`
cd demo
npm ci
npm run dev
`}</Code>
          <p>
            Open <code>http://localhost:3000</code>. Pick <strong>Sample Data</strong> in the
            sidebar to try every section without an account.
          </p>
        </Step>
      </Steps>

      <H2>How requests run</H2>
      <p>The sidebar groups providers by where their requests go:</p>
      <ul>
        <li>
          <strong>On this device</strong> - Sample Data lives in your browser&apos;s storage. No
          network.
        </li>
        <li>
          <strong>In your browser:</strong> providers that accept cross-origin calls. Your token
          goes straight to the provider and never touches the explorer&apos;s server.
        </li>
        <li>
          <strong>Via the demo server:</strong> providers that block browser calls. Requests go
          through <code>/api/call</code>, which is same-origin only, allow-listed to those
          providers, rate limited, and never logs or stores credentials.
        </li>
      </ul>
      <p>
        Credentials you paste are kept in your browser only when <strong>Remember</strong> is on,
        and can be cleared from the Connect section at any time.
      </p>

      <H2>My Calendar sign-in</H2>
      <p>
        My Calendar lets a visitor sign in with Google, Microsoft or iCloud. Apple needs nothing
        from you, each visitor uses their own app-specific password. For Google and Microsoft, you
        (the operator) register one OAuth app per provider, once.
      </p>
      <H3>Configure it from the page</H3>
      <p>
        Visiting from <code>localhost</code>, an unconfigured provider shows a setup form with the
        exact redirect URL to register. Save the client id and secret there; they are written to the
        git-ignored <code>demo/.oauth-apps.json</code> and never sent back to a page. The form only
        accepts saves from the machine running the server.
      </p>
      <H3>Redirect URLs</H3>
      <Code lang="bash">{`
# Google
http://localhost:3000/api/calendar/callback/google
https://<your-domain>/api/calendar/callback/google

# Microsoft
http://localhost:3000/api/calendar/callback/outlook
https://<your-domain>/api/calendar/callback/outlook
`}</Code>
      <p>
        The app registrations themselves are described on the{' '}
        <Link href="/docs/providers/google">Google</Link> and{' '}
        <Link href="/docs/providers/outlook">Outlook</Link> provider pages.
      </p>

      <H2>Environment variables</H2>
      <p>All optional. When set, they take precedence over the setup form.</p>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          {ENV.map(([k, v]) => (
            <tr key={k}>
              <td>
                <code>{k}</code>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <H2>Deploy to Vercel</H2>
      <p>
        The repository&apos;s <code>demo/vercel.json</code> builds the library before the app, so a
        deploy works from a fresh clone. Set the project root to <code>demo</code>, then add:
      </p>
      <Code lang="bash">{`
# Generate a sealing key once and set it as SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
`}</Code>
      <Callout type="warning" title="Serverless needs SESSION_SECRET and env-var OAuth apps">
        Serverless instances cannot share a generated key or the saved-app file, so sign-in breaks
        without a fixed <code>SESSION_SECRET</code>. The localhost setup form is also unreachable on
        a deployment: configure Google and Microsoft with the environment variables above.
      </Callout>
    </DocPage>
  );
}
