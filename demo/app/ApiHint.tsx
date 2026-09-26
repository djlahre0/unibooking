import type { ReactNode } from 'react';

/**
 * One line under a control saying which unibooking call it makes, so the demo
 * doubles as a usage reference without a separate docs page:
 *
 *   Uses client.createCalendar({ name, color })
 *
 * `call` is the code as a developer would write it; `children` is at most one
 * short sentence of what to know about it.
 */
export default function ApiHint({ call, children }: { call: string; children?: ReactNode }) {
  return (
    <p className="api-hint">
      <span className="api-hint-label">Uses</span> <code>{call}</code>
      {children ? <span className="api-hint-note"> {children}</span> : null}
    </p>
  );
}
