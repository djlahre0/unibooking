'use client';

import { useEffect, type ReactNode } from 'react';
import { patchUiState, type Theme } from '../lib/ui-state';
import { useUiState } from '../lib/use-ui-state';
import { MonitorIcon, MoonIcon, SunIcon } from './components/icons';

const OPTIONS: { value: Theme; label: string; icon: ReactNode }[] = [
  { value: 'system', label: 'System', icon: <MonitorIcon size={15} /> },
  { value: 'light', label: 'Light', icon: <SunIcon size={15} /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon size={15} /> },
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

/** A three-way icon switch. Each button keeps its word as its accessible name
 *  and tooltip, so it reads the same to a screen reader as the old labels. */
export default function ThemeToggle() {
  const { theme } = useUiState();

  // Syncing an external system (the document element) with React state: the
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
          className={`theme-toggle-btn ${theme === o.value ? 'is-active' : ''}`}
          aria-pressed={theme === o.value}
          aria-label={o.label}
          title={`${o.label} theme`}
          onClick={() => patchUiState({ theme: o.value })}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
