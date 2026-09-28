import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { docMetadata } from '@/lib/docs/meta';
import { PROVIDER_CREDENTIALS, type CredentialSet } from 'unibooking';
import { Callout, Code, DocPage, H2, H3, Pill, Step, Steps } from '../../_components/Doc';
import {
  PROVIDER_GUIDES,
  PROVIDER_ORDER,
  type GuideId,
  type ProviderGuide,
} from '@/lib/docs/provider-guides';
import { CAPABILITY_INFO, CAPABILITY_KEYS, capabilitiesOf } from '@/lib/docs/capabilities';
import { inline } from '@/lib/docs/inline';
import { isDirect } from '@/lib/providers';
import { ExternalIcon, TerminalIcon } from '../../../components/icons';

type Params = { params: Promise<{ id: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return PROVIDER_ORDER.map((id) => ({ id }));
}

function guideFor(id: string): ProviderGuide | undefined {
  return (PROVIDER_ORDER as readonly string[]).includes(id)
    ? PROVIDER_GUIDES[id as GuideId]
    : undefined;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const g = guideFor(id);
  if (!g) return {};
  return docMetadata({
    title: `${g.name} setup guide`,
    description: `${g.summary} What you need, where to get it, how to connect, and what to know before production.`,
    href: `/docs/providers/${id}`,
  });
}

/** Adapter export names are camelCase; provider ids are snake_case. */
function exportName(id: string): string {
  return id.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function envName(id: string, key: string): string {
  return `${id}_${key.replace(/([A-Z])/g, '_$1')}`.toUpperCase();
}

/** A connect-and-check snippet from the provider's first credential set. */
function connectSample(id: GuideId, set: CredentialSet, kind: ProviderGuide['kind']): string {
  const fn = exportName(id);
  const required = set.fields.filter((f) => f.required);
  const optional = set.fields.filter((f) => !f.required);
  const lines = required.map((f) => `  ${f.key}: process.env.${envName(id, f.key)}!,`);
  for (const f of optional) lines.push(`  // ${f.key}: optional: ${f.help ?? f.label}`);
  const extra =
    kind === 'calendar'
      ? `\n// Pick the calendar to work with.\nconst { calendars } = await client.listCalendars!();`
      : `\n// Browse what can be booked.\nconst { services } = (await client.listServices?.()) ?? { services: [] };`;
  return `import { ${fn} } from 'unibooking/adapters/${id}';

const client = ${fn}({
${lines.join('\n')}
});

const status = await client.checkConnection();
if (!status.ok) throw new Error(\`${id}: \${status.reason}: \${status.message}\`);
${extra}`;
}

function oauthSample(id: GuideId, g: ProviderGuide): string {
  const o = g.oauth!;
  if (id === 'setmore') {
    return `import { setmoreOAuth } from 'unibooking/oauth/setmore';

// The account owner's long-lived refresh token, from their Setmore settings.
const tokens = await setmoreOAuth().refresh(process.env.SETMORE_REFRESH_TOKEN!);`;
  }
  if (id === 'wix') {
    return `import { wixOAuth } from 'unibooking/oauth/wix';

const oauth = wixOAuth({
  clientId: process.env.WIX_APP_ID!,
  clientSecret: process.env.WIX_APP_SECRET!,
});

// The install delivers an instanceId to your app's redirect endpoint.
const tokens = await oauth.exchangeCode(instanceId);`;
  }
  const prefix = id.toUpperCase();
  return `import { ${o.fn} } from '${o.module}';

const oauth = ${o.fn}({
  clientId: process.env.${prefix}_CLIENT_ID!,
  clientSecret: process.env.${prefix}_CLIENT_SECRET!,
  redirectUri: 'https://app.example.com/oauth/${id}/callback',
});

const { url, state, codeVerifier } = await oauth.authorizationUrl({ pkce: true });
// …redirect to url; on the callback, check state, then:
const tokens = await oauth.exchangeCode(code, { codeVerifier });`;
}

const KIND_LABEL: Record<string, string> = {
  oauth: 'OAuth token',
  keys: 'API keys',
  'app-password': 'App-specific password',
};

export default async function ProviderPage({ params }: Params) {
  const { id } = await params;
  const g = guideFor(id);
  if (!g) notFound();
  const pid = id as GuideId;
  const sets = PROVIDER_CREDENTIALS[pid];
  const caps = capabilitiesOf(pid);
  const supported = CAPABILITY_KEYS.filter((k) => caps[k]);
  const missing = CAPABILITY_KEYS.filter((k) => !caps[k]);
  const href = `/docs/providers/${id}`;

  return (
    <DocPage
      href={href}
      title={g.name}
      lead={g.summary}
      badges={
        <>
          <Pill>{g.kind === 'calendar' ? 'Calendar' : 'Booking platform'}</Pill>
          <Pill>{g.auth}</Pill>
          <Pill tone={g.access === 'Self-serve' ? 'pine' : 'amber'}>{g.access}</Pill>
          <Pill tone={isDirect(id) ? 'pine' : 'amber'}>
            {isDirect(id) ? 'Browser or server' : 'Server only'}
          </Pill>
        </>
      }
    >
      {g.maturity === 'validate' && (
        <Callout type="warning" title="Validate on a real account first">
          This adapter was built from {g.name}&apos;s published API and passes the conformance
          suite, but has not been run against a live account. Test your flows on a real or sandbox
          account before you rely on it.
        </Callout>
      )}
      {g.maturity === 'planned' && (
        <Callout type="warning" title="Not usable yet">
          Every method throws <code>UNSUPPORTED</code> until {g.name} publishes API documentation.
        </Callout>
      )}

      <H2>What you need</H2>
      {sets.map((set, i) => (
        <div key={set.kind + i}>
          {sets.length > 1 && (
            <H3 id={`credentials-${set.kind}`}>
              {i === 0 ? 'Option 1' : `Option ${i + 1}`}: {KIND_LABEL[set.kind] ?? set.kind}
            </H3>
          )}
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Required</th>
                <th>Where it comes from</th>
              </tr>
            </thead>
            <tbody>
              {set.fields.map((f) => (
                <tr key={f.key}>
                  <td>
                    <code>{f.key}</code>
                    <span className="field-label">
                      {f.label}
                      {f.secret && <span className="field-secret">secret</span>}
                    </span>
                  </td>
                  <td>{f.required ? 'Yes' : 'Optional'}</td>
                  <td>{f.help ? inline(f.help) : (f.placeholder ?? '-')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <H2>Get your credentials</H2>
      <Steps>
        {g.steps.map((s, i) => (
          <Step key={i} title={`Step ${i + 1}`}>
            <p>{inline(s)}</p>
          </Step>
        ))}
      </Steps>

      {g.maturity !== 'planned' && sets[0] && (
        <>
          <H2>Connect</H2>
          <Code title={`${id}.ts`}>{connectSample(pid, sets[0], g.kind)}</Code>
        </>
      )}

      {g.oauth && (
        <>
          <H2>OAuth</H2>
          <p>
            <code>{g.oauth.fn}</code> from <code>{g.oauth.module}</code>.{' '}
            {g.oauth.note && inline(g.oauth.note)} The full flow, including refresh, is in{' '}
            <Link href="/docs/guides/oauth">OAuth &amp; token refresh</Link>.
          </p>
          <Code title="oauth.ts">{oauthSample(pid, g)}</Code>
        </>
      )}

      {g.maturity !== 'planned' && (
        <>
          <H2>What it supports</H2>
          <ul className="cap-list">
            {supported.map((k) => (
              <li key={k}>
                <strong>{CAPABILITY_INFO[k].label}</strong>
                <code>{CAPABILITY_INFO[k].methods}</code>
              </li>
            ))}
          </ul>
          {missing.length > 0 && (
            <details className="cap-missing">
              <summary>Not supported ({missing.length})</summary>
              <p>
                {missing.map((k, i) => (
                  <span key={k}>
                    {i > 0 && ', '}
                    {CAPABILITY_INFO[k].label}
                  </span>
                ))}
                . Calling a missing method is impossible (it is absent from the client); core
                methods that the provider lacks throw <code>UNSUPPORTED</code>.
              </p>
            </details>
          )}
        </>
      )}

      {g.webhook && (
        <>
          <H2>Webhooks</H2>
          <p>
            {g.webhook.fns.map((f, i) => (
              <span key={f}>
                {i > 0 && ', '}
                <code>{f}</code>
              </span>
            ))}{' '}
            from <code>{g.webhook.module}</code>. {g.webhook.note && inline(g.webhook.note)} See{' '}
            <Link href="/docs/guides/webhooks">Webhooks &amp; change sync</Link>.
          </p>
        </>
      )}

      <H2>Before production</H2>
      <ul>
        {g.notes.map((n, i) => (
          <li key={i}>{inline(n)}</li>
        ))}
      </ul>

      <H2>Resources</H2>
      <div className="resource-links">
        {g.maturity !== 'planned' && (
          <Link className="btn-doc btn-doc-primary" href={`/?provider=${id}&tab=connect`}>
            <TerminalIcon size={15} />
            Try {g.name} in the Explorer
          </Link>
        )}
        <a className="btn-doc" href={g.docsUrl} target="_blank" rel="noreferrer">
          {g.name} API docs <ExternalIcon size={13} />
        </a>
        {g.portal && g.portal.href !== g.docsUrl && (
          <a className="btn-doc" href={g.portal.href} target="_blank" rel="noreferrer">
            {g.portal.label} <ExternalIcon size={13} />
          </a>
        )}
      </div>
    </DocPage>
  );
}
