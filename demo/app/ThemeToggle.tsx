'use client';

import { useEffect } from 'react';
import { patchUiState, type Theme } from '../lib/ui-state';
import { useUiState } from '../lib/use-ui-state';

const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * The CSS already handles both themes (globals.css): the OS preference applies
 * when no `data-theme` is set, and an explicit value overrides it. So "system"
 * REMOVES the attribute rather than setting a third value.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export default function ThemeToggle() {
  const { theme } = useUiState();

  // Syncing an external system (the document element) with React state — the
  // case effects are actually for. layout.tsx applies the same value before
  // first paint, so this is a no-op on load and only does work on a change.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`btn btn-sm ${theme === o.value ? 'btn-primary' : 'btn-secondary'}`}
          aria-pressed={theme === o.value}
          onClick={() => patchUiState({ theme: o.value })}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
