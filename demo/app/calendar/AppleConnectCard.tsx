'use client';

import { useState } from 'react';
import { connectApple } from '../../lib/calendar/api';
import { CloudIcon } from '../components/icons';

/**
 * Apple's connect form. Apple offers third parties no OAuth for calendars, so
 * iCloud connects with the user's Apple ID plus an app-specific password --
 * there is no "Continue with Apple" button to show instead.
 *
 * It lives on the Connect tab (ConnectPanel) rather than My Calendar: My
 * Calendar shows a user their connected calendars, and connecting a new one
 * happens where every other provider is connected. Without this here Apple
 * would have no route at all, since ConnectPanel's sign-in branch only covers
 * the two OAuth providers.
 */
export default function AppleConnectCard({ onConnected }: { onConnected: () => void }) {
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
        <CloudIcon /> Apple iCloud
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
