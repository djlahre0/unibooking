'use client';

import { useState } from 'react';
import { connectApple, connectUrl } from '../../lib/calendar/api';
import type { CalendarStatus, OAuthProvider } from '../../lib/calendar/types';
import CustomAppForm from './CustomAppForm';

const OAUTH_CARDS: Array<{
  id: OAuthProvider;
  icon: string;
  title: string;
  /** Short form used in "Continue with your ___ app" and similar prose --
   *  `title` above is the full provider name, too long for that sentence. */
  shortLabel: string;
  blurb: string;
  cta: string;
}> = [
  {
    id: 'google',
    icon: '🟦',
    title: 'Google Calendar',
    shortLabel: 'Google',
    blurb: 'Sign in with your Google account. You will be asked to allow calendar access.',
    cta: 'Continue with Google',
  },
  {
    id: 'outlook',
    icon: '🟧',
    title: 'Outlook / Microsoft 365',
    shortLabel: 'Microsoft',
    blurb: 'Sign in with a work, school or personal Microsoft account.',
    cta: 'Continue with Microsoft',
  },
];

/** Shown only when this deployment's cookie-sealing key genuinely failed its
 *  own length check -- not a normal state. The demo needs no environment
 *  variables to offer sign-in: a key is generated on first use (or read from
 *  an optional `SESSION_SECRET` override), so this should not appear on a
 *  fresh clone. Aimed at the person who deployed the demo, not at a visitor. */
function SetupNotice({ problem }: { problem?: string }) {
  return (
    <div className="card">
      <div className="card-title">
        <span className="icon">🛠</span> My Calendar is not set up on this deployment
      </div>
      <p className="cal-muted">
        {problem ?? 'Configuration is missing'}. This is unexpected -- see the My Calendar section
        of <code>demo/README.md</code> for the (optional) <code>SESSION_SECRET</code> override this
        points at. The other tabs work without any of this.
      </p>
    </div>
  );
}

function AppleCard({ onConnected }: { onConnected: () => void }) {
  const [appleId, setAppleId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  return (
    <form
      className="cal-connect-card"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        const res = await connectApple(appleId, password);
        setBusy(false);
        if (res.ok) {
          setPassword('');
          onConnected();
        } else {
          setError(res.error?.message ?? 'Could not connect.');
        }
      }}
    >
      <div className="cal-connect-head">
        <span aria-hidden="true">⬜</span> Apple iCloud
      </div>
      <p className="cal-muted">
        Apple uses an <strong>app-specific password</strong> instead of a sign-in button. Create one
        at{' '}
        <a href="https://appleid.apple.com/account/manage" target="_blank" rel="noreferrer">
          appleid.apple.com
        </a>{' '}
        → Sign-In and Security → App-Specific Passwords, then paste it here.
      </p>
      <div className="form-group">
        <label className="form-label" htmlFor="apple-appleid">
          Apple ID
        </label>
        <input
          id="apple-appleid"
          name="apple-appleid"
          className="form-input"
          type="email"
          // Provider-scoped name/id, and "off" rather than "username" -- a
          // saved-login hint is exactly what let the browser's password
          // manager fill Google's client ID into this field (see the bug
          // this fixes): every card's non-secret fields now opt out alike.
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          placeholder="you@icloud.com"
          value={appleId}
          onChange={(e) => setAppleId(e.target.value)}
        />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="apple-password">
          App-specific password
        </label>
        <input
          id="apple-password"
          name="apple-password"
          className="form-input"
          type="password"
          // "new-password", not "current-password" -- the reliable way to
          // stop a password manager offering a saved credential here (see the
          // bug this fixes: a secret was being filled into every card alike).
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="off"
          placeholder="xxxx-xxxx-xxxx-xxxx"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error ? (
        <div className="cal-banner error" role="alert">
          {error}
        </div>
      ) : null}
      <button className="btn btn-primary" type="submit" disabled={busy || !appleId || !password}>
        {busy ? 'Connecting…' : 'Connect iCloud'}
      </button>
    </form>
  );
}

export default function ConnectCards({
  status,
  onConnected,
  onAppSaved,
}: {
  status: CalendarStatus;
  onConnected: () => void;
  /** Called after the operator's one-time OAuth app setup form saves
   *  successfully, so the caller can refetch status -- which is what makes
   *  this card switch from the setup form to the "Continue with…" button.
   *  Only ever invoked from a localhost visitor: the setup form itself is
   *  gated on `status.isLocalhost` below. */
  onAppSaved: (provider: OAuthProvider) => void;
}) {
  if (!status.enabled)
    return <SetupNotice {...(status.problem ? { problem: status.problem } : {})} />;

  return (
    <div className="card">
      <div className="card-title">Connect your calendar</div>
      <p className="cal-muted">
        Sign in once and manage your events here — no tokens or settings to copy. Your sign-in is
        kept in an encrypted, HttpOnly cookie in this browser; this server stores nothing and page
        scripts can never read it.
      </p>
      <div className="cal-connect-grid">
        {OAUTH_CARDS.map((c) =>
          status.providers[c.id] ? (
            <div className="cal-connect-card" key={c.id}>
              <div className="cal-connect-head">
                <span aria-hidden="true">{c.icon}</span> {c.title}
              </div>
              <p className="cal-muted">{c.blurb}</p>
              <a className="btn btn-primary cal-connect-btn" href={connectUrl(c.id)}>
                {c.cta}
              </a>
            </div>
          ) : status.isLocalhost ? (
            <div className="cal-connect-card" key={c.id}>
              <div className="cal-connect-head">
                <span aria-hidden="true">{c.icon}</span> {c.title}
              </div>
              <p className="cal-muted">
                Set up {c.shortLabel} sign-in once for every visitor: register the redirect URL
                below with your own OAuth app, then save its client ID and secret here.
              </p>
              <CustomAppForm
                provider={c.id}
                label={c.shortLabel}
                onSaved={() => onAppSaved(c.id)}
              />
            </div>
          ) : (
            <div className="cal-connect-card" key={c.id}>
              <div className="cal-connect-head">
                <span aria-hidden="true">{c.icon}</span> {c.title}
              </div>
              <p className="cal-muted">
                This deployment hasn&apos;t set up {c.shortLabel} sign-in yet.
              </p>
            </div>
          ),
        )}
        <AppleCard onConnected={onConnected} />
      </div>
    </div>
  );
}
