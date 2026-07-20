'use client';

import type { ActionResult } from '../lib/call';
import { PROVIDER_META as PROVIDERS, isDirect } from '../lib/providers';
import ResultBox from './ResultBox';

/* ─── Trust-model banner: shows where the visitor's token actually goes ─── */
function TrustBanner({ provider }: { provider: string }) {
  const direct = isDirect(provider);
  const style: React.CSSProperties = {
    borderRadius: '8px',
    padding: '0.7rem 0.85rem',
    margin: '0.9rem 0 0.4rem',
    fontSize: '0.78rem',
    lineHeight: 1.6,
    border: `1px solid ${direct ? '#2f6f4f' : '#6b5a2f'}`,
    background: direct ? '#0f2418' : '#241f0f',
    color: direct ? '#86efac' : '#fcd34d',
  };
  return (
    <div style={style} role="note">
      {direct ? (
        <>
          🔒 <strong>Your token never leaves this browser.</strong> It is sent directly from your
          machine to the provider&apos;s API — this demo&apos;s server is never involved.
        </>
      ) : (
        <>
          ↗ <strong>This provider blocks browser calls</strong>, so your credentials are sent to the
          demo&apos;s server, forwarded to the provider, and discarded. They are never stored on the
          demo&apos;s server, and never logged.{' '}
          <span style={{ color: 'var(--text-muted, #8888a0)' }}>
            This is exactly why unibooking runs server-side.
          </span>
        </>
      )}
    </div>
  );
}

export type ConnectPanelProps = {
  selectedProvider: string;
  onSelectProvider: (id: string) => void;
  creds: Record<string, string>;
  onCredChange: (key: string, value: string) => void;
  capsResult: ActionResult | null;
  onLoadCapabilities: () => void;
  busy: boolean;
  children?: React.ReactNode;
};

export default function ConnectPanel({
  selectedProvider,
  onSelectProvider,
  creds,
  onCredChange,
  capsResult,
  onLoadCapabilities,
  busy,
  children,
}: ConnectPanelProps) {
  const providerInfo = selectedProvider ? PROVIDERS[selectedProvider] : null;

  return (
    <div className="fade-in">
      <div className="card">
        <div className="card-title">
          <span className="icon">🔌</span> Select Provider
        </div>
        <div className="provider-grid">
          {Object.entries(PROVIDERS).map(([id, p]) => (
            <button
              key={id}
              className={`provider-chip ${selectedProvider === id ? 'selected' : ''}`}
              onClick={() => onSelectProvider(id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {providerInfo && (
          <>
            <div className="section-title" style={{ marginTop: '1.2rem' }}>
              Credentials for {providerInfo.label}
            </div>
            <TrustBanner provider={selectedProvider} />
            {children}
            <div className="creds-form">
              {providerInfo.fields.map((f) => (
                <div className="form-group" key={f.key}>
                  <label className="form-label">{f.label}</label>
                  <input
                    className="form-input"
                    type={f.secret === false ? 'text' : 'password'}
                    placeholder={f.placeholder}
                    value={creds[f.key] ?? ''}
                    onChange={(e) => onCredChange(f.key, e.target.value)}
                    required={!f.placeholder.toLowerCase().includes('optional')}
                  />
                </div>
              ))}
            </div>
            <div style={{ marginTop: '1rem' }}>
              <button className="btn btn-primary" onClick={onLoadCapabilities} disabled={busy}>
                {busy ? '...' : '⚡ Load Capabilities'}
              </button>
            </div>
            {capsResult ? <ResultBox result={capsResult} label="Capabilities" /> : null}
          </>
        )}
      </div>
    </div>
  );
}
