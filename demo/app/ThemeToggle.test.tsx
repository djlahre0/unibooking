/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ThemeToggle from './ThemeToggle';
import { loadUiState, patchUiState, __resetUiState } from '../lib/ui-state';

beforeEach(() => {
  __resetUiState();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(cleanup);

describe('ThemeToggle', () => {
  it('persists the chosen theme', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('button', { name: /dark/i }));
    await vi.waitFor(() => expect(loadUiState().theme).toBe('dark'));
  });

  it('sets data-theme on the document element', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('button', { name: /dark/i }));
    await vi.waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark'),
    );
  });

  it('removes data-theme for "system", so the OS preference applies again', async () => {
    const user = userEvent.setup();
    patchUiState({ theme: 'dark' });
    render(<ThemeToggle />);
    await user.click(screen.getByRole('button', { name: /system/i }));
    await vi.waitFor(() =>
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false),
    );
  });

  it('applies a theme restored from storage without any interaction', () => {
    patchUiState({ theme: 'light' });
    render(<ThemeToggle />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('marks the active theme for assistive tech', () => {
    patchUiState({ theme: 'light' });
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: /light/i }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: /dark/i }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });
});
