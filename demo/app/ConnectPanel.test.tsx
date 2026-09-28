/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConnectPanel from './ConnectPanel';
import * as api from '../lib/calendar/api';
import type { CalendarStatus } from '../lib/calendar/types';

const saveOAuthApp = vi.mocked(api.saveOAuthApp);
const resetOAuthApp = vi.mocked(api.resetOAuthApp);

// ConnectPanel only calls connectUrl (pure, reproduced here), disconnect (a
// POST) and saveOAuthApp (the operator's one-time OAuth app setup, localhost
// only) from this module -- mocked the same way CalendarTab.test.tsx mocks
// it, so a click never reaches a real fetch.
vi.mock('../lib/calendar/api', () => ({
  connectUrl: (p: string) => `/api/calendar/connect/${p}`,
  disconnect: vi.fn().mockResolvedValue({ ok: true, data: { disconnected: true } }),
  saveOAuthApp: vi.fn().mockResolvedValue({ ok: true, data: { saved: true } }),
  // Apple's connect form and the operator's reset both live on this tab now:
  // My Calendar shows only already-connected calendars.
  connectApple: vi.fn().mockResolvedValue({ ok: true, data: { connected: true } }),
  resetOAuthApp: vi.fn().mockResolvedValue({ ok: true, data: { reset: true } }),
}));

// vitest.config.ts runs without `globals: true`, so cleanup is not automatic
// between tests in this file (see EventForm.test.tsx / CalendarTab.test.tsx
// for the same pattern) -- without it, the sample provider's chip stays
// "selected" in the DOM from an earlier test and pollutes later assertions.
// restoreAllMocks clears the module factory's implementations too, so the
// defaults are re-armed per test rather than set once at import.
beforeEach(() => {
  saveOAuthApp.mockReset().mockResolvedValue({ ok: true, data: { saved: true } });
  resetOAuthApp.mockReset().mockResolvedValue({ ok: true, data: { reset: true } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const base = {
  onSelectProvider: () => {},
  creds: {},
  onCredChange: () => {},
  capsResult: null,
  onLoadCapabilities: () => {},
  busy: false,
};

describe('ConnectPanel with the sample provider', () => {
  it('says no account is needed instead of showing an empty credential form', () => {
    render(<ConnectPanel {...base} selectedProvider="sample" />);
    expect(screen.getByText(/no account needed/i)).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('never claims credentials are sent anywhere', () => {
    render(<ConnectPanel {...base} selectedProvider="sample" />);
    // The proxied-provider banner would be a false security claim here: this
    // provider has no credentials and makes no request at all.
    expect(screen.queryByText(/sent to the/i)).toBeNull();
    expect(screen.getByText(/never leaves this browser/i)).toBeDefined();
  });

  it('offers a reset that restores the seeded data', async () => {
    const onResetSample = vi.fn();
    render(<ConnectPanel {...base} selectedProvider="sample" onResetSample={onResetSample} />);
    await userEvent.click(screen.getByRole('button', { name: /reset sample data/i }));
    expect(onResetSample).toHaveBeenCalledOnce();
  });

  it('still shows the credential form for a real provider', () => {
    render(<ConnectPanel {...base} selectedProvider="google" />);
    expect(screen.queryByText(/no account needed/i)).toBeNull();
    expect(screen.getAllByRole('textbox').length).toBeGreaterThan(0);
  });
});

// Status fixtures for the three sign-in branches. `enabled`/`providers` come
// from GET /api/calendar/status (see lib/calendar/types.ts); the unit tests
// never fetch it, so ConnectPanel is exercised the same way page.tsx feeds it.
// `isLocalhost` defaults to false here (a normal, remote visitor) -- tests
// that need the operator's own-machine view spread `isLocalhost: true` in.
const configuredNotSignedIn: CalendarStatus = {
  enabled: true,
  providers: { google: true, outlook: false, apple: false },
  isLocalhost: false,
  connection: null,
};
const signedInGoogle: CalendarStatus = {
  enabled: true,
  providers: { google: true, outlook: false, apple: false },
  isLocalhost: false,
  connection: { provider: 'google', account: { email: 'pat@example.com' } },
};
// `enabled` is true and `outlook` is configured, but `google` itself is not --
// this is the case `calendarConfigured` must gate on, not just top-level
// `enabled`. A wholly absent `calendarStatus` (the `base` default) already
// covers "My Calendar isn't wired up at all" via the pre-existing tests.
const googleNotConfigured: CalendarStatus = {
  enabled: true,
  providers: { google: false, outlook: true, apple: false },
  isLocalhost: false,
  connection: null,
};
const outlookNotConfigured: CalendarStatus = {
  enabled: true,
  providers: { google: true, outlook: false, apple: false },
  isLocalhost: false,
  connection: null,
};

describe('ConnectPanel sign-in states (Google)', () => {
  it('offers a sign-in action when configured but not signed in, and still allows pasting a token', () => {
    render(
      <ConnectPanel {...base} selectedProvider="google" calendarStatus={configuredNotSignedIn} />,
    );
    const link = screen.getByRole('link', { name: /continue with google/i });
    expect(link.getAttribute('href')).toBe('/api/calendar/connect/google');
    // The paste flow is still offered alongside the button, for a visitor who
    // prefers it -- sign-in is an addition, not a replacement, until signed in.
    expect(screen.getByLabelText(/access token/i)).toBeDefined();
  });

  it('shows the connected account and a disconnect action, and drops the access-token field once signed in', () => {
    render(<ConnectPanel {...base} selectedProvider="google" calendarStatus={signedInGoogle} />);
    expect(screen.getByText('pat@example.com')).toBeDefined();
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeDefined();
    expect(screen.queryByRole('link', { name: /continue with google/i })).toBeNull();
    // The visitor no longer supplies it -- the session cookie already has it.
    expect(screen.queryByLabelText(/access token/i)).toBeNull();
  });

  it('falls back to the ordinary step flow, unchanged, when Google sign-in is not configured', () => {
    render(
      <ConnectPanel {...base} selectedProvider="google" calendarStatus={googleNotConfigured} />,
    );
    expect(screen.queryByRole('link', { name: /continue with google/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /disconnect/i })).toBeNull();
    expect(screen.getByLabelText(/access token/i)).toBeDefined();
    expect(screen.getAllByRole('textbox').length).toBeGreaterThan(0);
  });
});

describe('ConnectPanel: operator OAuth app setup', () => {
  it('tells a non-local visitor Google sign-in is not set up yet, and asks for no credentials', () => {
    render(
      <ConnectPanel {...base} selectedProvider="google" calendarStatus={googleNotConfigured} />,
    );
    expect(screen.queryByRole('link', { name: /continue with google/i })).toBeNull();
    expect(screen.queryByLabelText(/client id/i)).toBeNull();
    expect(screen.queryByLabelText(/client secret/i)).toBeNull();
    expect(screen.getByText(/hasn.t set up google sign-in yet/i)).toBeDefined();
  });

  it('shows the setup form (fields + redirect URL) for a localhost visitor when Google is not configured', () => {
    render(
      <ConnectPanel
        {...base}
        selectedProvider="google"
        calendarStatus={{ ...googleNotConfigured, isLocalhost: true }}
      />,
    );
    expect(screen.queryByRole('link', { name: /continue with google/i })).toBeNull();
    expect(screen.getByLabelText(/client id/i)).toBeDefined();
    expect(screen.getByLabelText(/client secret/i)).toBeDefined();
    const redirectInput = screen.getByLabelText(/redirect url to register/i) as HTMLInputElement;
    // Rendered from the page's own origin (jsdom's default test origin),
    // exactly what the operator must register with their OAuth app.
    expect(redirectInput.value).toBe(`${window.location.origin}/api/calendar/callback/google`);
  });

  it('shows only the sign-in button, never setup fields, once Google is configured -- even for a localhost visitor', () => {
    render(
      <ConnectPanel
        {...base}
        selectedProvider="google"
        calendarStatus={{ ...configuredNotSignedIn, isLocalhost: true }}
      />,
    );
    expect(screen.getByRole('link', { name: /continue with google/i })).toBeDefined();
    expect(screen.queryByLabelText(/client id/i)).toBeNull();
    expect(screen.queryByLabelText(/client secret/i)).toBeNull();
  });

  it('does not offer OAuth app setup when SESSION_SECRET itself is missing, even from localhost', () => {
    render(
      <ConnectPanel
        {...base}
        selectedProvider="google"
        calendarStatus={{
          enabled: false,
          problem: 'SESSION_SECRET is not set',
          providers: { google: false, outlook: false, apple: false },
          isLocalhost: true,
          connection: null,
        }}
      />,
    );
    expect(screen.queryByLabelText(/client id/i)).toBeNull();
    expect(screen.getByText(/sign-in isn.t available/i)).toBeDefined();
  });

  it('offers an optional tenant field for a Microsoft app, but not for a Google app', () => {
    const { unmount } = render(
      <ConnectPanel
        {...base}
        selectedProvider="outlook"
        calendarStatus={{ ...outlookNotConfigured, isLocalhost: true }}
      />,
    );
    expect(screen.getByLabelText(/tenant/i)).toBeDefined();
    unmount();

    render(
      <ConnectPanel
        {...base}
        selectedProvider="google"
        calendarStatus={{ ...googleNotConfigured, isLocalhost: true }}
      />,
    );
    expect(screen.queryByLabelText(/tenant/i)).toBeNull();
  });

  it('saves a supplied Microsoft tenant and refreshes status afterwards', async () => {
    const onCalendarConfigChanged = vi.fn();
    render(
      <ConnectPanel
        {...base}
        selectedProvider="outlook"
        calendarStatus={{ ...outlookNotConfigured, isLocalhost: true }}
        onCalendarConfigChanged={onCalendarConfigChanged}
      />,
    );
    await userEvent.type(screen.getByLabelText(/client id/i), 'cid');
    await userEvent.type(screen.getByLabelText(/client secret/i), 'csecret');
    await userEvent.type(screen.getByLabelText(/tenant/i), 'my-directory-id');
    await userEvent.click(screen.getByRole('button', { name: /save microsoft app/i }));
    expect(saveOAuthApp).toHaveBeenLastCalledWith('outlook', 'cid', 'csecret', 'my-directory-id');
    await waitFor(() => expect(onCalendarConfigChanged).toHaveBeenCalledOnce());
  });

  it('never re-renders the client secret after saving it', async () => {
    // Relocated here when My Calendar stopped offering OAuth app setup: this
    // is the security property of that form, and it must not have moved out
    // of coverage along with the form itself. The secret travels in the POST
    // body and must never come back out into rendered text.
    const secret = 'super-secret-value-9f3-not-a-real-secret';
    saveOAuthApp.mockResolvedValue({ ok: true, data: { saved: true } });
    render(
      <ConnectPanel
        {...base}
        selectedProvider="google"
        calendarStatus={{ ...googleNotConfigured, isLocalhost: true }}
      />,
    );
    await userEvent.type(screen.getByLabelText(/client id/i), 'my-client-id');
    await userEvent.type(screen.getByLabelText(/client secret/i), secret);
    await userEvent.click(screen.getByRole('button', { name: /save google app/i }));

    expect(saveOAuthApp).toHaveBeenLastCalledWith('google', 'my-client-id', secret, '');
    await waitFor(() => expect(screen.queryByText(secret)).toBeNull());
    // Not merely absent from text -- absent from the DOM the user could read
    // back, including any value attribute left behind on the input.
    expect(document.body.innerHTML).not.toContain(secret);
  });

  it('passes an empty tenant when left blank -- saveOAuthApp (api.ts) then omits it from the request body entirely', async () => {
    render(
      <ConnectPanel
        {...base}
        selectedProvider="outlook"
        calendarStatus={{ ...outlookNotConfigured, isLocalhost: true }}
      />,
    );
    await userEvent.type(screen.getByLabelText(/client id/i), 'cid');
    await userEvent.type(screen.getByLabelText(/client secret/i), 'csecret');
    await userEvent.click(screen.getByRole('button', { name: /save microsoft app/i }));
    expect(saveOAuthApp).toHaveBeenLastCalledWith('outlook', 'cid', 'csecret', '');
  });
});

describe('ConnectPanel: "Advanced" disclosure', () => {
  it('hides fields with a working default (Google calendarId) behind a closed disclosure by default', () => {
    render(
      <ConnectPanel {...base} selectedProvider="google" calendarStatus={configuredNotSignedIn} />,
    );
    const details = screen.getByText('Advanced').closest('details') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    // Present in the DOM (so it's still usable and testable) even though the
    // disclosure that contains it is collapsed.
    expect(screen.getByLabelText(/calendar id/i)).toBeDefined();
  });

  it('shows a provider with no advanced fields exactly as before -- no empty disclosure', () => {
    // Bookeo, not Acuity: every Bookeo credential is required, so there is
    // genuinely nothing to put behind the disclosure. Acuity used to serve as
    // this example and no longer can -- see the next test.
    render(<ConnectPanel {...base} selectedProvider="bookeo" />);
    expect(screen.queryByText('Advanced')).toBeNull();
  });

  it("puts Acuity's optional currency behind the disclosure", () => {
    // AcuityCredentials has `currency?`, which the demo's own hand-written
    // field list omitted entirely. Deriving the fields from the library
    // schema surfaced it, and optional means Advanced -- so it is offered
    // without crowding the two fields that are actually required.
    render(<ConnectPanel {...base} selectedProvider="acuity" />);
    expect(screen.getByText('Advanced')).toBeDefined();
    expect(screen.getByLabelText(/currency/i)).toBeDefined();
    // The required pair stays up front.
    expect(screen.getByLabelText(/user id/i)).toBeDefined();
    expect(screen.getByLabelText(/api key/i)).toBeDefined();
  });
});

describe('TrustBanner: the security claim is accurate in every state', () => {
  // This is the one that matters: once signed in, the call runs server-side
  // from the sealed session cookie, so the "never leaves this browser" claim
  // (true for the pasted-token path) would be FALSE here. It must not appear.
  it('does not claim the token never leaves the browser once signed in via My Calendar', () => {
    render(<ConnectPanel {...base} selectedProvider="google" calendarStatus={signedInGoogle} />);
    expect(screen.queryByText(/never leaves this browser/i)).toBeNull();
    // And it should say what actually happens instead of just omitting the claim.
    expect(screen.getByText(/this call runs on the server, not your browser/i)).toBeDefined();
  });

  it('still claims the token never leaves the browser for a pasted-token direct provider', () => {
    // No calendarStatus at all -- google is a DIRECT provider and, unsigned-in,
    // folds back to today's unchanged paste flow (per ConnectPanel's own doc
    // comment on the `calendarStatus` prop).
    render(<ConnectPanel {...base} selectedProvider="google" />);
    expect(screen.getByText(/your token never leaves this browser/i)).toBeDefined();
  });

  it('still says credentials are sent to the server for a proxied provider', () => {
    render(<ConnectPanel {...base} selectedProvider="acuity" />);
    expect(screen.getByText(/credentials are sent to the demo.s server/i)).toBeDefined();
    expect(screen.queryByText(/never leaves this browser/i)).toBeNull();
  });

  it('still says nothing leaves the browser and no account is needed for the sample provider', () => {
    render(<ConnectPanel {...base} selectedProvider="sample" />);
    expect(screen.getByText(/never leaves this browser/i)).toBeDefined();
    expect(screen.getByText(/no account needed/i)).toBeDefined();
  });
});

describe('every provider is selectable in the Connect picker', () => {
  it('renders a chip for all 18 providers, Bookeo and Booker included', () => {
    render(<ConnectPanel {...base} selectedProvider="" />);
    // A provider missing from PROVIDER_META silently vanishes here, however
    // complete its adapter is, which is exactly how "Bookeo is missing" would
    // look to a visitor.
    const chips = Array.from(document.querySelectorAll('.provider-chip-name')).map((b) =>
      b.textContent?.trim(),
    );
    for (const label of [
      'Bookeo',
      'Booker',
      'Google Calendar',
      'Outlook / M365',
      'MS Bookings',
      'Square',
      'Acuity',
      'Mindbody',
      'Wix Bookings',
      'Calendly',
      'Vagaro',
      'Zenoti',
      'Boulevard',
      'Phorest',
      'Setmore',
      'Mangomint',
      'Apple / CalDAV',
      'Sample Data',
    ]) {
      expect(chips, `${label} chip is missing from the picker`).toContain(label);
    }
  });

  it('shows Bookeo its two credential fields once selected', () => {
    render(<ConnectPanel {...base} selectedProvider="bookeo" />);
    expect(screen.getByText(/Connect Bookeo/i)).toBeTruthy();
    expect(screen.getByLabelText(/API Key/i)).toBeTruthy();
    expect(screen.getByLabelText(/Secret Key/i)).toBeTruthy();
  });

  it('puts the persistence bar above the steps, not buried inside one', () => {
    // What this browser has saved belongs before anything is typed into it.
    // DOCUMENT_POSITION_FOLLOWING: steps come after the bar.
    const { container } = render(
      <ConnectPanel {...base} selectedProvider="bookeo">
        <div data-testid="persistence-slot" />
      </ConnectPanel>,
    );
    const bar = screen.getByTestId('persistence-slot');
    const steps = container.querySelector('.connect-steps');
    expect(steps).toBeTruthy();
    expect(bar.compareDocumentPosition(steps!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(steps!.contains(bar)).toBe(false);
  });

  it('renders the persistence bar for the sample provider too', () => {
    // It used to sit inside the non-local branch, so the sample provider --
    // whose data really is in localStorage -- never got a clear-all.
    render(
      <ConnectPanel {...base} selectedProvider="sample">
        <div data-testid="persistence-slot" />
      </ConnectPanel>,
    );
    expect(screen.getByTestId('persistence-slot')).toBeTruthy();
  });
});

const appleAvailable: CalendarStatus = {
  enabled: true,
  providers: { google: false, outlook: false, apple: true },
  isLocalhost: false,
  connection: null,
};

describe('ConnectPanel: Apple', () => {
  it('offers the app-specific-password form, since Apple has no OAuth to offer instead', () => {
    render(<ConnectPanel {...base} selectedProvider="apple" calendarStatus={appleAvailable} />);
    expect(screen.getByLabelText('Apple ID')).toBeDefined();
    expect(screen.getByLabelText('App-specific password')).toBeDefined();
    expect(screen.getByRole('button', { name: /connect icloud/i })).toBeDefined();
  });

  // Moved here with the form itself. Regression test for the autofill
  // cross-contamination bug: the browser's password manager was filling
  // Google's client ID into Apple's fields because they shared generic
  // name/id attributes and opted into saved-credential offers.
  it('gives the Apple fields their own name/id and opts the password out of autofill', () => {
    render(<ConnectPanel {...base} selectedProvider="apple" calendarStatus={appleAvailable} />);
    const appleId = screen.getByLabelText('Apple ID') as HTMLInputElement;
    const password = screen.getByLabelText('App-specific password') as HTMLInputElement;
    expect(appleId.name).toBe('apple-appleid');
    expect(appleId.getAttribute('autocomplete')).toBe('off');
    expect(password.name).toBe('apple-password');
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    expect(password.type).toBe('password');
  });

  it('offers nothing once Apple is already connected', () => {
    render(
      <ConnectPanel
        {...base}
        selectedProvider="apple"
        calendarStatus={{
          ...appleAvailable,
          connection: { provider: 'apple', account: { email: 'pat@icloud.com' } },
        }}
      />,
    );
    expect(screen.queryByLabelText('App-specific password')).toBeNull();
  });
});

describe('ConnectPanel: resetting a configured OAuth app (localhost only)', () => {
  const configuredLocal: CalendarStatus = { ...configuredNotSignedIn, isLocalhost: true };

  it('offers no reset to a remote visitor, who could otherwise break sign-in for everyone', () => {
    render(
      <ConnectPanel {...base} selectedProvider="google" calendarStatus={configuredNotSignedIn} />,
    );
    expect(screen.getByRole('link', { name: /continue with google/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /change setup/i })).toBeNull();
  });

  it('offers it alongside the sign-in button from localhost', () => {
    render(<ConnectPanel {...base} selectedProvider="google" calendarStatus={configuredLocal} />);
    expect(screen.getByRole('button', { name: /change setup/i })).toBeDefined();
  });

  it('resets and tells the parent to refetch status', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onCalendarConfigChanged = vi.fn();
    render(
      <ConnectPanel
        {...base}
        selectedProvider="google"
        calendarStatus={configuredLocal}
        onCalendarConfigChanged={onCalendarConfigChanged}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /change setup/i }));
    expect(resetOAuthApp).toHaveBeenCalledWith('google');
    await waitFor(() => expect(onCalendarConfigChanged).toHaveBeenCalledOnce());
  });

  it('does nothing when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ConnectPanel {...base} selectedProvider="google" calendarStatus={configuredLocal} />);
    await userEvent.click(screen.getByRole('button', { name: /change setup/i }));
    expect(resetOAuthApp).not.toHaveBeenCalled();
  });

  it('shows the server error and keeps the sign-in button when the reset is refused', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    resetOAuthApp.mockResolvedValue({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'This provider is configured by environment variables, which take precedence.',
      },
    });
    render(<ConnectPanel {...base} selectedProvider="google" calendarStatus={configuredLocal} />);
    await userEvent.click(screen.getByRole('button', { name: /change setup/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/environment variables/i);
    expect(screen.getByRole('link', { name: /continue with google/i })).toBeDefined();
  });
});

describe('step 3 tests the connection for real', () => {
  it('offers Test connection, held back until the required fields are filled', () => {
    render(<ConnectPanel {...base} selectedProvider="square" conn={{ creds: {} }} env="sandbox" />);
    const button = screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/^Fill in .+ first\.$/)).toBeDefined();
  });

  it('enables it once every required field has a value', () => {
    const creds = { accessToken: 'tok', locationId: 'L1' };
    render(<ConnectPanel {...base} selectedProvider="square" creds={creds} conn={{ creds }} />);
    const button = screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});

describe('provider picker groups', () => {
  it('groups providers by kind, with what each offers', () => {
    render(<ConnectPanel {...base} selectedProvider="" />);
    const cal = screen.getByRole('region', { name: 'Calendars' });
    expect(cal.textContent).toContain('Google Calendar');
    expect(cal.textContent).toContain('Events · calendars');
    const booking = screen.getByRole('region', { name: 'Booking platforms' });
    const square = Array.from(booking.querySelectorAll('.provider-chip')).find((b) =>
      b.textContent?.startsWith('Square'),
    );
    expect(square?.textContent).toContain('Staff & services');
    expect(screen.getByRole('region', { name: 'Try it' }).textContent).toContain('Sample Data');
  });
});
