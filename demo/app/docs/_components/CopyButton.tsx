'use client';

import { useState } from 'react';
import { CheckIcon, CopyIcon } from '../../components/icons';

/** Copies a code block's text. Says "Copied" for two seconds, and fails
 *  quietly where the clipboard is unavailable (an insecure origin). */
export default function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="code-copy"
      aria-label={copied ? 'Copied' : 'Copy code'}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
