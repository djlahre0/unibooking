// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Booking } from 'unibooking';
import type { ActionResult } from '../../lib/result';
import * as api from '../../lib/calendar/api';
import CalendarTab from './CalendarTab';

// Each flow is several mocked round trips plus renders; under the full suite
// the 1 s default wait was too tight and flaked. Failures still fail, later.
configure({ asyncUtilTimeout: 5000 });

vi.mock('../../lib/calendar/api', () => ({
  getStatus: vi.fn(),
  calendarCall: vi.fn(),
  connectApple: vi.fn(),
  disconnect: vi.fn(),
  connectUrl: (p: string) => `/api/calendar/connect/${p}`,
  // Kept on the mock although nothing in this tree calls it any more: My
  // Calendar no longer offers OAuth app setup (that lives on the Connect tab,
  // see ConnectPanel.test.tsx). The module factory replaces the whole module,
  // so leaving it out would break any import added back later.
  saveOAuthApp: vi.fn(),
  // Used by ResetSetupButton (app/calendar/ResetSetupButton.tsx), which
  // ConnectCards renders on a CONFIGURED card for a localhost visitor so the
  // operator can swap in a different client id/secret.
  resetOAuthApp: vi.fn(),
}));

const getStatus = vi.mocked(api.getStatus);
const calendarCall = vi.mocked(api.calendarCall);

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
  calendarCall.mockImplementation(async (op, args): Promise<ActionResult> => {
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
      case 'createCalendar':
        return {
          ok: true,
          data: { id: 'new-cal', name: args?.name, primary: false, readOnly: false, raw: {} },
        };
      case 'updateCalendar':
        return {
          ok: true,
          data: { id: args?.calendarId, name: args?.name, primary: false, readOnly: false, raw: {} },
        };
      case 'deleteCalendar':
        return { ok: true, data: { deleted: true } };
      case 'setEventStatus':
        return {
          ok: true,
          data:
            args?.status === 'cancelled'
              ? { ...EVENT, title: `Cancelled: ${EVENT.title}` }
              : { ...EVENT, status: args?.status },
        };
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

describe('CalendarTab', { timeout: 20_000 }, () => {
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

  it('shows the empty state, not provider cards, when nothing is connected', async () => {
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
    // This tab is the user's own calendar. Even with Google configured and
    // Apple always available, connecting happens on the Connect tab -- here
    // there is simply nothing connected yet.
    expect(await screen.findByText(/no calendar connected/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Continue with Google' })).toBeNull();
    expect(screen.queryByLabelText('App-specific password')).toBeNull();
    expect(screen.queryByText('Google Calendar')).toBeNull();
  });

  it('sends the visitor to the Connect tab to add one', async () => {
    const onOpenConnect = vi.fn();
    getStatus.mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        providers: { google: true, outlook: false, apple: true },
        isLocalhost: false,
        connection: null,
      },
    });
    render(<CalendarTab onOpenConnect={onOpenConnect} />);
    await userEvent.click(await screen.findByRole('button', { name: /connect a calendar/i }));
    expect(onOpenConnect).toHaveBeenCalledOnce();
  });

  // Regression test for the autofill cross-contamination bug: the Apple
  // card's fields must carry their own provider-scoped name/id (distinct from
  // Google's/Outlook's, via CustomAppForm.test.tsx) and the password field
  // must opt out of a saved-credential offer.

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
    await userEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() =>
      expect(calendarCall).toHaveBeenCalledWith('deleteEvent', {
        calendarId: 'jane@gmail.com',
        id: 'e1',
      }),
    );
    expect(await screen.findByText('Event deleted.')).toBeTruthy();
  });

  it('cancels an event while keeping it, separately from deleting it', async () => {
    getStatus.mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        providers: { google: true, outlook: false, apple: true },
        connection: { provider: 'google', account: { email: 'jane@gmail.com' } },
      },
    });
    render(<CalendarTab />);
    await userEvent.click(await screen.findByRole('button', { name: /Team sync/ }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const status = screen.getByRole('group', { name: 'Status' });
    expect(within(status).getByRole('button', { name: 'Confirmed' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await userEvent.click(within(status).getByRole('button', { name: 'Cancelled' }));
    await waitFor(() =>
      expect(calendarCall).toHaveBeenCalledWith('setEventStatus', {
        calendarId: 'jane@gmail.com',
        id: 'e1',
        status: 'cancelled',
      }),
    );
    expect(calendarCall).not.toHaveBeenCalledWith('deleteEvent', expect.anything());
    expect(await screen.findByText(/Event cancelled/)).toBeTruthy();
    // The kept event now reads as cancelled...
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'Status' }))
          .getByRole('button', { name: 'Cancelled' })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    // ...and picking another status restores it, without a confirm prompt.
    vi.mocked(window.confirm).mockClear();
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Status' })).getByRole('button', {
        name: 'Tentative',
      }),
    );
    await waitFor(() =>
      expect(calendarCall).toHaveBeenCalledWith('setEventStatus', {
        calendarId: 'jane@gmail.com',
        id: 'e1',
        status: 'pending',
      }),
    );
    expect(window.confirm).not.toHaveBeenCalled();
    expect(await screen.findByText(/Event marked tentative/)).toBeTruthy();
  });

  it('creates, renames and deletes calendars; the primary cannot be deleted', async () => {
    getStatus.mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        providers: { google: true, outlook: false, apple: true },
        connection: { provider: 'google', account: { email: 'jane@gmail.com' } },
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CalendarTab />);
    await screen.findByRole('option', { name: /Jane/ }, { timeout: 5000 });
    // The account's main calendar is selected: it can be renamed, not deleted.
    expect((screen.getByRole('button', { name: 'Delete calendar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('client.deleteCalendar(id)')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'New calendar' }));
    const form = screen.getByRole('form', { name: 'New calendar' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Front desk');
    await userEvent.click(within(form).getByRole('button', { name: 'Create calendar' }));
    await waitFor(() =>
      expect(calendarCall).toHaveBeenCalledWith('createCalendar', {
        name: 'Front desk',
        color: '#0f5c4a',
      }),
    );
    expect(await screen.findByText(/Calendar “Front desk” created/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const rename = screen.getByRole('form', { name: 'Rename calendar' });
    const input = within(rename).getByLabelText('New name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Jane (work)');
    await userEvent.click(within(rename).getByRole('button', { name: 'Save name' }));
    await waitFor(() =>
      expect(calendarCall).toHaveBeenCalledWith('updateCalendar', {
        calendarId: 'jane@gmail.com',
        name: 'Jane (work)',
      }),
    );
  });

  it('drops back to the empty state when the connection is revoked', async () => {
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
    // The banner still explains what happened -- the part that matters is
    // that a revoked session does not leave the agenda on screen. Reconnecting
    // happens on the Connect tab, so this lands on the empty state.
    expect(await screen.findByText(/expired or was revoked/)).toBeTruthy();
    expect(await screen.findByText(/no calendar connected/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Continue with Google' })).toBeNull();
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

  it('asks a non-local visitor for no credentials at all', async () => {
    getStatus.mockResolvedValue(nothingConfiguredRemote);
    render(<CalendarTab />);
    await screen.findByText(/no calendar connected/i);
    expect(screen.queryByLabelText('Client ID')).toBeNull();
    expect(screen.queryByLabelText('Client Secret')).toBeNull();
    expect(screen.queryByLabelText(/redirect url to register/i)).toBeNull();
  });

  it('offers no OAuth app setup here at all, even on localhost', async () => {
    getStatus.mockResolvedValue(nothingConfiguredLocal);
    render(<CalendarTab />);
    // Registering an OAuth app is operator work and lives on the Connect tab
    // (ConnectPanel.test.tsx covers that it is still reachable there), so
    // this is a relocation rather than a removal.
    await screen.findByText(/no calendar connected/i);
    expect(screen.queryByLabelText('Client ID')).toBeNull();
    expect(screen.queryByText(/set up .*sign-in/i)).toBeNull();
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
