import { defineOAuth, type OAuthClient, type OAuthConfig } from './core';

/**
 * Google Calendar OAuth2. **Server-only** — takes a client secret.
 *
 * `access_type=offline` and `prompt=consent` are set unconditionally, and both
 * are load-bearing: without them Google issues **no refresh token**, and the
 * integration silently degrades to a one-hour access token with no way to renew
 * it. `prompt=consent` also forces re-issue for a user who has already
 * consented, which is what makes reconnecting actually work.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

export function googleOAuth(config: OAuthConfig): OAuthClient {
  return defineOAuth({
    ...config,
    provider: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    defaultScopes: GOOGLE_CALENDAR_SCOPES,
    bodyFormat: 'form',
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
  });
}
