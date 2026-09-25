'use client';

import { useState } from 'react';
import { resetOAuthApp } from '../../lib/calendar/api';
import type { OAuthProvider } from '../../lib/calendar/types';

/**
 * Unsets the operator's saved OAuth registration so the setup form returns
 * and a different client id/secret can be entered — the alternative being to
 * hand-edit `.oauth-apps.json` and restart the server.
 *
 * Rendered only for a localhost visitor, which is convenience: the DELETE
 * route runs the same gate chain the save does (same-origin, never in
 * production, loopback-only, rate limited), so this button being absent is
 * never what stops anyone.
 *
 * Shared by both places that show a configured provider — the My Calendar
 * grid (ConnectCards) and the Connect tab's single-provider area
 * (ConnectPanel) — so the wording and the confirm can't drift apart.
 */
export default function ResetSetupButton({
  provider,
  label,
  onReset,
}: {
  provider: OAuthProvider;
  label: string;
  /** Called after a successful reset so the caller can refetch status, which
   *  is what flips the card back to the setup form. */
  onReset: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-secondary cal-reset-setup"
        disabled={busy}
        onClick={() => {
          // Names what goes and what stops working. "may be asked to sign in
          // again" rather than "will be signed out": an existing session's
          // token keeps working until it needs a refresh, and a refresh
          // without the app's credentials is what actually fails.
          if (
            !confirm(
              `Remove the saved ${label} client ID and secret?\n\nThe setup form comes back so you can enter different ones. Until you do, nobody can sign in with ${label}, and anyone already signed in through it may be asked to sign in again.`,
            )
          )
            return;
          setError(undefined);
          setBusy(true);
          void resetOAuthApp(provider).then((res) => {
            setBusy(false);
            if (res.ok) onReset();
            else setError(res.error?.message ?? 'Could not reset the setup.');
          });
        }}
      >
        {busy ? 'Removing…' : 'Change setup'}
      </button>
      {error ? (
        <div className="cal-banner error" role="alert">
          {error}
        </div>
      ) : null}
    </>
  );
}
