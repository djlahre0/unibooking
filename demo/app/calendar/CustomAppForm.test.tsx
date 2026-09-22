// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import CustomAppForm from './CustomAppForm';

vi.mock('../../lib/calendar/api', () => ({
  saveOAuthApp: vi.fn().mockResolvedValue({ ok: true, data: { saved: true } }),
}));

afterEach(cleanup);

/**
 * Regression test for the browser-autofill cross-contamination bug: with no
 * distinct `name` attribute, Chrome's password manager treated every card's
 * id+password field pair as the same saved login and filled one card's
 * values (e.g. Google's client ID) into another (Apple's "Apple ID" field),
 * and a secret into every card's secret input alike. The fix is a unique,
 * provider-scoped `name`/`id` on every field plus `autoComplete="off"` (ids)
 * or `"new-password"` (secrets) -- this asserts both, for the two provider
 * cards CustomAppForm renders (Google/Outlook). See ConnectCards.tsx for the
 * matching fix on the Apple card.
 */
describe('CustomAppForm: no autofill cross-contamination between provider cards', () => {
  it('gives the Google and Outlook cards different name/id attributes for the same field', () => {
    const { unmount } = render(
      <CustomAppForm provider="google" label="Google" onSaved={() => {}} />,
    );
    const googleId = screen.getByLabelText('Client ID') as HTMLInputElement;
    const googleSecret = screen.getByLabelText('Client Secret') as HTMLInputElement;
    expect(googleId.name).toBe('google-client-id');
    expect(googleId.id).toBe('google-client-id');
    expect(googleSecret.name).toBe('google-client-secret');
    expect(googleSecret.id).toBe('google-client-secret');
    unmount();

    render(<CustomAppForm provider="outlook" label="Microsoft" onSaved={() => {}} />);
    const outlookId = screen.getByLabelText('Client ID') as HTMLInputElement;
    const outlookSecret = screen.getByLabelText('Client Secret') as HTMLInputElement;
    expect(outlookId.name).toBe('outlook-client-id');
    expect(outlookId.id).toBe('outlook-client-id');
    expect(outlookSecret.name).toBe('outlook-client-secret');
    expect(outlookSecret.id).toBe('outlook-client-secret');

    // The whole point of the fix: no field's name/id collides across the two
    // provider cards, so a password manager can no longer group them as one
    // saved login.
    expect(googleId.name).not.toBe(outlookId.name);
    expect(googleId.id).not.toBe(outlookId.id);
    expect(googleSecret.name).not.toBe(outlookSecret.name);
    expect(googleSecret.id).not.toBe(outlookSecret.id);
  });

  it('marks secret inputs autoComplete="new-password" -- the reliable way to stop a saved credential being offered', () => {
    for (const provider of ['google', 'outlook'] as const) {
      const { unmount } = render(
        <CustomAppForm provider={provider} label={provider} onSaved={() => {}} />,
      );
      const secret = screen.getByLabelText('Client Secret') as HTMLInputElement;
      expect(secret.getAttribute('autocomplete')).toBe('new-password');
      unmount();
    }
  });

  it('marks non-secret inputs autoComplete="off"', () => {
    render(<CustomAppForm provider="outlook" label="Microsoft" onSaved={() => {}} />);
    expect(screen.getByLabelText('Client ID').getAttribute('autocomplete')).toBe('off');
    expect(screen.getByLabelText(/tenant/i).getAttribute('autocomplete')).toBe('off');
  });
});
