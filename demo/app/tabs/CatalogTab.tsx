'use client';

import {
  type ActionResult,
  type Connection,
  callCheckConnection,
  callListServices,
  callListStaff,
} from '../../lib/call';
import type { ProviderMeta } from '../../lib/providers';
import ResultBox from '../ResultBox';

export type CatalogTabProps = {
  selectedProvider: string;
  providerInfo: ProviderMeta | null;
  conn: Connection;
  catalogResult: ActionResult | null;
  setCatalogResult: (r: ActionResult | null) => void;
  wrap: (
    section: string,
    fn: () => Promise<ActionResult>,
    setter: (r: ActionResult) => void,
  ) => Promise<void>;
  busy: (section: string) => boolean;
  /** How long the last call took, measured in page.tsx's `wrap`. */
  elapsedMs?: number;
};

export default function CatalogTab({
  selectedProvider,
  providerInfo,
  conn,
  catalogResult,
  setCatalogResult,
  wrap,
  busy,
  elapsedMs,
}: CatalogTabProps) {
  return (
    <div className="fade-in">
      {!selectedProvider ? (
        <div className="empty-state">
          <span className="icon">📚</span>
          Select a provider in the Connect tab first
        </div>
      ) : (
        <div className="card">
          <div className="card-title">
            <span className="icon">📚</span> Catalog &amp; Health — {providerInfo?.label}
          </div>

          <p
            style={{
              color: 'var(--text-secondary)',
              fontSize: '0.82rem',
              marginBottom: '1rem',
            }}
          >
            <code>checkConnection()</code> is on every adapter and does <strong>not</strong> throw
            when credentials are dead — it returns <code>{'{ ok: false, reason }'}</code>. A
            network blip or 5xx still throws, so a transient fault is never mistaken for a revoked
            integration.
          </p>
          <p
            style={{
              color: 'var(--text-secondary)',
              fontSize: '0.82rem',
              marginBottom: '1rem',
            }}
          >
            <code>listServices()</code> / <code>listStaff()</code> need{' '}
            <code>capabilities.serviceCatalog</code> / <code>capabilities.staffDirectory</code> —
            which are <em>not</em> the same as <code>services</code> / <code>staff</code>, those
            only say a booking can reference one.
          </p>

          <div className="op-row">
            <button
              className="btn btn-sm btn-primary"
              disabled={busy('catalog')}
              onClick={() =>
                wrap('catalog', () => callCheckConnection(selectedProvider, conn), setCatalogResult)
              }
            >
              ❤️ Check Connection
            </button>
            <button
              className="btn btn-sm btn-secondary"
              disabled={busy('catalog')}
              onClick={() =>
                wrap(
                  'catalog',
                  () => callListServices(selectedProvider, conn, { limit: 20 }),
                  setCatalogResult,
                )
              }
            >
              🧾 List Services
            </button>
            <button
              className="btn btn-sm btn-secondary"
              disabled={busy('catalog')}
              onClick={() =>
                wrap(
                  'catalog',
                  () => callListStaff(selectedProvider, conn, { limit: 20 }),
                  setCatalogResult,
                )
              }
            >
              🧑‍🔧 List Staff
            </button>
          </div>

          <p
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.78rem',
              marginTop: '1rem',
            }}
          >
            Catalog <strong>writes</strong> (<code>createService</code>,{' '}
            <code>setStaffActive</code>, …) are supported by the library on Square but are
            deliberately not exposed here — this playground talks to real accounts, and a demo
            should not mutate a live salon&apos;s catalog.
          </p>

          {catalogResult && (
            <ResultBox result={catalogResult} label="catalog result" elapsedMs={elapsedMs} />
          )}
        </div>
      )}
    </div>
  );
}
