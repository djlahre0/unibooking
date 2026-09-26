'use client';

import { WrenchIcon } from '../components/icons';

/**
 * What My Calendar shows when there is no calendar to show.
 *
 * My Calendar is the end user's view of their own connected calendars. It
 * offers no provider cards and no setup: connecting happens on the Connect
 * tab, where every provider is connected the same way.
 */

/** Shown only when this deployment's cookie-sealing key genuinely failed its
 *  own length check -- not a normal state. The demo needs no environment
 *  variables to offer sign-in: a key is generated on first use (or read from
 *  an optional `SESSION_SECRET` override), so this should not appear on a
 *  fresh clone. Aimed at the person who deployed the demo, not at a visitor. */
export function SetupNotice({ problem }: { problem?: string }) {
  return (
    <div className="card">
      <div className="card-title">
        <span className="icon">
          <WrenchIcon size={18} />
        </span>{' '}
        My Calendar is not set up on this deployment
      </div>
      <p className="cal-muted">
        {problem ?? 'Configuration is missing'}. This is unexpected -- see the My Calendar section
        of <code>demo/README.md</code> for the (optional) <code>SESSION_SECRET</code> override this
        points at. The other tabs work without any of this.
      </p>
    </div>
  );
}

/** Nothing connected yet. An empty screen is an invitation to act, so this
 *  says what to do and takes them there, rather than only reporting absence. */
export function NoCalendarConnected({ onOpenConnect }: { onOpenConnect?: () => void }) {
  return (
    <div className="card cal-empty">
      <div className="card-title">No calendar connected</div>
      <p className="cal-muted">
        Once you connect a calendar, your events show up here: a day-grouped agenda you can add to,
        edit and clear out.
      </p>
      {onOpenConnect ? (
        <button type="button" className="btn btn-primary" onClick={onOpenConnect}>
          Connect a calendar
        </button>
      ) : (
        <p className="cal-muted">Open the Connect tab to add one.</p>
      )}
    </div>
  );
}
