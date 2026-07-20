'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  type ActionResult,
  getCapabilities,
  callCreateBooking,
  callGetBooking,
  callUpdateBooking,
  callCancelBooking,
  callListBookings,
  callSearchAvailability,
  callFindOrCreateCustomer,
  demoRegistry,
  demoWithRetry,
  demoCollectAll,
  demoListAll,
  demoErrorHelpers,
  verifyWebhook,
} from '../lib/call';
import { PROVIDER_META as PROVIDERS } from '../lib/providers';
import { ENVIRONMENTS } from '../lib/environments';
import {
  loadState,
  saveProvider,
  clearProvider,
  clearAll,
  storageAvailable,
  setRemember as persistRemember,
} from '../lib/cred-storage';
import ConnectPanel from './ConnectPanel';
import EnvironmentControl from './EnvironmentControl';
import PersistenceControls from './PersistenceControls';
import ResultBox from './ResultBox';

/* ═══════════════════════════════════════════════════════════
   Webhook field metadata per provider
   ═══════════════════════════════════════════════════════════ */
const WEBHOOK_PROVIDERS: Record<
  string,
  {
    label: string;
    fields: { key: string; label: string; placeholder: string; multiline?: boolean }[];
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
      { key: 'mode', label: 'Mode', placeholder: 'validation | clientState' },
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

const TABS = [
  { id: 'connect', label: '🔌 Connect' },
  { id: 'capabilities', label: '⚡ Capabilities' },
  { id: 'bookings', label: '📅 Bookings' },
  { id: 'availability', label: '🕐 Availability' },
  { id: 'customers', label: '👤 Customers' },
  { id: 'utilities', label: '🛠 Utilities' },
  { id: 'webhooks', label: '🔔 Webhooks' },
];

/* ═══════════════════════════════════════════════════════════
   Main Page
   ═══════════════════════════════════════════════════════════ */
export default function Home() {
  const [activeTab, setActiveTab] = useState('connect');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [env, setEnv] = useState('prod');
  const [baseUrl, setBaseUrl] = useState('');
  const [remember, setRemember_] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [loadingSection, setLoadingSection] = useState('');
  const busy = (s: string) => loadingSection === s;

  useEffect(() => {
    setStorageOk(storageAvailable());
    setRemember_(loadState().remember);
  }, []);

  // Results
  const [capsResult, setCapsResult] = useState<ActionResult | null>(null);
  const [bookingResult, setBookingResult] = useState<ActionResult | null>(null);
  const [availResult, setAvailResult] = useState<ActionResult | null>(null);
  const [customerResult, setCustomerResult] = useState<ActionResult | null>(null);
  const [utilResult, setUtilResult] = useState<ActionResult | null>(null);
  const [webhookResult, setWebhookResult] = useState<ActionResult | null>(null);

  // Form states
  const [bookingOp, setBookingOp] = useState('create');
  const [webhookProvider, setWebhookProvider] = useState('square');
  const [webhookFields, setWebhookFields] = useState<Record<string, string>>({});

  const updateCred = useCallback(
    (key: string, value: string) => setCreds((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const wrap = useCallback(
    async (section: string, fn: () => Promise<ActionResult>, setter: (r: ActionResult) => void) => {
      setLoadingSection(section);
      try {
        const result = await fn();
        setter(result);
      } catch (e) {
        setter({ ok: false, error: { message: String(e) } });
      } finally {
        setLoadingSection('');
      }
    },
    [],
  );

  const providerInfo = selectedProvider ? PROVIDERS[selectedProvider] : null;
  const conn = useMemo(() => {
    const prod = selectedProvider ? ENVIRONMENTS[selectedProvider]?.prod : undefined;
    // Suppress baseUrl when it matches the provider's production default so the
    // adapter falls back to its own built-in default instead of an explicit
    // override. This has a surprising consequence: Phorest's `eu` region URL is
    // byte-identical to its `prod` URL, so selecting "eu" sends no override at
    // all — the UI shows `eu` selected while the outgoing request carries no
    // explicit host. That's correct (the table's `prod` is contractually equal
    // to the adapter's default, enforced by environments-drift.test.ts) but
    // non-obvious, hence this note.
    return { creds, baseUrl: !baseUrl || baseUrl === prod ? undefined : baseUrl };
  }, [creds, baseUrl, selectedProvider]);

  useEffect(() => {
    if (!remember || !selectedProvider) return;
    const t = setTimeout(() => {
      saveProvider(selectedProvider, { creds, env, baseUrl });
    }, 300);
    return () => clearTimeout(t);
  }, [remember, selectedProvider, creds, env, baseUrl]);

  return (
    <div className="app-container">
      {/* ─── Header ─── */}
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h1>unibooking</h1>
          <div
            className="header-links"
            style={{ display: 'flex', gap: '0.8rem', marginTop: '0.2rem' }}
          >
            <a
              href="https://github.com/djlahre0/unibooking"
              target="_blank"
              rel="noreferrer"
              title="GitHub Repository"
              style={{
                color: 'var(--text-secondary)',
                textDecoration: 'none',
                transition: 'color 0.2s',
              }}
              onMouseOver={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
              onMouseOut={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
            </a>
            <a
              href="https://www.npmjs.com/package/unibooking"
              target="_blank"
              rel="noreferrer"
              title="npm Package"
              style={{
                color: 'var(--text-secondary)',
                textDecoration: 'none',
                transition: 'color 0.2s',
              }}
              onMouseOver={(e) => (e.currentTarget.style.color = '#cb3837')}
              onMouseOut={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path d="M0 7.334v8h6.666v1.332H12v-1.332h12v-8H0zm10.666 6.666H8v-4H6.666v4H2.667v-5.334h8v5.334zm10.667-1.334h-2.667v2.668H16v-2.668h-2.667v-4h8v4z" />
              </svg>
            </a>
          </div>
        </div>
        <p>Unified CRUD for 16 booking &amp; calendar providers. Interactive API explorer.</p>
      </header>

      {/* ─── Status Bar ─── */}
      <div className="status-bar">
        <div
          className={`status-dot ${selectedProvider ? 'connected' : ''}`}
          role="status"
          aria-label={selectedProvider ? 'Provider selected' : 'No provider selected'}
        />
        <span style={{ color: 'var(--text-secondary)' }}>
          {selectedProvider
            ? `Selected: ${providerInfo?.label ?? selectedProvider}`
            : 'No provider selected — go to Connect tab'}
        </span>
        {selectedProvider && (
          <span className="info-badge accent" style={{ marginLeft: 'auto' }}>
            {selectedProvider}
          </span>
        )}
      </div>

      <div className="main-layout">
        <aside className="sidebar">
          {/* ─── Tabs ─── */}
          <nav className="tabs" role="tablist" aria-label="API Explorer">
            {TABS.map((t, i) => (
              <button
                key={t.id}
                id={`tab-${t.id}`}
                role="tab"
                aria-selected={activeTab === t.id}
                tabIndex={activeTab === t.id ? 0 : -1}
                className={`tab ${activeTab === t.id ? 'active' : ''}`}
                onClick={() => setActiveTab(t.id)}
                onKeyDown={(e) => {
                  let idx = i;
                  if (e.key === 'ArrowRight') idx = (i + 1) % TABS.length;
                  else if (e.key === 'ArrowLeft') idx = (i - 1 + TABS.length) % TABS.length;
                  else return;
                  e.preventDefault();
                  setActiveTab(TABS[idx].id);
                  document.getElementById(`tab-${TABS[idx].id}`)?.focus();
                }}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', padding: '0 0.5rem' }}>
            <a
              href="https://github.com/djlahre0/unibooking"
              target="_blank"
              rel="noreferrer"
              title="GitHub Repository"
              style={{
                color: 'var(--text-secondary)',
                textDecoration: 'none',
                transition: 'color 0.2s',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: '0.8rem',
              }}
              onMouseOver={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
              onMouseOut={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              GitHub
            </a>
            <a
              href="https://www.npmjs.com/package/unibooking"
              target="_blank"
              rel="noreferrer"
              title="npm Package"
              style={{
                color: 'var(--text-secondary)',
                textDecoration: 'none',
                transition: 'color 0.2s',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: '0.8rem',
              }}
              onMouseOver={(e) => (e.currentTarget.style.color = '#cb3837')}
              onMouseOut={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M0 7.334v8h6.666v1.332H12v-1.332h12v-8H0zm10.666 6.666H8v-4H6.666v4H2.667v-5.334h8v5.334zm10.667-1.334h-2.667v2.668H16v-2.668h-2.667v-4h8v4z" />
              </svg>
              npm
            </a>
          </div>
        </aside>

        <main className="content-area">
          {/* ═══ CONNECT TAB ═══ */}
          {activeTab === 'connect' && (
            <ConnectPanel
              selectedProvider={selectedProvider}
              onSelectProvider={(id) => {
                setSelectedProvider(id);
                const saved = loadState().providers[id];
                setCreds(saved?.creds ?? {});
                setEnv(saved?.env ?? 'prod');
                setBaseUrl(saved?.baseUrl ?? ENVIRONMENTS[id]?.prod ?? '');
                setCapsResult(null);
                setBookingResult(null);
                setAvailResult(null);
                setCustomerResult(null);
                setUtilResult(null);
                setWebhookResult(null);
              }}
              creds={creds}
              onCredChange={updateCred}
              capsResult={capsResult}
              onLoadCapabilities={() =>
                wrap('caps', () => getCapabilities(selectedProvider), setCapsResult)
              }
              busy={busy('caps')}
            >
              <EnvironmentControl
                provider={selectedProvider}
                env={env}
                baseUrl={baseUrl}
                onChange={(nextEnv, nextUrl) => {
                  setEnv(nextEnv);
                  setBaseUrl(nextUrl);
                }}
              />
              <PersistenceControls
                remember={remember}
                available={storageOk}
                providerLabel={PROVIDERS[selectedProvider]?.label ?? selectedProvider}
                onToggleRemember={(on) => {
                  setRemember_(on);
                  persistRemember(on); // turning off also wipes what was saved
                }}
                onClearProvider={() => {
                  clearProvider(selectedProvider);
                  setCreds({});
                }}
                onClearAll={() => {
                  if (confirm('Clear saved credentials for every provider on this device?')) {
                    clearAll();
                    setCreds({});
                  }
                }}
              />
            </ConnectPanel>
          )}

          {/* ═══ CAPABILITIES TAB ═══ */}
          {activeTab === 'capabilities' && (
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
                    <code>client.capabilities</code> — typed object that tells you what this
                    provider supports, before you call any method.
                  </p>
                  {!capsResult && (
                    <button
                      className="btn btn-primary"
                      onClick={() =>
                        wrap('caps', () => getCapabilities(selectedProvider), setCapsResult)
                      }
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
                  <ResultBox result={capsResult} label="Raw Response" />
                </div>
              )}
            </div>
          )}

          {/* ═══ BOOKINGS TAB ═══ */}
          {activeTab === 'bookings' && (
            <div className="fade-in">
              {!selectedProvider ? (
                <div className="empty-state">
                  <span className="icon">📅</span>
                  Select a provider in the Connect tab first
                </div>
              ) : (
                <div className="card">
                  <div className="card-title">
                    <span className="icon">📅</span> Booking CRUD — {providerInfo?.label}
                  </div>

                  <div className="op-row">
                    {['create', 'get', 'update', 'cancel', 'list'].map((op) => (
                      <button
                        key={op}
                        className={`btn btn-sm ${bookingOp === op ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => {
                          setBookingOp(op);
                          setBookingResult(null);
                        }}
                      >
                        {op === 'create' && '➕ '}
                        {op === 'get' && '🔍 '}
                        {op === 'update' && '✏️ '}
                        {op === 'cancel' && '🗑 '}
                        {op === 'list' && '📋 '}
                        {op.charAt(0).toUpperCase() + op.slice(1)}
                      </button>
                    ))}
                  </div>

                  {/* Create Booking */}
                  {bookingOp === 'create' && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget);
                        wrap(
                          'booking',
                          () =>
                            callCreateBooking(selectedProvider, conn, {
                              title: fd.get('title') as string,
                              start: fd.get('start') as string,
                              end: fd.get('end') as string,
                              serviceId: (fd.get('serviceId') as string) || undefined,
                              staffId: (fd.get('staffId') as string) || undefined,
                              customerName: (fd.get('customerName') as string) || undefined,
                              customerEmail: (fd.get('customerEmail') as string) || undefined,
                              idempotencyKey: (fd.get('idempotencyKey') as string) || undefined,
                            }),
                          setBookingResult,
                        );
                      }}
                    >
                      <div className="two-col">
                        <div className="form-group">
                          <label className="form-label">Title</label>
                          <input
                            name="title"
                            className="form-input"
                            placeholder="Haircut — Jane"
                            defaultValue="Demo Booking"
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Service ID</label>
                          <input name="serviceId" className="form-input" placeholder="Optional" />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Start (RFC3339)</label>
                          <input
                            name="start"
                            className="form-input"
                            placeholder="2026-07-20T10:00:00-07:00"
                            defaultValue="2026-07-20T10:00:00-07:00"
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">End (RFC3339)</label>
                          <input
                            name="end"
                            className="form-input"
                            placeholder="2026-07-20T10:45:00-07:00"
                            defaultValue="2026-07-20T10:45:00-07:00"
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Staff ID</label>
                          <input name="staffId" className="form-input" placeholder="Optional" />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Idempotency Key</label>
                          <input
                            name="idempotencyKey"
                            className="form-input"
                            placeholder="Optional UUID"
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Customer Name</label>
                          <input
                            name="customerName"
                            className="form-input"
                            placeholder="Jane Doe"
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Customer Email</label>
                          <input
                            name="customerEmail"
                            className="form-input"
                            placeholder="jane@example.com"
                          />
                        </div>
                      </div>
                      <button
                        className="btn btn-primary"
                        type="submit"
                        disabled={busy('booking')}
                        style={{ marginTop: '1rem' }}
                      >
                        {busy('booking') ? '...' : '➕ Create Booking'}
                      </button>
                    </form>
                  )}

                  {/* Get Booking */}
                  {bookingOp === 'get' && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget);
                        wrap(
                          'booking',
                          () =>
                            callGetBooking(selectedProvider, conn, fd.get('bookingId') as string),
                          setBookingResult,
                        );
                      }}
                    >
                      <div className="form-group">
                        <label className="form-label">Booking ID</label>
                        <input
                          name="bookingId"
                          className="form-input"
                          placeholder="Enter booking ID"
                          required
                        />
                      </div>
                      <button className="btn btn-primary" type="submit" disabled={busy('booking')}>
                        {busy('booking') ? '...' : '🔍 Get Booking'}
                      </button>
                    </form>
                  )}

                  {/* Update Booking */}
                  {bookingOp === 'update' && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget);
                        wrap(
                          'booking',
                          () =>
                            callUpdateBooking(
                              selectedProvider,
                              conn,
                              fd.get('bookingId') as string,
                              {
                                title: (fd.get('title') as string) || undefined,
                                start: (fd.get('start') as string) || undefined,
                                end: (fd.get('end') as string) || undefined,
                                staffId: (fd.get('staffId') as string) || undefined,
                                serviceId: (fd.get('serviceId') as string) || undefined,
                              },
                            ),
                          setBookingResult,
                        );
                      }}
                    >
                      <div className="two-col">
                        <div className="form-group">
                          <label className="form-label">Booking ID</label>
                          <input
                            name="bookingId"
                            className="form-input"
                            placeholder="ID to update"
                            required
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">New Title</label>
                          <input name="title" className="form-input" placeholder="Optional" />
                        </div>
                        <div className="form-group">
                          <label className="form-label">New Start</label>
                          <input
                            name="start"
                            className="form-input"
                            placeholder="Optional RFC3339"
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">New End</label>
                          <input name="end" className="form-input" placeholder="Optional RFC3339" />
                        </div>
                        <div className="form-group">
                          <label className="form-label">New Staff ID</label>
                          <input name="staffId" className="form-input" placeholder="Optional" />
                        </div>
                        <div className="form-group">
                          <label className="form-label">New Service ID</label>
                          <input name="serviceId" className="form-input" placeholder="Optional" />
                        </div>
                      </div>
                      <button
                        className="btn btn-primary"
                        type="submit"
                        disabled={busy('booking')}
                        style={{ marginTop: '1rem' }}
                      >
                        {busy('booking') ? '...' : '✏️ Update Booking'}
                      </button>
                    </form>
                  )}

                  {/* Cancel Booking */}
                  {bookingOp === 'cancel' && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget);
                        wrap(
                          'booking',
                          () =>
                            callCancelBooking(
                              selectedProvider,
                              conn,
                              fd.get('bookingId') as string,
                              (fd.get('reason') as string) || undefined,
                            ),
                          setBookingResult,
                        );
                      }}
                    >
                      <div className="two-col">
                        <div className="form-group">
                          <label className="form-label">Booking ID</label>
                          <input
                            name="bookingId"
                            className="form-input"
                            placeholder="ID to cancel"
                            required
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Reason</label>
                          <input
                            name="reason"
                            className="form-input"
                            placeholder="Optional cancellation reason"
                          />
                        </div>
                      </div>
                      <button
                        className="btn btn-primary"
                        type="submit"
                        disabled={busy('booking')}
                        style={{ marginTop: '1rem' }}
                      >
                        {busy('booking') ? '...' : '🗑 Cancel Booking'}
                      </button>
                    </form>
                  )}

                  {/* List Bookings */}
                  {bookingOp === 'list' && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget);
                        wrap(
                          'booking',
                          () =>
                            callListBookings(selectedProvider, conn, {
                              start: fd.get('start') as string,
                              end: fd.get('end') as string,
                              limit: (fd.get('limit') as string)
                                ? Number(fd.get('limit'))
                                : undefined,
                              pageToken: (fd.get('pageToken') as string) || undefined,
                            }),
                          setBookingResult,
                        );
                      }}
                    >
                      <div className="two-col">
                        <div className="form-group">
                          <label className="form-label">Start (RFC3339)</label>
                          <input
                            name="start"
                            className="form-input"
                            defaultValue="2026-07-20T00:00:00-07:00"
                            required
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">End (RFC3339)</label>
                          <input
                            name="end"
                            className="form-input"
                            defaultValue="2026-07-27T00:00:00-07:00"
                            required
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Limit</label>
                          <input
                            name="limit"
                            className="form-input"
                            placeholder="Optional page size"
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Page Token</label>
                          <input
                            name="pageToken"
                            className="form-input"
                            placeholder="Optional (from prev response)"
                          />
                        </div>
                      </div>
                      <button
                        className="btn btn-primary"
                        type="submit"
                        disabled={busy('booking')}
                        style={{ marginTop: '1rem' }}
                      >
                        {busy('booking') ? '...' : '📋 List Bookings'}
                      </button>
                    </form>
                  )}

                  <ResultBox result={bookingResult} label={`${bookingOp} result`} />
                </div>
              )}
            </div>
          )}

          {/* ═══ AVAILABILITY TAB ═══ */}
          {activeTab === 'availability' && (
            <div className="fade-in">
              {!selectedProvider ? (
                <div className="empty-state">
                  <span className="icon">🕐</span>
                  Select a provider in the Connect tab first
                </div>
              ) : (
                <div className="card">
                  <div className="card-title">
                    <span className="icon">🕐</span> Search Availability — {providerInfo?.label}
                  </div>
                  <p
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '0.82rem',
                      marginBottom: '1rem',
                    }}
                  >
                    <code>client.searchAvailability(query)</code> — only works when{' '}
                    <code>capabilities.availability</code> is <code>true</code>
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const fd = new FormData(e.currentTarget);
                      wrap(
                        'avail',
                        () =>
                          callSearchAvailability(selectedProvider, conn, {
                            start: fd.get('start') as string,
                            end: fd.get('end') as string,
                            timezone: (fd.get('timezone') as string) || undefined,
                            serviceId: (fd.get('serviceId') as string) || undefined,
                            staffId: (fd.get('staffId') as string) || undefined,
                          }),
                        setAvailResult,
                      );
                    }}
                  >
                    <div className="two-col">
                      <div className="form-group">
                        <label className="form-label">Start (RFC3339)</label>
                        <input
                          name="start"
                          className="form-input"
                          defaultValue="2026-07-20T00:00:00-07:00"
                          required
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">End (RFC3339)</label>
                        <input
                          name="end"
                          className="form-input"
                          defaultValue="2026-07-21T00:00:00-07:00"
                          required
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Service ID</label>
                        <input name="serviceId" className="form-input" placeholder="Optional" />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Staff ID</label>
                        <input name="staffId" className="form-input" placeholder="Optional" />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Timezone (IANA)</label>
                        <input
                          name="timezone"
                          className="form-input"
                          placeholder="Required by Setmore and Wix"
                        />
                      </div>
                    </div>
                    <button
                      className="btn btn-primary"
                      type="submit"
                      disabled={busy('avail')}
                      style={{ marginTop: '1rem' }}
                    >
                      {busy('avail') ? '...' : '🔍 Search Slots'}
                    </button>
                  </form>
                  <ResultBox result={availResult} label="Availability" />
                </div>
              )}
            </div>
          )}

          {/* ═══ CUSTOMERS TAB ═══ */}
          {activeTab === 'customers' && (
            <div className="fade-in">
              {!selectedProvider ? (
                <div className="empty-state">
                  <span className="icon">👤</span>
                  Select a provider in the Connect tab first
                </div>
              ) : (
                <div className="card">
                  <div className="card-title">
                    <span className="icon">👤</span> Customer Management — {providerInfo?.label}
                  </div>
                  <p
                    style={{
                      color: 'var(--text-secondary)',
                      fontSize: '0.82rem',
                      marginBottom: '1rem',
                    }}
                  >
                    <code>client.customers?.findOrCreate(customer)</code> — only when{' '}
                    <code>capabilities.customers</code> is <code>true</code>
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const fd = new FormData(e.currentTarget);
                      wrap(
                        'customer',
                        () =>
                          callFindOrCreateCustomer(selectedProvider, conn, {
                            name: (fd.get('name') as string) || undefined,
                            email: (fd.get('email') as string) || undefined,
                            phone: (fd.get('phone') as string) || undefined,
                          }),
                        setCustomerResult,
                      );
                    }}
                  >
                    <div className="two-col">
                      <div className="form-group">
                        <label className="form-label">Name</label>
                        <input
                          name="name"
                          className="form-input"
                          placeholder="Jane Doe"
                          defaultValue="Jane Doe"
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Email</label>
                        <input
                          name="email"
                          className="form-input"
                          placeholder="jane@example.com"
                          defaultValue="jane@example.com"
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Phone</label>
                        <input name="phone" className="form-input" placeholder="+1555..." />
                      </div>
                    </div>
                    <button
                      className="btn btn-primary"
                      type="submit"
                      disabled={busy('customer')}
                      style={{ marginTop: '1rem' }}
                    >
                      {busy('customer') ? '...' : '👤 Find or Create'}
                    </button>
                  </form>
                  <ResultBox result={customerResult} label="Customer" />
                </div>
              )}
            </div>
          )}

          {/* ═══ UTILITIES TAB ═══ */}
          {activeTab === 'utilities' && (
            <div className="fade-in">
              <div className="card" style={{ marginBottom: '1rem' }}>
                <div className="card-title">
                  <span className="icon">🛠</span> Core Utilities
                </div>
                <div className="feature-list">
                  <div className="feature-item">
                    <span className="icon">🔄</span>
                    <div>
                      <h4>createRegistry</h4>
                      <p>
                        Dynamic dispatch: register adapters and look them up by{' '}
                        <code>ProviderId</code>. Methods: <code>get</code>, <code>tryGet</code>,{' '}
                        <code>has</code>, <code>ids</code>.
                      </p>
                    </div>
                  </div>
                  <div className="feature-item">
                    <span className="icon">🔁</span>
                    <div>
                      <h4>withRetry</h4>
                      <p>
                        Wrap a client for exponential backoff on transient errors. Honors{' '}
                        <code>retryAfterMs</code> from RATE_LIMIT. Safe for creates only with{' '}
                        <code>idempotencyKey</code>.
                      </p>
                    </div>
                  </div>
                  <div className="feature-item">
                    <span className="icon">📄</span>
                    <div>
                      <h4>listAll / collectAll</h4>
                      <p>
                        Auto-paginate <code>listBookings</code> across every page.{' '}
                        <code>listAll</code> yields via AsyncGenerator; <code>collectAll</code>{' '}
                        returns an array.
                      </p>
                    </div>
                  </div>
                  <div className="feature-item">
                    <span className="icon">⚠️</span>
                    <div>
                      <h4>Error Helpers</h4>
                      <p>
                        <code>isUnibookingError</code>, <code>isRetryable</code>,{' '}
                        <code>codeForStatus</code> — discriminate and map errors consistently.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card" style={{ marginBottom: '1rem' }}>
                <div className="card-title">Try Them</div>
                <div className="op-row">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => wrap('util', () => demoRegistry(), setUtilResult)}
                    disabled={busy('util')}
                  >
                    🔄 createRegistry
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => wrap('util', () => demoErrorHelpers(), setUtilResult)}
                    disabled={busy('util')}
                  >
                    ⚠️ Error Helpers
                  </button>
                  {selectedProvider && (
                    <>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() =>
                          wrap(
                            'util',
                            () =>
                              demoWithRetry(selectedProvider, conn, {
                                start: '2026-07-20T00:00:00Z',
                                end: '2026-07-27T00:00:00Z',
                              }),
                            setUtilResult,
                          )
                        }
                        disabled={busy('util')}
                      >
                        🔁 withRetry
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() =>
                          wrap(
                            'util',
                            () =>
                              demoCollectAll(selectedProvider, conn, {
                                start: '2026-07-20T00:00:00Z',
                                end: '2026-07-27T00:00:00Z',
                              }),
                            setUtilResult,
                          )
                        }
                        disabled={busy('util')}
                      >
                        📄 collectAll
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() =>
                          wrap(
                            'util',
                            () =>
                              demoListAll(selectedProvider, conn, {
                                start: '2026-07-20T00:00:00Z',
                                end: '2026-07-27T00:00:00Z',
                              }),
                            setUtilResult,
                          )
                        }
                        disabled={busy('util')}
                      >
                        📄 listAll
                      </button>
                    </>
                  )}
                </div>
                {!selectedProvider && (
                  <p
                    style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.5rem' }}
                  >
                    ℹ️ Connect to a provider to unlock withRetry, collectAll, and listAll demos.
                  </p>
                )}
                <ResultBox result={utilResult} label="Utility Result" />
              </div>
            </div>
          )}

          {/* ═══ WEBHOOKS TAB ═══ */}
          {activeTab === 'webhooks' && (
            <div className="fade-in">
              <div className="card">
                <div className="card-title">
                  <span className="icon">🔔</span> Webhook Verification
                </div>
                <p
                  style={{
                    color: 'var(--text-secondary)',
                    fontSize: '0.82rem',
                    marginBottom: '1rem',
                  }}
                >
                  9 webhook verifiers — paste the raw payload + signature to verify.
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
                    <div className="section-title">
                      {WEBHOOK_PROVIDERS[webhookProvider].label} Fields
                    </div>
                    {WEBHOOK_PROVIDERS[webhookProvider].fields.map((f) => (
                      <div className="form-group" key={f.key}>
                        <label className="form-label">{f.label}</label>
                        {f.multiline ? (
                          <textarea
                            className="form-textarea"
                            placeholder={f.placeholder}
                            value={webhookFields[f.key] ?? ''}
                            onChange={(e) =>
                              setWebhookFields((prev) => ({ ...prev, [f.key]: e.target.value }))
                            }
                          />
                        ) : (
                          <input
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
                      {busy('webhook') ? '...' : '🔐 Verify Signature'}
                    </button>
                  </form>
                )}

                <ResultBox result={webhookResult} label="Webhook Verification" />
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
