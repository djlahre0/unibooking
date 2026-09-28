'use client';

import { useState } from 'react';
import { saveOAuthApp } from '../../lib/calendar/api';
import type { OAuthProvider } from '../../lib/calendar/types';
import CopyField from './CopyField';

/**
 * The operator's one-time Google/Microsoft OAuth app setup: register an app
 * with the provider once, paste its client id/secret here, and every later
 * visitor signs in with the ordinary "Continue with…" button -- the standard
 * OAuth model (one app registration, many end users), not a per-visitor
 * credential. Saved server-side (see lib/calendar/oauth-apps.ts) via a route
 * that only accepts the save from the machine running this deployment
 * (`calendarStatus.isLocalhost`) -- so this form itself must only ever be
 * rendered for a localhost visitor; that gating happens at each call site,
 * not here, but the real enforcement is server-side regardless of what the
 * page renders.
 *
 * Shared by the two places a localhost visitor can set this up: the Connect
 * tab's guided flow (`ConnectPanel.tsx`) and the My Calendar tab's connect
 * cards (`ConnectCards.tsx`). Kept as one component rather than two copies,
 * so the two flows can't drift apart.
 *
 * This used to be the visitor-facing "bring your own OAuth app" form, POSTing
 * straight to the connect route to start a sign-in with pasted credentials.
 * That per-visitor flow is replaced by this one for normal visitors -- the
 * connect route's own POST handler still exists and still works (see its own
 * doc comment), it's just no longer reachable from this UI.
 */
export default function CustomAppForm({
  provider,
  label,
  onSaved,
}: {
  provider: OAuthProvider;
  label: string;
  /** Called after a successful save so the caller can refetch
   *  `/api/calendar/status` -- which is what makes the card switch from this
   *  form to the "Continue with…" sign-in button. */
  onSaved: () => void;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [tenant, setTenant] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // This form only ever mounts once calendarStatus has come back from
  // /api/calendar/status (fetched in an effect by whichever tab is showing
  // it), which can only happen client-side after hydration -- so `window` is
  // always available by the time this lazy initializer runs; the `typeof`
  // guard is just defensive.
  const [origin] = useState(() => (typeof window !== 'undefined' ? window.location.origin : ''));
  const redirectUrl = origin ? `${origin}/api/calendar/callback/${provider}` : '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    const res = await saveOAuthApp(provider, clientId, clientSecret, tenant);
    setSubmitting(false);
    if (res.ok) {
      setClientId('');
      setClientSecret('');
      setTenant('');
      onSaved();
      return;
    }
    setError(res.error?.message ?? 'Could not save.');
  }

  return (
    <form className="creds-form" onSubmit={(e) => void submit(e)}>
      <CopyField
        id={`oauth-setup-redirect-${provider}`}
        label="Redirect URL to register"
        value={redirectUrl}
        help="Register this exact URL as your OAuth app's redirect/callback URI before you save it below -- a mismatch here fails on the provider's own consent page, where this app has no chance to explain it."
      />
      <div className="form-group">
        <label className="form-label" htmlFor={`${provider}-client-id`}>
          Client ID
        </label>
        <input
          id={`${provider}-client-id`}
          name={`${provider}-client-id`}
          className="form-input"
          type="text"
          // Provider-scoped name/id (not just id) plus autoComplete="off" is
          // what actually stops a password manager grouping this with the
          // other card's fields -- without a distinct `name`, Chrome infers
          // one from context and had been treating every id+password pair on
          // the page as the same saved login (see the bug this fixes).
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          required
        />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor={`${provider}-client-secret`}>
          Client Secret
        </label>
        <input
          id={`${provider}-client-secret`}
          name={`${provider}-client-secret`}
          className="form-input"
          type="password"
          // "new-password" (not "current-password"/"off") is the one value
          // browsers reliably honor to stop a password manager offering a
          // saved credential here -- this is never an existing login, so it's
          // also the semantically correct hint.
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="off"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          required
        />
      </div>
      {provider === 'outlook' ? (
        <div className="form-group">
          <label className="form-label" htmlFor={`${provider}-tenant`}>
            Tenant (optional)
          </label>
          <input
            id={`${provider}-tenant`}
            name={`${provider}-tenant`}
            className="form-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            placeholder="common"
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
          />
          <p className="field-help">
            Leave blank for <code>common</code> (work, school and personal accounts), or enter your
            app&apos;s directory (tenant) ID to restrict sign-in to one organization.
          </p>
        </div>
      ) : null}
      {error ? (
        <div className="cal-banner error" role="alert" style={{ gridColumn: '1 / -1' }}>
          {error}
        </div>
      ) : null}
      <div style={{ gridColumn: '1 / -1' }}>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={submitting || !clientId.trim() || !clientSecret.trim()}
        >
          {submitting ? 'Saving…' : `Save ${label} app`}
        </button>
      </div>
    </form>
  );
}
