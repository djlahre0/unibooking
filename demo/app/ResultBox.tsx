'use client';

import type { ActionResult } from '../lib/call';

export default function ResultBox({
  result,
  label,
}: {
  result: ActionResult | null;
  label?: string;
}) {
  if (!result) return null;
  return (
    <div className="result-box fade-in">
      <div className="result-header">
        <span>{label ?? 'Response'}</span>
        <span className={`result-status ${result.ok ? 'success' : 'error'}`}>
          {result.ok ? '✓ Success' : '✗ Error'}
        </span>
      </div>
      <div className="result-body">
        <pre>{JSON.stringify(result.ok ? result.data : result.error, null, 2)}</pre>
      </div>
    </div>
  );
}
