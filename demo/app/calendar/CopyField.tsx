'use client';

import { useState } from 'react';

/**
 * A read-only value with a "Copy" button -- the one interaction pattern this
 * app uses everywhere it shows something meant to be pasted into another
 * site's settings. Shared by `CustomAppForm.tsx` (the redirect URL to
 * register before connecting) and `CalendarTab.tsx` (the same URL, shown
 * again after a `redirect_uri_mismatch` failure) so the two can't drift
 * apart the way `CustomAppForm`'s own doc comment already warns against for
 * its two call sites.
 */
export default function CopyField({
  id,
  label,
  value,
  help,
}: {
  id: string;
  label: string;
  value: string;
  help?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="form-group" style={{ gridColumn: '1 / -1' }}>
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      <div style={{ display: 'flex', gap: '0.4rem' }}>
        <input id={id} className="form-input" type="text" readOnly value={value} />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!value}
          onClick={() => {
            void navigator.clipboard
              .writeText(value)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {
                // Clipboard permission denied -- the value is still plain,
                // selectable text in the field above.
              });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {help ? <p className="field-help">{help}</p> : null}
    </div>
  );
}
