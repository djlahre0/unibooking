import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import Link from 'next/link';
import { DocPage } from '../../_components/Doc';
import { CAPABILITY_INFO, CAPABILITY_KEYS, providersWith } from '@/lib/docs/capabilities';
import { PROVIDER_GUIDES } from '@/lib/docs/provider-guides';

export const metadata: Metadata = docMetadata({
  title: 'Capability flags',
  description: 'Each flag, what it unlocks, and which providers set it.',
  href: '/docs/reference/capabilities',
});

export default function CapabilityReference() {
  return (
    <DocPage
      href="/docs/reference/capabilities"
      title="Capability flags"
      lead="client.capabilities says what a provider can do. This table is generated from the adapters themselves, so it always matches the version of unibooking this site runs."
    >
      <table className="table-dense">
        <thead>
          <tr>
            <th>Flag</th>
            <th>What it means</th>
            <th>Unlocks</th>
            <th>Providers</th>
          </tr>
        </thead>
        <tbody>
          {CAPABILITY_KEYS.map((key) => {
            const info = CAPABILITY_INFO[key];
            const ids = providersWith(key);
            return (
              <tr key={key} id={key}>
                <td>
                  <code>{key}</code>
                </td>
                <td>
                  <strong>{info.label}.</strong> {info.description}
                </td>
                <td>
                  <code>{info.methods}</code>
                </td>
                <td>
                  {ids.length === 0
                    ? 'None yet'
                    : ids.map((id, i) => (
                        <span key={id}>
                          {i > 0 && ', '}
                          <Link href={`/docs/providers/${id}`}>{PROVIDER_GUIDES[id].name}</Link>
                        </span>
                      ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </DocPage>
  );
}
