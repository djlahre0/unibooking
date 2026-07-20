'use client';

import { ENVIRONMENTS, resolveBaseUrl } from '../lib/environments';

export type EnvironmentControlProps = {
  provider: string;
  env: string;
  baseUrl: string;
  onChange: (env: string, baseUrl: string) => void;
};

/**
 * Environment picker + always-visible base URL. Only three providers publish a
 * separate sandbox host, so the toggle renders only where it means something;
 * the editable URL is shown for every provider because regional and
 * self-hosted cases exist that no toggle covers.
 */
export default function EnvironmentControl({
  provider,
  env,
  baseUrl,
  onChange,
}: EnvironmentControlProps) {
  const meta = ENVIRONMENTS[provider];
  if (!meta) return null;

  const editable = meta.baseUrlEditable !== false;
  const regionKeys = Object.keys(meta.regions ?? {});

  const pick = (next: string) => onChange(next, resolveBaseUrl(provider, next) ?? meta.prod);

  return (
    <div style={{ margin: '0.9rem 0 0.4rem' }}>
      <div className="section-title" style={{ fontSize: '0.8rem' }}>
        Environment
      </div>

      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', margin: '0.5rem 0' }}>
        <button
          className={`btn btn-sm ${env === 'prod' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => pick('prod')}
        >
          Production
        </button>

        {meta.sandbox && (
          <button
            className={`btn btn-sm ${env === 'sandbox' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => pick('sandbox')}
          >
            Sandbox
          </button>
        )}

        {regionKeys.map((k) => (
          <button
            key={k}
            className={`btn btn-sm ${env === k ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => pick(k)}
          >
            {k}
          </button>
        ))}
      </div>

      <label className="form-label" htmlFor="base-url">
        Base URL
      </label>
      <input
        id="base-url"
        className="form-input"
        type="text"
        value={baseUrl}
        disabled={!editable}
        onChange={(e) => onChange('custom', e.target.value)}
      />

      {editable ? (
        env !== 'prod' && (
          <button
            className="btn btn-sm btn-secondary"
            style={{ marginTop: '0.4rem' }}
            onClick={() => pick('prod')}
          >
            ↺ Reset to default
          </button>
        )
      ) : (
        <p
          style={{ fontSize: '0.75rem', color: 'var(--text-muted, #8888a0)', marginTop: '0.4rem' }}
        >
          Apple/CalDAV takes its host from the Calendar URL below, so this has no effect.
        </p>
      )}
    </div>
  );
}
