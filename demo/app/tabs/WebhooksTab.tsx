'use client';

import { useState } from 'react';
import { type ActionResult, verifyWebhook } from '../../lib/call';
import ResultBox from '../ResultBox';
import { loadUiState, patchUiState } from '../../lib/ui-state';
import { BellIcon, KeyIcon } from '../components/icons';

/* ═══════════════════════════════════════════════════════════
   Webhook field metadata per provider
   ═══════════════════════════════════════════════════════════ */
const WEBHOOK_PROVIDERS: Record<
  string,
  {
    label: string;
    fields: {
      key: string;
      label: string;
      placeholder: string;
      multiline?: boolean;
      /** A fixed choice, rendered as a select; the first option is the default. */
      options?: string[];
    }[];
  }
> = {
  square: {
    label: 'Square',
    fields: [
      { key: 'signatureKey', label: 'Signature Key', placeholder: 'Webhook signature key' },
      { key: 'notificationUrl', label: 'Notification URL', placeholder: 'https://...' },
      { key: 'body', label: 'Raw Body', placeholder: '{"event_type":"..."}', multiline: true },
      {
        key: 'signature',
        label: 'Signature Header',
        placeholder: 'x-square-hmacsha256-signature value',
      },
    ],
  },
  acuity: {
    label: 'Acuity',
    fields: [
      { key: 'apiKey', label: 'API Key', placeholder: 'Your API key (HMAC secret)' },
      { key: 'body', label: 'Raw Body', placeholder: '{"id":123,...}', multiline: true },
      { key: 'signature', label: 'Signature', placeholder: 'X-Acuity-Signature value' },
    ],
  },
  calendly: {
    label: 'Calendly',
    fields: [
      { key: 'signingKey', label: 'Signing Key', placeholder: 'Webhook signing key' },
      { key: 'body', label: 'Raw Body', placeholder: '{"event":"..."}', multiline: true },
      { key: 'signatureHeader', label: 'Signature Header', placeholder: 't=...,v1=...' },
    ],
  },
  google: {
    label: 'Google Calendar',
    fields: [
      { key: 'expectedToken', label: 'Expected Token', placeholder: 'Token you set on the watch' },
      { key: 'channelToken', label: 'Channel Token', placeholder: 'X-Goog-Channel-Token value' },
    ],
  },
  mindbody: {
    label: 'Mindbody',
    fields: [
      { key: 'signatureKey', label: 'Signature Key', placeholder: 'Webhook signature key' },
      { key: 'body', label: 'Raw Body', placeholder: '{"event":...}', multiline: true },
      { key: 'signature', label: 'Signature', placeholder: 'X-Mindbody-Signature value' },
    ],
  },
  outlook: {
    label: 'Outlook / Graph',
    fields: [
      {
        key: 'mode',
        label: 'What to check',
        placeholder: '',
        options: ['clientState', 'validation'],
      },
      {
        key: 'queryString',
        label: 'Query String (validation)',
        placeholder: 'validationToken=abc',
      },
      {
        key: 'payload',
        label: 'Payload JSON (clientState)',
        placeholder: '{"value":[...]}',
        multiline: true,
      },
      {
        key: 'expectedClientState',
        label: 'Expected Client State',
        placeholder: 'your-client-state',
      },
    ],
  },
  boulevard: {
    label: 'Boulevard',
    fields: [
      { key: 'signingSecret', label: 'Signing Secret', placeholder: 'Webhook signing secret' },
      { key: 'salt', label: 'Salt Header', placeholder: 'x-blvd-hmac-salt value' },
      { key: 'body', label: 'Raw Body', placeholder: '{"event":...}', multiline: true },
      { key: 'signature', label: 'Signature Header', placeholder: 'x-blvd-hmac-sha256 value' },
    ],
  },
  vagaro: {
    label: 'Vagaro',
    fields: [
      { key: 'received', label: 'Received Token', placeholder: 'X-Vagaro-Signature value' },
      {
        key: 'expected',
        label: 'Expected Token',
        placeholder: 'Your configured verification token',
      },
    ],
  },
  bookeo: {
    label: 'Bookeo',
    fields: [
      { key: 'secretKey', label: 'Secret Key', placeholder: 'Your application secret key' },
      { key: 'timestamp', label: 'Timestamp Header', placeholder: 'X-Bookeo-Timestamp value' },
      { key: 'messageId', label: 'Message ID Header', placeholder: 'X-Bookeo-MessageId value' },
      { key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://... (as registered)' },
      { key: 'body', label: 'Raw Body', placeholder: '{"itemId":"..."}', multiline: true },
      { key: 'signature', label: 'Signature Header', placeholder: 'X-Bookeo-Signature value' },
    ],
  },
  wix: {
    label: 'Wix',
    fields: [
      { key: 'jwt', label: 'JWT (raw body)', placeholder: 'eyJ...', multiline: true },
      {
        key: 'publicKey',
        label: 'Public Key (PEM)',
        placeholder: '-----BEGIN PUBLIC KEY-----\n...',
        multiline: true,
      },
    ],
  },
};

export type WebhooksTabProps = {
  webhookResult: ActionResult | null;
  setWebhookResult: (r: ActionResult | null) => void;
  wrap: (
    section: string,
    fn: () => Promise<ActionResult>,
    setter: (r: ActionResult) => void,
  ) => Promise<void>;
  busy: (section: string) => boolean;
  /** How long the last call took, measured in page.tsx's `wrap`. */
  elapsedMs?: number;
};

export default function WebhooksTab({
  webhookResult,
  setWebhookResult,
  wrap,
  busy,
  elapsedMs,
}: WebhooksTabProps) {
  // Only the PROVIDER choice is remembered. `webhookFields` holds this tab's
  // API key and signing secret, HMAC credentials, so they stay in memory
  // for the session and are never written to storage, which is also why this
  // tab's inputs are not wrapped in PersistedForm.
  const [webhookProvider, setWebhookProvider_] = useState(() => loadUiState().webhookProvider);
  const setWebhookProvider = (id: string) => {
    setWebhookProvider_(id);
    patchUiState({ webhookProvider: id });
  };
  const [webhookFields, setWebhookFields] = useState<Record<string, string>>({});

  return (
    <div className="fade-in">
      <div className="card">
        <div className="card-title">
          <span className="icon">
            <BellIcon size={18} />
          </span>{' '}
          Webhook Verification
        </div>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '0.82rem',
            marginBottom: '1rem',
          }}
        >
          {Object.keys(WEBHOOK_PROVIDERS).length} webhook verifiers. Paste the raw payload and its
          signature exactly as your server received them.
        </p>

        <div className="section-title">Select Webhook Provider</div>
        <div className="provider-grid" style={{ marginBottom: '1.2rem' }}>
          {Object.entries(WEBHOOK_PROVIDERS).map(([id, wp]) => (
            <button
              key={id}
              className={`provider-chip ${webhookProvider === id ? 'selected' : ''}`}
              onClick={() => {
                setWebhookProvider(id);
                setWebhookFields({});
                setWebhookResult(null);
              }}
            >
              {wp.label}
            </button>
          ))}
        </div>

        {WEBHOOK_PROVIDERS[webhookProvider] && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              wrap(
                'webhook',
                () => verifyWebhook(webhookProvider, webhookFields),
                setWebhookResult,
              );
            }}
          >
            <div className="section-title">{WEBHOOK_PROVIDERS[webhookProvider].label} Fields</div>
            {WEBHOOK_PROVIDERS[webhookProvider].fields.map((f) => (
              <div className="form-group" key={f.key}>
                <label className="form-label" htmlFor={`wh-${f.key}`}>
                  {f.label}
                </label>
                {f.options ? (
                  <select
                    id={`wh-${f.key}`}
                    className="form-select"
                    value={webhookFields[f.key] ?? f.options[0]}
                    onChange={(e) =>
                      setWebhookFields((prev) => ({ ...prev, [f.key]: e.target.value }))
                    }
                  >
                    {f.options.map((o) => (
                      <option key={o} value={o}>
                        {o === 'validation'
                          ? 'Subscription validation token'
                          : 'Notification clientState'}
                      </option>
                    ))}
                  </select>
                ) : f.multiline ? (
                  <textarea
                    id={`wh-${f.key}`}
                    className="form-textarea"
                    placeholder={f.placeholder}
                    value={webhookFields[f.key] ?? ''}
                    onChange={(e) =>
                      setWebhookFields((prev) => ({ ...prev, [f.key]: e.target.value }))
                    }
                  />
                ) : (
                  <input
                    id={`wh-${f.key}`}
                    className="form-input"
                    type={/password|secret|key/i.test(f.key) ? 'password' : 'text'}
                    placeholder={f.placeholder}
                    value={webhookFields[f.key] ?? ''}
                    onChange={(e) =>
                      setWebhookFields((prev) => ({ ...prev, [f.key]: e.target.value }))
                    }
                  />
                )}
              </div>
            ))}
            <button className="btn btn-primary" type="submit" disabled={busy('webhook')}>
              {busy('webhook') ? (
                '...'
              ) : (
                <>
                  <KeyIcon /> Verify Signature
                </>
              )}
            </button>
          </form>
        )}

        <ResultBox result={webhookResult} label="Webhook Verification" elapsedMs={elapsedMs} />
      </div>
    </div>
  );
}
