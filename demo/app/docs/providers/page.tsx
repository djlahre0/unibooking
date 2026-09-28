import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import Link from 'next/link';
import { Callout, DocPage, H2, Pill } from '../_components/Doc';
import { PROVIDER_GUIDES, PROVIDER_ORDER, type GuideId } from '@/lib/docs/provider-guides';
import { capabilitiesOf } from '@/lib/docs/capabilities';
import { isDirect } from '@/lib/providers';
import { CheckIcon } from '../../components/icons';

export const metadata: Metadata = docMetadata({
  title: 'Providers',
  description: 'Every provider side by side: what it supports and how to connect.',
  href: '/docs/providers',
});

const COLUMNS: Array<[string, (id: GuideId) => boolean]> = [
  ['Availability', (id) => capabilitiesOf(id).availability],
  ['Services', (id) => capabilitiesOf(id).serviceCatalog],
  ['Staff', (id) => capabilitiesOf(id).staffDirectory],
  ['Clients', (id) => capabilitiesOf(id).customerDirectory],
  ['Calendars', (id) => capabilitiesOf(id).calendarList],
  ['Classes', (id) => capabilitiesOf(id).classCatalog],
  ['Webhooks', (id) => capabilitiesOf(id).webhooks || capabilitiesOf(id).changeNotifications],
  ['OAuth helper', (id) => Boolean(PROVIDER_GUIDES[id].oauth)],
  ['Browser', (id) => isDirect(id)],
];

function Grid({ ids }: { ids: GuideId[] }) {
  return (
    <div className="provider-cards">
      {ids.map((id) => {
        const g = PROVIDER_GUIDES[id];
        return (
          <Link key={id} href={`/docs/providers/${id}`} className="provider-card">
            <span className="provider-card-name">{g.name}</span>
            <span className="provider-card-summary">{g.summary}</span>
            <span className="provider-card-pills">
              <Pill>{g.auth}</Pill>
              <Pill tone={g.access === 'Self-serve' ? 'pine' : 'amber'}>{g.access}</Pill>
            </span>
          </Link>
        );
      })}
    </div>
  );
}

export default function Providers() {
  const calendars = PROVIDER_ORDER.filter((id) => PROVIDER_GUIDES[id].kind === 'calendar');
  const platforms = PROVIDER_ORDER.filter((id) => PROVIDER_GUIDES[id].kind === 'booking');
  return (
    <DocPage
      href="/docs/providers"
      title="Providers"
      lead="Each provider page says what you need, where to get it, how to connect, and what to know before production."
    >
      <H2>Calendars</H2>
      <Grid ids={calendars} />

      <H2>Booking platforms</H2>
      <Grid ids={platforms} />

      <H2>At a glance</H2>
      <div className="table-scroll">
        <table className="table-matrix">
          <thead>
            <tr>
              <th>Provider</th>
              {COLUMNS.map(([label]) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PROVIDER_ORDER.map((id) => (
              <tr key={id}>
                <td>
                  <Link href={`/docs/providers/${id}`}>{PROVIDER_GUIDES[id].name}</Link>
                </td>
                {COLUMNS.map(([label, has]) => (
                  <td key={label} className="cell-mark">
                    {has(id) ? (
                      <span className="mark-yes" aria-label="Yes">
                        <CheckIcon size={14} />
                      </span>
                    ) : (
                      <span className="mark-no" aria-label="No">
                        -
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="doc-footnote">
        Generated from each adapter&apos;s capability flags. &ldquo;Browser&rdquo; means the
        provider accepts cross-origin calls; the rest must be called from a server. Full detail is
        in <Link href="/docs/reference/capabilities">Capability flags</Link>.
      </p>
      <Callout type="note" title="Access">
        <strong>Self-serve</strong> providers let any developer create credentials.{' '}
        <strong>Partner approval</strong> providers gate their API: request access before you plan a
        launch date around them.
      </Callout>
    </DocPage>
  );
}
