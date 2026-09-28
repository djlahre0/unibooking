'use client';

import { useEffect } from 'react';

import { getCapabilities, type ActionResult } from '../../lib/call';
import ResultBox from '../ResultBox';
import { CheckIcon, XIcon, ZapIcon } from '../components/icons';

export type CapabilitiesTabProps = {
  selectedProvider: string;
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
  capsResult,
  setCapsResult,
  wrap,
  busy,
  elapsedMs,
}: CapabilitiesTabProps) {
  // Capabilities are static data on the adapter, read without any request, so
  // there is nothing to wait for: show them as soon as a provider is chosen.
  useEffect(() => {
    if (selectedProvider && !capsResult) {
      void wrap('caps', () => getCapabilities(selectedProvider), setCapsResult);
    }
  }, [selectedProvider, capsResult, wrap, setCapsResult]);

  return (
    <div className="fade-in">
      {!selectedProvider ? (
        <div className="empty-state">
          <span className="icon">
            <ZapIcon size={18} />
          </span>
          Choose a provider in the sidebar to start.
        </div>
      ) : (
        <div className="card">
          <div className="card-title">
            <span className="icon">
              <ZapIcon size={18} />
            </span>{' '}
            Capability flags
          </div>
          <p
            style={{
              color: 'var(--text-secondary)',
              fontSize: '0.82rem',
              marginBottom: '1rem',
            }}
          >
            <code>client.capabilities</code> is a typed object that tells you what this provider
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
                ((capsResult.data as Record<string, unknown>)?.capabilities ?? {}) as Record<
                  string,
                  boolean
                >,
              ).map(([key, val]) => (
                <div key={key} className={`cap-badge ${val ? 'supported' : 'unsupported'}`}>
                  {val ? <CheckIcon size={14} /> : <XIcon size={14} />} {key}
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
