'use client';

import { clearUiState, persistenceEnabled } from '../lib/ui-state';
import { SAMPLE_KEY } from '../lib/sample/store';

export type PersistenceControlsProps = {
  remember: boolean;
  onToggleRemember: (on: boolean) => void;
  onClearProvider: () => void;
  onClearAll: () => void;
  providerLabel: string;
  /** False in Safari private mode or when storage is disabled by policy. */
  available: boolean;
};

const UNAVAILABLE_NOTE_ID = 'persistence-unavailable-note';
const SAVED_NOTE_ID = 'persistence-saved-note';

/* Named what it actually does, in the order a tester loses it. clearAll()
   empties `providers` wholesale, so this is never just the provider on
   screen -- saying "every provider" is the difference between a warning and
   a surprise. The second paragraph is the other half of the answer: the
   operator's Google/Microsoft app lives in a server-side file and the
   session lives in a cookie, so neither is touched here, and a tester who
   doesn't know that will assume the worst and avoid the button. */
const CLEAR_ALL_CONFIRM = [
  'Clear everything this demo saved in this browser?',
  '',
  'This removes the credentials you pasted for EVERY provider, what you were doing, and the sample data. You will have to enter them all again.',
  '',
  'Your saved Google/Microsoft sign-in setup is not affected, and this does not sign you out of My Calendar.',
].join('\n');

export default function PersistenceControls({
  remember,
  onToggleRemember,
  onClearProvider,
  onClearAll,
  providerLabel,
  available,
}: PersistenceControlsProps) {
  const describedBy = !available ? UNAVAILABLE_NOTE_ID : remember ? SAVED_NOTE_ID : undefined;

  return (
    <section className="persistence-bar" aria-label="Saved on this device">
      <label className="persistence-label">
        <input
          type="checkbox"
          checked={remember}
          disabled={!available}
          aria-describedby={describedBy}
          onChange={(e) => onToggleRemember(e.target.checked)}
        />
        Remember credentials on this device
      </label>
      <p className="persistence-help">
        Keeps what you typed for {providerLabel} in this browser, so you don&apos;t paste it again
        after a reload. Turning it off wipes what was saved.
      </p>

      {!available && (
        <p id={UNAVAILABLE_NOTE_ID} role="note" className="persistence-note">
          This browser is blocking local storage (private mode, or disabled by policy), so
          credentials can&apos;t be remembered here. Everything else still works.
        </p>
      )}

      {remember && available && (
        <div id={SAVED_NOTE_ID} role="note" className="persistence-warning">
          <strong>Saved on this device.</strong> These credentials sit in this browser&apos;s
          localStorage until you clear them. Don&apos;t use this on a shared computer.
        </div>
      )}

      {available && !persistenceEnabled() && (
        <p role="note" className="persistence-note">
          This browser&apos;s storage is full or unavailable, so nothing you do here will be
          remembered after a reload. The demo keeps working for this session.
        </p>
      )}

      <div className="persistence-actions">
        <button
          className="btn btn-sm btn-secondary"
          onClick={onClearProvider}
          disabled={!available}
        >
          Clear {providerLabel}
        </button>
        <button
          className="btn btn-sm btn-danger"
          onClick={() => {
            // ONE confirmation covering all three stores. The confirm lives
            // here rather than in the caller so the wording can name
            // everything that is actually about to go.
            if (!confirm(CLEAR_ALL_CONFIRM)) return;
            clearUiState();
            try {
              localStorage.removeItem(SAMPLE_KEY);
            } catch {
              // Blocked storage: there was nothing saved to clear.
            }
            onClearAll();
          }}
          disabled={!available}
        >
          Clear all saved
        </button>
      </div>
    </section>
  );
}
