/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PersistenceControls from './PersistenceControls';
import { patchUiState, loadUiState, UI_KEY, __resetUiState } from '../lib/ui-state';
import { SAMPLE_KEY } from '../lib/sample/store';
import { STORAGE_KEY as CRED_KEY } from '../lib/cred-storage';

const base = {
  remember: false,
  available: true,
  providerLabel: 'Square',
  onToggleRemember: () => {},
  onClearProvider: () => {},
};

/** A Storage whose setItem always throws, to drive the quota path. */
const throwingStorage = {
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => {
    throw new Error('quota');
  },
  removeItem: () => {},
  clear: () => {},
} as Storage;

beforeEach(() => {
  __resetUiState();
  localStorage.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PersistenceControls', () => {
  it('clears credentials, UI state and demo data behind ONE confirm', async () => {
    const user = userEvent.setup();
    localStorage.setItem(CRED_KEY, JSON.stringify({ remember: true, providers: { sq: {} } }));
    localStorage.setItem(SAMPLE_KEY, JSON.stringify({ version: 1 }));
    patchUiState({ activeTab: 'bookings' });
    const onClearAll = vi.fn();
    render(<PersistenceControls {...base} onClearAll={onClearAll} />);

    await user.click(screen.getByRole('button', { name: /clear all saved/i }));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(UI_KEY)).toBeNull();
    expect(localStorage.getItem(SAMPLE_KEY)).toBeNull();
    expect(onClearAll).toHaveBeenCalledTimes(1);
    expect(loadUiState().activeTab).toBe('connect');
  });

  it('does nothing when the confirm is declined', async () => {
    const user = userEvent.setup();
    vi.mocked(window.confirm).mockReturnValue(false);
    localStorage.setItem(SAMPLE_KEY, JSON.stringify({ version: 1 }));
    patchUiState({ activeTab: 'bookings' });
    const onClearAll = vi.fn();
    render(<PersistenceControls {...base} onClearAll={onClearAll} />);

    await user.click(screen.getByRole('button', { name: /clear all saved/i }));

    expect(onClearAll).not.toHaveBeenCalled();
    expect(localStorage.getItem(SAMPLE_KEY)).not.toBeNull();
    expect(loadUiState().activeTab).toBe('bookings');
  });

  it('says so when persistence had to be switched off mid-session', () => {
    // A quota failure that survives dropping results disables persistence for
    // the session; the visitor has to be told, or they will assume it saved.
    patchUiState({ activeTab: 'bookings' }, throwingStorage);
    render(<PersistenceControls {...base} onClearAll={() => {}} />);
    expect(screen.getByText(/full or unavailable/i)).toBeTruthy();
  });

  it('shows no such notice while persistence is working', () => {
    render(<PersistenceControls {...base} onClearAll={() => {}} />);
    expect(screen.queryByText(/full or unavailable/i)).toBeNull();
  });

  it('offers both the per-provider and the clear-all action', () => {
    render(<PersistenceControls {...base} onClearAll={() => {}} />);
    expect(screen.getByRole('button', { name: /clear square/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /clear all saved/i })).toBeTruthy();
  });

  it('warns that the clear covers every provider, and says what survives', async () => {
    // A tester who reads "clear all" as "clear this one" loses every pasted
    // credential; one who reads it as "clear everything" wrongly assumes the
    // operator OAuth app went too. The prompt has to rule out both.
    const user = userEvent.setup();
    render(<PersistenceControls {...base} onClearAll={() => {}} />);

    await user.click(screen.getByRole('button', { name: /clear all saved/i }));

    const prompt = vi.mocked(window.confirm).mock.calls[0][0] as string;
    expect(prompt).toMatch(/every provider/i);
    expect(prompt).toMatch(/enter them all again/i);
    expect(prompt).toMatch(/not affected|does not sign you out/i);
  });
});
