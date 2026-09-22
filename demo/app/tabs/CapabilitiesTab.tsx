'use client';

import { getCapabilities, type ActionResult } from '../../lib/call';
import type { ProviderMeta } from '../../lib/providers';
import ResultBox from '../ResultBox';

export type CapabilitiesTabProps = {
  selectedProvider: string;
  providerInfo: ProviderMeta | null;
  capsResult: ActionResult | null;
  setCapsResult: (r: ActionResult | null) => void;
  wrap: (
    section: string,
    fn: () => Promise<ActionResult>,
    setter: (r: ActionResult) => void,
  ) => Promise<void>;
  busy: (section: string) => boolean;
  /** How long the last call took, measured in page.tsx's `wrap`. */
  elapsedMs?: number;
};

export default function CapabilitiesTab({
  selectedProvider,
  providerInfo,
  capsResult,
  setCapsResult,
  wrap,
  busy,
  elapsedMs,
}: CapabilitiesTabProps) {
  return (
    <div className="fade-in">
      {!selectedProvider ? (
        <div className="empty-state">
          <span className="icon">⚡</span>
          Select a provider in the Connect tab first
        </div>
      ) : (
        <div className="card">
          <div className="card-title">
            <span className="icon">⚡</span> Capabilities — {providerInfo?.label}
          </div>
          <p
            style={{
              color: 'var(--text-secondary)',
              fontSize: '0.82rem',
              marginBottom: '1rem',
            }}
          >
            <code>client.capabilities</code> — typed object that tells you what this provider
            supports, before you call any method.
          </p>
          {!capsResult && (
            <button
              className="btn btn-primary"
              onClick={() => wrap('caps', () => getCapabilities(selectedProvider), setCapsResult)}
              disabled={busy('caps')}
            >
              {busy('caps') ? '...' : 'Load Capabilities'}
            </button>
          )}
          {capsResult?.ok && capsResult.data ? (
            <div className="caps-grid">
              {Object.entries(
                ((capsResult.data as Record<string, unknown>)?.capabilities ??
                  {}) as Record<string, boolean>,
              ).map(([key, val]) => (
                <div key={key} className={`cap-badge ${val ? 'supported' : 'unsupported'}`}>
                  {val ? '✓' : '✗'} {key}
                </div>
              ))}
            </div>
          ) : null}
          <ResultBox result={capsResult} label="Raw Response" elapsedMs={elapsedMs} />
        </div>
      )}
    </div>
  );
}
