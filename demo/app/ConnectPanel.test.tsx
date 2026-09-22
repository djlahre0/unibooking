/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConnectPanel from './ConnectPanel';
import * as api from '../lib/calendar/api';
import type { CalendarStatus } from '../lib/calendar/types';

const saveOAuthApp = vi.mocked(api.saveOAuthApp);

// ConnectPanel only calls connectUrl (pure, reproduced here), disconnect (a
// POST) and saveOAuthApp (the operator's one-time OAuth app setup, localhost
// only) from this module -- mocked the same way CalendarTab.test.tsx mocks
// it, so a click never reaches a real fetch.
vi.mock('../lib/calendar/api', () => ({
  connectUrl: (p: string) => `/api/calendar/connect/${p}`,
  disconnect: vi.fn().mockResolvedValue({ ok: true, data: { disconnected: true } }),
  saveOAuthApp: vi.fn().mockResolvedValue({ ok: true, data: { saved: true } }),
}));

// vitest.config.ts runs without `globals: true`, so cleanup is not automatic
// between tests in this file (see EventForm.test.tsx / CalendarTab.test.tsx
// for the same pattern) -- without it, the sample provider's chip stays
// "selected" in the DOM from an earlier test and pollutes later assertions.
afterEach(cleanup);

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
    render(<ConnectPanel {...base} selectedProvider="acuity" />);
    expect(screen.queryByText('Advanced')).toBeNull();
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
