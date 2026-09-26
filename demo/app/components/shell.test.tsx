/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Home from '../page';
import SiteHeader from './SiteHeader';
import { loadUiState, patchUiState, __resetUiState } from '../../lib/ui-state';
import { STORAGE_KEY as CRED_KEY } from '../../lib/cred-storage';

vi.mock('../../lib/calendar/api', () => ({
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

describe('site header', () => {
  it('shows the logo, the three destinations and the project links', () => {
    render(<SiteHeader />);
    expect(screen.getByRole('link', { name: 'unibooking home' }).getAttribute('href')).toBe('/');
    for (const name of ['Explorer', 'Docs', 'Providers']) {
      expect(screen.getByRole('link', { name })).toBeTruthy();
    }
    expect(screen.getByRole('link', { name: 'GitHub repository' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'npm package' })).toBeTruthy();
  });

  it('opens search with Ctrl+K and filters as you type', async () => {
    const user = userEvent.setup();
    render(<SiteHeader />);
    await user.keyboard('{Control>}k{/Control}');
    const input = screen.getByRole('combobox');
    await user.type(input, 'square');
    const first = screen.getAllByRole('option')[0]!;
    expect(first.textContent).toContain('Square Appointments');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('explorer sidebar', () => {
  it('shows a heading for the open section with a link to its docs', () => {
    patchUiState({ activeTab: 'bookings' });
    render(<Home />);
    expect(screen.getByRole('heading', { level: 1, name: 'Bookings' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /read the docs/i }).getAttribute('href')).toBe(
      '/docs/reference/client',
    );
  });

  it('links the selected provider to its setup guide', () => {
    patchUiState({ selectedProvider: 'square' });
    render(<Home />);
    expect(screen.getByRole('link', { name: /setup guide for square/i }).getAttribute('href')).toBe(
      '/docs/providers/square',
    );
  });

  it('moves between sections with the arrow keys', async () => {
    const user = userEvent.setup();
    patchUiState({ activeTab: 'connect' });
    render(<Home />);
    screen.getByRole('tab', { name: 'Connect' }).focus();
    await user.keyboard('{ArrowDown}');
    await vi.waitFor(() => expect(loadUiState().activeTab).toBe('capabilities'));
  });

  it('the provider shortcut opens Connect', async () => {
    const user = userEvent.setup();
    patchUiState({ selectedProvider: 'square', activeTab: 'bookings' });
    render(<Home />);
    await user.click(
      screen.getByRole('button', { name: 'Provider: Square. Change it in Connect.' }),
    );
    await vi.waitFor(() => expect(loadUiState().activeTab).toBe('connect'));
  });
});

describe('provider picker', () => {
  it('filters as you type and picks with Enter', async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.click(screen.getByLabelText('Provider'));
    await user.type(screen.getByRole('combobox', { name: 'Search providers' }), 'calen');
    // "Google Calendar" and "Calendly" both match; the first is highlighted.
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names.some((n) => n?.includes('Google Calendar'))).toBe(true);
    expect(names.some((n) => n?.includes('Square'))).toBe(false);
    await user.keyboard('{Enter}');
    await vi.waitFor(() => expect(loadUiState().selectedProvider).toBe('google'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('marks the current provider and closes on Escape without changing it', async () => {
    const user = userEvent.setup();
    patchUiState({ selectedProvider: 'square' });
    render(<Home />);
    await user.click(screen.getByLabelText('Provider'));
    const current = screen.getByRole('option', { name: /^Square/ });
    expect(current.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(loadUiState().selectedProvider).toBe('square');
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.click(screen.getByLabelText('Provider'));
    await user.type(screen.getByRole('combobox', { name: 'Search providers' }), 'zzz');
    expect(screen.getByText(/No provider matches/)).toBeTruthy();
  });
});

describe('selected calendar', () => {
  it('shows the default calendar for Google with no calendarId', () => {
    patchUiState({ selectedProvider: 'google' });
    render(<Home />);
    expect(screen.getByText('Primary calendar')).toBeTruthy();
  });

  it('shows the calendarId that calls will use', () => {
    localStorage.setItem(
      CRED_KEY,
      JSON.stringify({
        remember: true,
        providers: {
          outlook: { creds: { accessToken: 't', calendarId: 'AAMk-team' }, env: 'prod' },
        },
      }),
    );
    patchUiState({ selectedProvider: 'outlook' });
    render(<Home />);
    expect(screen.getByText('AAMk-team')).toBeTruthy();
  });

  it('warns that Apple needs a calendar before events work', () => {
    patchUiState({ selectedProvider: 'apple' });
    render(<Home />);
    expect(screen.getByText('None chosen')).toBeTruthy();
  });

  it('is absent for booking platforms', () => {
    patchUiState({ selectedProvider: 'square' });
    render(<Home />);
    expect(screen.queryByText('Calendar', { selector: '.sidebar-calendar-label' })).toBeNull();
  });

  it('Change opens Connect', async () => {
    const user = userEvent.setup();
    patchUiState({ selectedProvider: 'google', activeTab: 'bookings' });
    render(<Home />);
    await user.click(screen.getByRole('button', { name: 'Change calendar in Connect' }));
    await vi.waitFor(() => expect(loadUiState().activeTab).toBe('connect'));
  });
});

describe('explorer sections', () => {
  it('shows capabilities without a click, since they need no request', async () => {
    patchUiState({ selectedProvider: 'square', activeTab: 'capabilities' });
    render(<Home />);
    await vi.waitFor(() => expect(screen.getByText('serviceCatalog')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Load Capabilities' })).toBeNull();
  });

  it('keeps Webhooks available whatever provider is selected', () => {
    patchUiState({ selectedProvider: 'sample' });
    render(<Home />);
    expect(screen.getByRole('tab', { name: 'Webhooks' }).className).not.toContain('tab-muted');
  });

  it('offers the full provider grid on Connect only until one is chosen', () => {
    patchUiState({ selectedProvider: '', activeTab: 'connect' });
    render(<Home />);
    expect(screen.getByText('Choose a provider')).toBeTruthy();
    cleanup();
    patchUiState({ selectedProvider: 'square', activeTab: 'connect' });
    render(<Home />);
    expect(screen.queryByText('Choose a provider')).toBeNull();
    expect(screen.getByText('Connect Square')).toBeTruthy();
  });
});

describe('deep links', () => {
  it('?provider= and ?tab= select a provider and section from the docs', async () => {
    window.history.replaceState({}, '', '/?provider=acuity&tab=availability');
    render(<Home />);
    await vi.waitFor(() => {
      expect(loadUiState().selectedProvider).toBe('acuity');
      expect(loadUiState().activeTab).toBe('availability');
    });
  });

  it('ignores an unknown provider or section', async () => {
    patchUiState({ selectedProvider: 'square', activeTab: 'bookings' });
    window.history.replaceState({}, '', '/?provider=nope&tab=nope');
    render(<Home />);
    await new Promise((r) => setTimeout(r, 50));
    expect(loadUiState().selectedProvider).toBe('square');
    expect(loadUiState().activeTab).toBe('bookings');
  });
});
