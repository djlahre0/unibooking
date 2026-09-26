'use client';

import { useState } from 'react';
import type { ActionResult, Connection } from '../lib/call';
import { ENVIRONMENTS } from '../lib/environments';
import { PROVIDER_META as PROVIDERS, isDirect, isLocal, type CredField } from '../lib/providers';
import { connectUrl, disconnect } from '../lib/calendar/api';
import type { CalendarStatus } from '../lib/calendar/types';
import CustomAppForm from './calendar/CustomAppForm';
import AppleConnectCard from './calendar/AppleConnectCard';
import ResetSetupButton from './calendar/ResetSetupButton';
import ResultBox from './ResultBox';
import ConnectionCheck from './ConnectionCheck';
import { pickerGroups, providerHint } from '../lib/provider-picker';
import { ExternalIcon, FlaskIcon, LockIcon, ResetIcon, ShieldIcon } from './components/icons';

/* ─── Trust-model banner: shows where the visitor's token actually goes ───
   The three original states are kept byte-for-byte -- it is a security claim.
   `signedIn` is the one new state this task adds: for a visitor connected via
   My Calendar, "your token never leaves this browser" would now be FALSE --
   the token lives server-side in the sealed session cookie and the call runs
   there too. Saying so accurately is the whole point of this banner. */
function TrustBanner({ provider, signedIn }: { provider: string; signedIn?: boolean }) {
  const local = isLocal(provider);
  const direct = isDirect(provider);
  // Theme tokens, so the banner follows light and dark mode like every other
  // surface. The tone is the same one the sidebar uses for where a call runs.
  const tone = local || signedIn ? 'indigo' : direct ? 'pine' : 'amber';
  const palette = {
    border: `color-mix(in srgb, var(--${tone}) 35%, transparent)`,
    background: `var(--${tone}-wash)`,
    color: 'var(--ink)',
  };
  const style: React.CSSProperties = {
    borderRadius: '8px',
    padding: '0.7rem 0.85rem',
    margin: '0.9rem 0 0.4rem',
    fontSize: '0.78rem',
    lineHeight: 1.6,
    border: `1px solid ${palette.border}`,
    background: palette.background,
    color: palette.color,
  };
  return (
    <div style={style} role="note">
      {local ? (
        <>
          <FlaskIcon size={15} /> <strong>Sample data: your data never leaves this browser.</strong>{' '}
          No account needed: this provider runs entirely on your device against data kept in this
          page&apos;s local storage, and makes no request to anyone.
        </>
      ) : signedIn ? (
        <>
          <LockIcon size={15} />{' '}
          <strong>Signed in: this call runs on the server, not your browser.</strong> Your token is
          sealed in an HttpOnly session cookie from My Calendar; this page&apos;s JavaScript can
          never read it, and it is never sent here.
        </>
      ) : direct ? (
        <>
          <ShieldIcon size={15} /> <strong>Your token never leaves this browser.</strong> It is sent
          directly from your machine to the provider&apos;s API: this demo&apos;s server is never
          involved.
        </>
      ) : (
        <>
          <ExternalIcon size={15} /> <strong>This provider blocks browser calls</strong>, so your
          credentials are sent to the demo&apos;s server, forwarded to the provider, and discarded.
          They are never stored on the demo&apos;s server, and never logged.{' '}
          <span style={{ color: 'var(--text-muted, #8888a0)' }}>
            This is exactly why unibooking runs server-side.
          </span>
        </>
      )}
    </div>
  );
}

/** Narrows to the two providers My Calendar can sign into inline here. Apple
 *  keeps its own paste flow (an app-specific password, not a token) and is
 *  reached only via the "Use My Calendar" link below, unchanged. */
function oauthProviderOf(id: string): 'google' | 'outlook' | null {
  return id === 'google' || id === 'outlook' ? id : null;
}

const OAUTH_LABEL: Record<'google' | 'outlook', string> = {
  google: 'Google',
  outlook: 'Microsoft',
};

/* ─── One credential field: label, input, and the "where this comes from"
   line the guided flow is built around. `help` is doc-sourced (see
   lib/providers.ts); when a field has none, its own placeholder stands in
   for that line rather than leaving the visitor with no source at all. ─── */
function CredFieldRow({
  field,
  value,
  onChange,
}: {
  field: CredField;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputId = `cred-${field.key}`;
  const helpId = `${inputId}-help`;
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={inputId}>
        {field.label}
      </label>
      <input
        id={inputId}
        className="form-input"
        type={field.secret === false ? 'text' : 'password'}
        placeholder={field.placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={helpId}
        // `advanced` is the source of truth wherever it's been set (audited
        // against docs/PROVIDERS.md -- see providers.ts). Fields nobody has
        // audited yet keep the old placeholder-text heuristic rather than
        // silently flipping to "required".
        required={field.advanced ? false : !field.placeholder.toLowerCase().includes('optional')}
      />
      <p className="field-help" id={helpId}>
        {field.help ?? field.placeholder}
        {field.helpHref ? (
          <>
            {' '}
            <a href={field.helpHref} target="_blank" rel="noreferrer">
              {field.helpHref}
            </a>
          </>
        ) : null}
      </p>
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
  /** How long the last "Load capabilities" call took, measured in page.tsx's
   *  `wrap` with performance.now(). Not part of ActionResult -- see
   *  ResultBox's own doc comment on the same prop. */
  capsElapsedMs?: number;
  /** Switch to the My Calendar tab (sign-in instead of pasted tokens). */
  onOpenCalendar?: () => void;
  /** Restores the sample dataset to its seeded state. Absent means no reset
   *  control is offered (e.g. a caller that doesn't wire it up). */
  onResetSample?: () => void;
  /** Who (if anyone) is signed in via My Calendar, and which of google/outlook
   *  this deployment even offers. Undefined/null -- e.g. the unit tests, which
   *  never fetch /api/calendar/status -- folds back to today's unchanged paste
   *  flow, the same as "not configured". */
  calendarStatus?: CalendarStatus | null;
  /** Called after a successful Disconnect so the parent can refetch status --
   *  which, via Connection.signedIn in call.ts, is what makes the explorer
   *  tabs fall back to the pasted-credential transport immediately. */
  onDisconnected?: () => void;
  /** Called after the operator's one-time OAuth app setup form saves
   *  successfully, so the parent can refetch status -- which is what makes
   *  this panel switch from the setup form to the "Continue with…" button.
   *  Only ever invoked from a localhost visitor: the setup form itself is
   *  gated on `calendarStatus.isLocalhost` above. */
  onCalendarConfigChanged?: () => void;
  /** Rendered inside the "Advanced" disclosure (collapsed by default),
   *  alongside any of the provider's own fields marked `advanced` --
   *  currently just the Environment control, which page.tsx supplies here
   *  instead of via `children` so it moves with the fields it belongs next
   *  to rather than always sitting in the open. */
  advancedChildren?: React.ReactNode;
  /** The connection the explorer tabs will use. When given, step 3 offers a
   *  real "Test connection" round trip; absent (e.g. older tests), only the
   *  static capabilities lookup is shown. */
  conn?: Connection;
  /** The Environment control's value, for the sandbox/production hint. */
  env?: string;
  children?: React.ReactNode;
};

/** Providers My Calendar can connect by signing in instead of pasting tokens. */
const SIGN_IN_PROVIDERS = new Set(['google', 'outlook', 'apple']);

export default function ConnectPanel({
  selectedProvider,
  onSelectProvider,
  creds,
  onCredChange,
  capsResult,
  onLoadCapabilities,
  busy,
  capsElapsedMs,
  onOpenCalendar,
  onResetSample,
  calendarStatus,
  onDisconnected,
  onCalendarConfigChanged,
  advancedChildren,
  conn,
  env = 'prod',
  children,
}: ConnectPanelProps) {
  const providerInfo = selectedProvider ? PROVIDERS[selectedProvider] : null;
  const fields = providerInfo?.fields ?? [];
  // Split by `secret` so the token(s) always come first, in step 1, no
  // matter where they sit in the provider's own field order -- Vagaro, for
  // instance, lists its token last because that's the order its own API
  // issues the values in. Within each group, `advanced` (a working default,
  // or genuinely optional -- see providers.ts) further splits off what goes
  // behind the "Advanced" disclosure instead of showing up front.
  const tokenFields = fields.filter((f) => f.secret !== false && !f.advanced);
  const advancedTokenFields = fields.filter((f) => f.secret !== false && f.advanced);
  const idFields = fields.filter((f) => f.secret === false && !f.advanced);
  const advancedIdFields = fields.filter((f) => f.secret === false && f.advanced);

  const oauthProvider = oauthProviderOf(selectedProvider);
  const calendarConfigured =
    oauthProvider !== null &&
    !!calendarStatus?.enabled &&
    !!calendarStatus.providers[oauthProvider];
  // SESSION_SECRET is set (sealing is possible) and this is a provider My
  // Calendar signs into inline -- enough to show either the sign-in button
  // (once an app is configured) or the operator's setup form (localhost only,
  // below); the one-click button itself still needs an app either from env or
  // from that setup form.
  const oauthSignInAvailable = oauthProvider !== null && !!calendarStatus?.enabled;
  const connection = calendarStatus?.connection ?? null;
  const signedInHere = oauthProvider !== null && connection?.provider === oauthProvider;
  const who = connection
    ? (connection.account.email ?? connection.account.name ?? 'Connected account')
    : '';
  // Required fields still empty. Signed in via My Calendar, the session
  // supplies the token, so only the ids count.
  const missing = [...(signedInHere ? [] : tokenFields), ...idFields]
    .filter((f) => !(creds[f.key] ?? '').trim())
    .map((f) => f.label);
  const hasSandbox = !!ENVIRONMENTS[selectedProvider]?.sandbox;
  const [disconnecting, setDisconnecting] = useState(false);
  async function handleDisconnect() {
    setDisconnecting(true);
    await disconnect();
    setDisconnecting(false);
    onDisconnected?.();
  }

  return (
    <div className="fade-in">
      <div className="card">
        {/* The first-visit chooser: every provider grouped by what it is. Once
            one is chosen, the sidebar picker is where you switch, so the grid
            steps aside and this card is just the connect form. */}
        {!providerInfo && (
          <>
            <div className="card-title">Choose a provider</div>
            <p className="cal-muted" style={{ marginTop: 0 }}>
              Start with Sample Data to try everything without an account. You can switch providers
              any time from the sidebar.
            </p>
            {pickerGroups().map((group) => (
              <section key={group.heading} className="provider-group" aria-label={group.heading}>
                <div className="provider-group-head">
                  <h3 className="provider-group-title">{group.heading}</h3>
                  {group.blurb ? <p className="provider-group-blurb">{group.blurb}</p> : null}
                </div>
                <div className="provider-grid">
                  {group.ids.map((id) => (
                    <button
                      key={id}
                      className={`provider-chip ${selectedProvider === id ? 'selected' : ''}`}
                      aria-pressed={selectedProvider === id}
                      onClick={() => onSelectProvider(id)}
                    >
                      <span className="provider-chip-name">{PROVIDERS[id]!.label}</span>
                      <span className="provider-chip-hint">{providerHint(id)}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </>
        )}

        {providerInfo && (
          <>
            <div className="card-title">Connect {providerInfo.label}</div>
            <TrustBanner provider={selectedProvider} signedIn={signedInHere} />
            {onOpenCalendar &&
            SIGN_IN_PROVIDERS.has(selectedProvider) &&
            !calendarConfigured &&
            !oauthSignInAvailable ? (
              <p className="cal-muted">
                Prefer signing in over pasting tokens?{' '}
                <button type="button" className="cal-link" onClick={onOpenCalendar}>
                  Use My Calendar
                </button>{' '}
                to connect and manage events with your {providerInfo.label} account.
              </p>
            ) : null}

            {/* Google/Outlook: lead with sign-in ahead of the paste flow below
                it. Once signed in, show the connected account. Not signed in
                yet: the sign-in button once an app is configured (from env or
                the operator's own saved setup -- the two are indistinguishable
                here, both just mean "configured"); a localhost visitor sees
                the one-time setup form instead when nothing is configured yet;
                any other visitor is just told the deployment hasn't set it up
                -- never asked for credentials that aren't theirs to give.
                SESSION_SECRET itself missing disables sign-in entirely, for
                everyone. Any other provider sees none of this and falls
                straight through to the unchanged step flow below. */}
            {oauthProvider ? (
              signedInHere ? (
                <div className="cal-header" style={{ margin: '0.9rem 0 0.4rem' }}>
                  <div>
                    <div className="cal-account">{who}</div>
                    <div className="cal-muted" style={{ margin: 0 }}>
                      Signed in via My Calendar
                      {connection?.custom ? ': your own OAuth app' : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleDisconnect()}
                    disabled={disconnecting}
                  >
                    {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                </div>
              ) : oauthSignInAvailable ? (
                <div style={{ margin: '0.9rem 0 0.4rem' }}>
                  {calendarConfigured ? (
                    <div className="cal-signin-row">
                      <a className="btn btn-primary" href={connectUrl(oauthProvider)}>
                        Continue with {OAUTH_LABEL[oauthProvider]}
                      </a>
                      {calendarStatus?.isLocalhost ? (
                        <ResetSetupButton
                          provider={oauthProvider}
                          label={OAUTH_LABEL[oauthProvider]}
                          onReset={() => onCalendarConfigChanged?.()}
                        />
                      ) : null}
                    </div>
                  ) : calendarStatus?.isLocalhost ? (
                    <>
                      <p className="cal-muted" style={{ marginTop: 0 }}>
                        Set up {OAUTH_LABEL[oauthProvider]} sign-in once for every visitor: register
                        the redirect URL below with your own OAuth app, then save its client ID and
                        secret here.
                      </p>
                      <CustomAppForm
                        provider={oauthProvider}
                        label={OAUTH_LABEL[oauthProvider]}
                        onSaved={() => onCalendarConfigChanged?.()}
                      />
                    </>
                  ) : (
                    <p className="cal-muted" style={{ marginTop: 0 }}>
                      This deployment hasn&apos;t set up {OAUTH_LABEL[oauthProvider]} sign-in yet.
                    </p>
                  )}
                </div>
              ) : calendarStatus ? (
                <p className="cal-muted" style={{ margin: '0.9rem 0 0.4rem' }}>
                  Sign-in isn&apos;t available on this deployment
                  {calendarStatus.problem ? ` (${calendarStatus.problem})` : ''}.
                </p>
              ) : null
            ) : null}

            {/* Apple's connect form. Apple offers third parties no OAuth for
                calendars, so there is no "Continue with…" button to show in
                the branch above -- an app-specific password is the whole
                flow. It renders here because connecting happens on this tab
                for every provider; My Calendar only shows what is already
                connected. Signed in already: nothing to offer. */}
            {selectedProvider === 'apple' &&
            calendarStatus?.enabled &&
            connection?.provider !== 'apple' ? (
              <div style={{ margin: '0.9rem 0 0.4rem' }}>
                <AppleConnectCard
                  onConnected={() => {
                    onCalendarConfigChanged?.();
                    onOpenCalendar?.();
                  }}
                />
              </div>
            ) : null}

            {/* Above the steps, and outside the isLocal branch below, so what
                this browser has saved is stated before anything is typed into
                it rather than discovered underneath the fields -- and so the
                sample provider gets its "Clear all saved" too. */}
            {children}

            {isLocal(selectedProvider) ? (
              <div className="creds-form">
                <p className="cal-muted">
                  Everything below works right away. Create, edit and cancel bookings: the changes
                  are saved on this device and survive a reload.
                </p>
                {onResetSample ? (
                  <button type="button" className="btn" onClick={onResetSample}>
                    <ResetIcon /> Reset sample data
                  </button>
                ) : null}
              </div>
            ) : (
              // Connecting genuinely is a sequence -- get the token, enter the
              // ids it needs, run a call -- so numbering it is earned here
              // (design-system.md is explicit that nowhere else should be).
              <ol className="connect-steps">
                {/* Signed in via My Calendar: the token step is no longer the
                    visitor's job (the session cookie already has it), so it's
                    dropped rather than shown-but-pointless. The CSS counter
                    that numbers these steps is tied to rendered <li>s, not a
                    hardcoded digit, so "Enter the ids" correctly becomes step
                    one instead of leaving a gap. */}
                {!signedInHere && (
                  <li className="connect-step">
                    <div className="connect-step-body">
                      <h3 className="connect-step-title">Get the token</h3>
                      {tokenFields.length > 0 ? (
                        <div className="creds-form">
                          {tokenFields.map((f) => (
                            <CredFieldRow
                              key={f.key}
                              field={f}
                              value={creds[f.key] ?? ''}
                              onChange={(v) => onCredChange(f.key, v)}
                            />
                          ))}
                        </div>
                      ) : advancedTokenFields.length === 0 ? (
                        <p className="cal-muted">
                          This provider has no separate token: the ids in the next step are all it
                          needs.
                        </p>
                      ) : null}
                    </div>
                  </li>
                )}
                <li className="connect-step">
                  <div className="connect-step-body">
                    <h3 className="connect-step-title">Enter the ids it needs</h3>
                    {idFields.length > 0 ? (
                      <div className="creds-form">
                        {idFields.map((f) => (
                          <CredFieldRow
                            key={f.key}
                            field={f}
                            value={creds[f.key] ?? ''}
                            onChange={(v) => onCredChange(f.key, v)}
                          />
                        ))}
                      </div>
                    ) : advancedIdFields.length === 0 ? (
                      <p className="cal-muted">
                        No additional ids: the token above is everything this provider needs.
                      </p>
                    ) : null}

                    {/* Fields with a working default (e.g. Google's calendarId,
                        which defaults to 'primary') plus the Environment
                        control -- collapsed by default so step 2 shows only
                        what genuinely must be filled in. Rendered only when
                        there's something to put in it, so a provider with no
                        advanced fields (every provider except Google/Outlook
                        today) and no Environment control (the sample
                        provider) shows no empty disclosure. */}
                    {advancedTokenFields.length > 0 ||
                    advancedIdFields.length > 0 ||
                    advancedChildren ? (
                      <details className="connect-advanced">
                        <summary>Advanced</summary>
                        {advancedTokenFields.length > 0 || advancedIdFields.length > 0 ? (
                          <div className="creds-form">
                            {[...advancedTokenFields, ...advancedIdFields].map((f) => (
                              <CredFieldRow
                                key={f.key}
                                field={f}
                                value={creds[f.key] ?? ''}
                                onChange={(v) => onCredChange(f.key, v)}
                              />
                            ))}
                          </div>
                        ) : null}
                        {advancedChildren}
                      </details>
                    ) : null}
                  </div>
                </li>
                <li className="connect-step">
                  <div className="connect-step-body">
                    <h3 className="connect-step-title">
                      {conn ? 'Test the connection' : 'Run a call'}
                    </h3>
                    {conn ? (
                      <ConnectionCheck
                        providerId={selectedProvider}
                        conn={conn}
                        missing={missing}
                        env={env}
                        hasSandbox={hasSandbox}
                      />
                    ) : null}
                    {/* Capabilities come from a static table and never touch
                        the provider, so they prove nothing about the token;
                        secondary once a real test is on offer. */}
                    <button
                      className={`btn ${conn ? 'btn-secondary btn-sm' : 'btn-primary'}`}
                      onClick={onLoadCapabilities}
                      disabled={busy}
                      style={conn ? { marginTop: '0.75rem' } : undefined}
                    >
                      {busy ? '...' : 'Load capabilities'}
                    </button>
                    {capsResult ? (
                      <ResultBox
                        result={capsResult}
                        label="Capabilities"
                        elapsedMs={capsElapsedMs}
                      />
                    ) : null}
                  </div>
                </li>
              </ol>
            )}
          </>
        )}
      </div>
    </div>
  );
}
