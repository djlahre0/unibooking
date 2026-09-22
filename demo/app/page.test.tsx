/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Home from './page';
import { loadUiState, patchUiState, UI_KEY, __resetUiState } from '../lib/ui-state';
import { STORAGE_KEY as CRED_KEY } from '../lib/cred-storage';

// The page fetches calendar status on mount; nothing here needs a network.
vi.mock('../lib/calendar/api', () => ({
  getStatus: vi.fn(async () => ({ ok: false })),
  connectUrl: (p: string) => `/api/calendar/connect/${p}`,
  saveOAuthApp: vi.fn(async () => ({ ok: true })),
  connectApple: vi.fn(async () => ({ ok: true })),
  calendarCall: vi.fn(async () => ({ ok: true })),
  disconnect: vi.fn(async () => ({ ok: true })),
}));

beforeEach(() => {
  __resetUiState();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});
afterEach(cleanup);

const tab = (name: RegExp) => screen.getByRole('tab', { name });

describe('page persistence', () => {
  it('opens on the persisted tab', () => {
    patchUiState({ activeTab: 'webhooks' });
    render(<Home />);
    expect(tab(/Webhooks/).getAttribute('aria-selected')).toBe('true');
  });

  it('persists the tab when the visitor switches', async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.click(tab(/Webhooks/));
    await vi.waitFor(() => expect(loadUiState().activeTab).toBe('webhooks'));
  });

  it('?tab=calendar outranks the persisted tab (the OAuth callback lands there)', () => {
    patchUiState({ activeTab: 'webhooks' });
    window.history.replaceState({}, '', '/?tab=calendar');
    render(<Home />);
    expect(tab(/My Calendar/).getAttribute('aria-selected')).toBe('true');
  });

  it('restores the selected provider', () => {
    patchUiState({ selectedProvider: 'square' });
    render(<Home />);
    expect(screen.getByText(/Selected: Square/)).toBeTruthy();
  });

  it('persists a provider choice', async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.selectOptions(screen.getByLabelText('Provider'), 'square');
    await vi.waitFor(() => expect(loadUiState().selectedProvider).toBe('square'));
  });

  it('restoring a provider does NOT wipe the credentials saved for it', async () => {
    // The debounced save effect clears a provider's entry when every field is
    // blank. Restoring a provider without also restoring its credentials would
    // therefore delete them ~300ms after load -- silent data loss.
    localStorage.setItem(
      CRED_KEY,
      JSON.stringify({
        remember: true,
        providers: { square: { creds: { accessToken: 'keep-me' }, env: 'prod' } },
      }),
    );
    patchUiState({ selectedProvider: 'square' });
    // page.tsx caches its mount-time read of `remember` in MODULE state, so a
    // plain render here would see the `false` captured by the first test in
    // this file, the save effect would early-return, and this test would pass
    // no matter what. Re-import against a fresh registry so `remember` is read
    // from the store seeded above. (Verified: without the storage fallback in
    // `creds`, this test fails.)
    vi.resetModules();
    const { default: FreshHome } = await import('./page');
    render(<FreshHome />);
    await new Promise((r) => setTimeout(r, 500));
    const saved = JSON.parse(localStorage.getItem(CRED_KEY)!);
    expect(saved.providers.square?.creds.accessToken).toBe('keep-me');
  });

  it('restores a saved result on load', () => {
    patchUiState({
      selectedProvider: 'square',
      activeTab: 'capabilities',
      results: { caps: { at: '2026-09-20T10:00:00.000Z', json: '{"ok":true,"data":{"x":1}}' } },
    });
    render(<Home />);
    expect(screen.getByText(/"x":\s*1/)).toBeTruthy();
  });

  it('shows a notice instead of a result that was too large to save', () => {
    patchUiState({
      selectedProvider: 'square',
      activeTab: 'capabilities',
      results: {
        caps: { at: '2026-09-20T10:00:00.000Z', json: '__unibooking_result_too_large__' },
      },
    });
    render(<Home />);
    // ResultBox surfaces the message in more than one place (summary + detail).
    expect(screen.getAllByText(/too large to save/i).length).toBeGreaterThan(0);
  });

  it('drops stored results when the provider changes', async () => {
    const user = userEvent.setup();
    patchUiState({
      selectedProvider: 'square',
      results: { caps: { at: '2026-09-20T10:00:00.000Z', json: '{"ok":true}' } },
    });
    render(<Home />);
    await user.selectOptions(screen.getByLabelText('Provider'), 'acuity');
    await vi.waitFor(() => expect(loadUiState().results).toEqual({}));
  });

  it('never writes a credential into the UI state store', async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      CRED_KEY,
      JSON.stringify({
        remember: true,
        providers: { square: { creds: { accessToken: 'super-secret-token' }, env: 'prod' } },
      }),
    );
    render(<Home />);
    await user.selectOptions(screen.getByLabelText('Provider'), 'square');
    await vi.waitFor(() => expect(loadUiState().selectedProvider).toBe('square'));
    expect(localStorage.getItem(UI_KEY) ?? '').not.toContain('super-secret-token');
  });
});
