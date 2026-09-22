// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Booking } from 'unibooking';
import type { ActionResult } from '../../lib/result';
import * as api from '../../lib/calendar/api';
import CalendarTab from './CalendarTab';

vi.mock('../../lib/calendar/api', () => ({
  getStatus: vi.fn(),
  calendarCall: vi.fn(),
  connectApple: vi.fn(),
  disconnect: vi.fn(),
  connectUrl: (p: string) => `/api/calendar/connect/${p}`,
  // Used by the shared CustomAppForm (app/calendar/CustomAppForm.tsx), which
  // ConnectCards renders inline for a localhost visitor when a provider isn't
  // configured yet -- the operator's one-time OAuth app setup.
  saveOAuthApp: vi.fn(),
}));

const getStatus = vi.mocked(api.getStatus);
const calendarCall = vi.mocked(api.calendarCall);
const saveOAuthApp = vi.mocked(api.saveOAuthApp);

/** The Google/Microsoft card, scoped by its heading -- both cards render a
 *  "Client ID"/"Client Secret" pair via the shared form, so an unscoped
 *  `getByLabelText` would be ambiguous once both are unconfigured. */
function cardFor(title: string): HTMLElement {
  return screen.getByText(title).closest('.cal-connect-card') as HTMLElement;
}

// An hour from now always falls inside the default 7-day window from today.
const soon = new Date(Date.now() + 60 * 60 * 1000);
soon.setUTCMinutes(0, 0, 0);
const EVENT: Booking = {
  id: 'e1',
  provider: 'google',
  title: 'Team sync',
  range: {
    start: soon.toISOString().replace('.000Z', 'Z'),
    end: new Date(soon.getTime() + 30 * 60 * 1000).toISOString().replace('.000Z', 'Z'),
  },
  status: 'confirmed',
  location: 'Room 4',
  raw: {},
};

beforeEach(() => {
  localStorage.clear();
  calendarCall.mockImplementation(async (op): Promise<ActionResult> => {
    switch (op) {
      case 'listCalendars':
        return {
          ok: true,
          data: {
            calendars: [
              { id: 'jane@gmail.com', name: 'Jane', primary: true, readOnly: false, raw: {} },
              { id: 'holidays', name: 'Holidays', primary: false, readOnly: true, raw: {} },
            ],
          },
        };
      case 'listEvents':
        return { ok: true, data: { events: [EVENT], truncated: false } };
      case 'deleteEvent':
        return { ok: true, data: { deleted: true, id: 'e1' } };
      default:
        return { ok: false, error: { message: `unexpected ${op}` } };
    }
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('CalendarTab', () => {
  it('shows the deployer notice when the feature is not configured', async () => {
    getStatus.mockResolvedValue({
      ok: true,
      data: {
        enabled: false,
        problem: 'SESSION_SECRET is not set',
        providers: { google: false, outlook: false, apple: false },
        connection: null,
      },
    });
    render(<CalendarTab />);
    expect(await screen.findByText(/not set up on this deployment/)).toBeTruthy();
  });

  it('offers sign-in buttons for configured providers', async () => {
    getStatus.mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        providers: { google: true, outlook: false, apple: true },
        isLocalhost: false,
        connection: null,
      },
    });
    render(<CalendarTab />);
    const google = await screen.findByRole('link', { name: 'Continue with Google' });
    expect(google.getAttribute('href')).toBe('/api/calendar/connect/google');
    // Microsoft isn't configured (by env or by the operator's saved setup),
    // and this visitor isn't local, so the deployment offers no working
    // one-click button for it and no way to configure one either -- just a
    // plain notice, with no credential fields (see the "operator OAuth app
    // setup" tests below for the localhost-only setup form itself).
    expect(screen.queryByRole('button', { name: 'Continue with Microsoft' })).toBeNull();
    const outlook = cardFor('Outlook / Microsoft 365');
    expect(within(outlook).queryByLabelText('Client ID')).toBeNull();
    expect(within(outlook).getByText(/hasn.t set up microsoft sign-in yet/i)).toBeTruthy();
    expect(screen.getByLabelText('App-specific password')).toBeTruthy();
  });

  // Regression test for the autofill cross-contamination bug: the Apple
  // card's fields must carry their own provider-scoped name/id (distinct from
  // Google's/Outlook's, via CustomAppForm.test.tsx) and the password field
  // must opt out of a saved-credential offer.
  it('gives the Apple card its own name/id attributes and autoComplete="new-password" on the password field', async () => {
    getStatus.mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        providers: { google: true, outlook: true, apple: true },
        isLocalhost: false,
        connection: null,
      },
    });
    render(<CalendarTab />);
    const appleId = (await screen.findByLabelText('Apple ID')) as HTMLInputElement;
    const applePassword = screen.getByLabelText('App-specific password') as HTMLInputElement;
    expect(appleId.name).toBe('apple-appleid');
    expect(appleId.id).toBe('apple-appleid');
    expect(appleId.getAttribute('autocomplete')).toBe('off');
    expect(applePassword.name).toBe('apple-password');
    expect(applePassword.getAttribute('autocomplete')).toBe('new-password');
  });

  it('shows the account, calendars and events, and deletes an event', async () => {
    getStatus.mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        providers: { google: true, outlook: false, apple: true },
        connection: { provider: 'google', account: { email: 'jane@gmail.com' } },
      },
    });
    render(<CalendarTab />);

    expect(await screen.findByText('jane@gmail.com')).toBeTruthy();
    expect(await screen.findByRole('option', { name: /Holidays/ })).toBeTruthy();
    const row = await screen.findByRole('button', { name: /Team sync/ });
    expect(calendarCall).toHaveBeenCalledWith(
      'listEvents',
      expect.objectContaining({ calendarId: 'jane@gmail.com' }),
    );

    await userEvent.click(row);
    expect(screen.getByRole('dialog', { name: 'Event: Team sync' })).toBeTruthy();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await waitFor(() =>
      expect(calendarCall).toHaveBeenCalledWith('deleteEvent', {
        calendarId: 'jane@gmail.com',
        id: 'e1',
      }),
    );
    expect(await screen.findByText('Event deleted.')).toBeTruthy();
  });

  it('drops back to the connect screen when the connection is revoked', async () => {
    getStatus.mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        providers: { google: true, outlook: false, apple: true },
        connection: { provider: 'google', account: { email: 'jane@gmail.com' } },
      },
    });
    calendarCall.mockResolvedValue({
      ok: false,
      reconnect: true,
      error: { code: 'AUTH', message: 'gone' },
    });
    render(<CalendarTab />);
    expect(await screen.findByText(/expired or was revoked/)).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Continue with Google' })).toBeTruthy();
  });
});

// The fresh-clone case: no SESSION_SECRET override and no env-configured
// Google/Microsoft app, so `providers.google`/`.outlook` are both false. The
// operator's one-time setup form only ever appears for a localhost visitor
// (`isLocalhost: true` in the status response, computed server-side -- see
// isLoopbackRequest in lib/calendar/http.ts); any other visitor just gets a
// plain notice, with no credential fields of any kind.
describe('CalendarTab: operator OAuth app setup on a fresh clone (nothing configured)', () => {
  const nothingConfiguredLocal = {
    ok: true as const,
    data: {
      enabled: true,
      providers: { google: false, outlook: false, apple: true },
      isLocalhost: true,
      connection: null,
    },
  };
  const nothingConfiguredRemote = {
    ok: true as const,
    data: {
      enabled: true,
      providers: { google: false, outlook: false, apple: true },
      isLocalhost: false,
      connection: null,
    },
  };

  it('offers the setup form on the Google card, for a localhost visitor, instead of a disabled "Not configured" button', async () => {
    getStatus.mockResolvedValue(nothingConfiguredLocal);
    render(<CalendarTab />);
    await screen.findByText('Google Calendar');
    const card = cardFor('Google Calendar');
    expect(within(card).queryByText(/not configured on this deployment/i)).toBeNull();
    expect(within(card).getByLabelText('Client ID')).toBeTruthy();
    expect(within(card).getByLabelText('Client Secret')).toBeTruthy();
  });

  it('shows the exact redirect URL to register, derived from the page origin', async () => {
    getStatus.mockResolvedValue(nothingConfiguredLocal);
    render(<CalendarTab />);
    await screen.findByText('Google Calendar');
    const card = cardFor('Google Calendar');
    const redirectInput = within(card).getByLabelText(
      /redirect url to register/i,
    ) as HTMLInputElement;
    expect(redirectInput.value).toBe(`${window.location.origin}/api/calendar/callback/google`);
  });

  it('saves the typed client id/secret via saveOAuthApp and never re-renders the secret afterwards', async () => {
    saveOAuthApp.mockResolvedValue({ ok: true, data: { saved: true } });
    getStatus.mockResolvedValue(nothingConfiguredLocal);
    render(<CalendarTab />);
    await screen.findByText('Google Calendar');
    const card = cardFor('Google Calendar');
    const secret = 'super-secret-value-xyz';
    await userEvent.type(within(card).getByLabelText('Client ID'), 'my-client-id');
    await userEvent.type(within(card).getByLabelText('Client Secret'), secret);
    await userEvent.click(within(card).getByRole('button', { name: /save google app/i }));
    expect(saveOAuthApp).toHaveBeenCalledWith('google', 'my-client-id', secret, '');
    // The secret travels only in the POST body above -- it must never come
    // back out into rendered text, whether the call succeeded or not.
    expect(screen.queryByText(secret)).toBeNull();
  });

  it('refetches status after a successful save, so the card can switch to the sign-in button', async () => {
    saveOAuthApp.mockResolvedValue({ ok: true, data: { saved: true } });
    getStatus.mockResolvedValueOnce(nothingConfiguredLocal).mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        providers: { google: true, outlook: false, apple: true },
        isLocalhost: true,
        connection: null,
      },
    });
    render(<CalendarTab />);
    await screen.findByText('Google Calendar');
    const card = cardFor('Google Calendar');
    await userEvent.type(within(card).getByLabelText('Client ID'), 'my-client-id');
    await userEvent.type(within(card).getByLabelText('Client Secret'), 'my-secret');
    await userEvent.click(within(card).getByRole('button', { name: /save google app/i }));
    expect(await screen.findByRole('link', { name: 'Continue with Google' })).toBeTruthy();
  });

  it('tells a non-local visitor Google sign-in is not set up yet, and asks for no credentials at all', async () => {
    getStatus.mockResolvedValue(nothingConfiguredRemote);
    render(<CalendarTab />);
    await screen.findByText('Google Calendar');
    const card = cardFor('Google Calendar');
    expect(within(card).getByText(/hasn.t set up google sign-in yet/i)).toBeTruthy();
    expect(within(card).queryByLabelText('Client ID')).toBeNull();
    expect(within(card).queryByLabelText('Client Secret')).toBeNull();
    expect(within(card).queryByLabelText(/redirect url to register/i)).toBeNull();
  });
});

// The callback route (app/api/calendar/callback/[provider]/route.ts) redirects
// failures back here as `?error=<code>[&provider=<id>]`. These tests exercise
// the banner CalendarTab builds from that URL -- see routes.test.ts for the
// server side (what the route is and isn't willing to put in the redirect).
describe('CalendarTab: OAuth callback error banner (?error=… from the callback route)', () => {
  const disconnected = {
    ok: true as const,
    data: {
      enabled: true,
      providers: { google: true, outlook: true, apple: true },
      connection: null,
    },
  };

  afterEach(() => {
    // bannerFromUrl reads window.location.search once per mount -- reset it
    // so this describe block's URL doesn't leak into later tests in this file.
    window.history.pushState(null, '', '/');
  });

  it('gives each mapped OAuth error code its own distinct message, and only access_denied mentions cancelling', async () => {
    const codes = [
      'access_denied',
      'invalid_client',
      'unauthorized_client',
      'invalid_scope',
      'admin_policy_enforced',
      'org_internal',
      'disallowed_useragent',
      'server_error',
      'temporarily_unavailable',
      'invalid_request',
    ];
    const seenMessages = new Set<string>();
    for (const code of codes) {
      window.history.pushState(null, '', `/?tab=calendar&error=${code}&provider=google`);
      getStatus.mockResolvedValue(disconnected);
      const { unmount } = render(<CalendarTab />);
      const alert = await screen.findByRole('alert');
      const text = alert.textContent ?? '';
      expect(seenMessages.has(text)).toBe(false); // distinct per code
      seenMessages.add(text);
      if (code === 'access_denied') {
        expect(text).toMatch(/cancel/i);
      } else {
        expect(text).not.toMatch(/cancel/i);
      }
      unmount();
    }
  });

  it('falls back to a generic message that still names an unrecognised but well-formed code', async () => {
    window.history.pushState(null, '', '/?tab=calendar&error=consent_required&provider=google');
    getStatus.mockResolvedValue(disconnected);
    render(<CalendarTab />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('consent_required');
    expect(alert.textContent).toMatch(/sign-in failed/i);
  });

  it('does not reflect a malformed or hostile error value typed straight into the URL', async () => {
    window.history.pushState(
      null,
      '',
      `/?tab=calendar&error=${encodeURIComponent('<script>alert(1)</script>')}`,
    );
    getStatus.mockResolvedValue(disconnected);
    render(<CalendarTab />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('<script>');
    expect(alert.textContent).not.toContain('alert(1)');
    expect(alert.textContent).toMatch(/sign-in failed/i);
  });

  it('shows the exact redirect URL to register, with a copy button, for redirect_uri_mismatch', async () => {
    window.history.pushState(
      null,
      '',
      '/?tab=calendar&error=redirect_uri_mismatch&provider=google',
    );
    getStatus.mockResolvedValue(disconnected);
    render(<CalendarTab />);
    const alert = await screen.findByRole('alert');
    const redirectInput = within(alert).getByLabelText(
      /redirect url to register/i,
    ) as HTMLInputElement;
    expect(redirectInput.value).toBe(`${window.location.origin}/api/calendar/callback/google`);
    expect(within(alert).getByRole('button', { name: /copy/i })).toBeTruthy();
  });

  it('shows the message but no redirect URL for redirect_uri_mismatch without a recognised provider', async () => {
    window.history.pushState(null, '', '/?tab=calendar&error=redirect_uri_mismatch');
    getStatus.mockResolvedValue(disconnected);
    render(<CalendarTab />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/not registered/i);
    expect(within(alert).queryByLabelText(/redirect url to register/i)).toBeNull();
  });
});
