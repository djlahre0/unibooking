'use client';

export type PersistenceControlsProps = {
  remember: boolean;
  onToggleRemember: (on: boolean) => void;
  onClearProvider: () => void;
  onClearAll: () => void;
  providerLabel: string;
  /** False in Safari private mode or when storage is disabled by policy. */
  available: boolean;
};

export default function PersistenceControls({
  remember,
  onToggleRemember,
  onClearProvider,
  onClearAll,
  providerLabel,
  available,
}: PersistenceControlsProps) {
  return (
    <div
      style={{
        marginTop: '1rem',
        paddingTop: '0.8rem',
        borderTop: '1px solid var(--border, #2a2a3a)',
      }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.82rem' }}>
        <input
          type="checkbox"
          checked={remember}
          disabled={!available}
          onChange={(e) => onToggleRemember(e.target.checked)}
        />
        Remember credentials on this device
      </label>

      {!available && (
        <p
          style={{ fontSize: '0.75rem', color: 'var(--text-muted, #8888a0)', marginTop: '0.4rem' }}
        >
          This browser is blocking local storage (private mode, or disabled by policy), so
          credentials can&apos;t be remembered here. Everything else still works.
        </p>
      )}

      {remember && available && (
        <div
          role="note"
          style={{
            marginTop: '0.6rem',
            borderRadius: '8px',
            padding: '0.6rem 0.75rem',
            fontSize: '0.76rem',
            lineHeight: 1.6,
            border: '1px solid #6b5a2f',
            background: '#241f0f',
            color: '#fcd34d',
          }}
        >
          ⚠ <strong>Saved on this device.</strong> These credentials sit in this browser&apos;s
          localStorage until you clear them. Don&apos;t use this on a shared computer.
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
        <button className="btn btn-sm btn-secondary" onClick={onClearProvider}>
          Clear {providerLabel}
        </button>
        <button className="btn btn-sm btn-secondary" onClick={onClearAll}>
          Clear all saved
        </button>
      </div>
    </div>
  );
}
