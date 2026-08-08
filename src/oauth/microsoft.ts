import { defineOAuth, type OAuthClient, type OAuthConfig } from './core';

/**
 * Microsoft identity platform OAuth2, shared by the `outlook` and
 * `microsoft_bookings` adapters. **Server-only** — takes a client secret.
 *
 * `offline_access` is required for a refresh token and is added automatically if
 * you do not include it — omitting it yields an access token that simply expires
 * with no way to renew, which is the same trap as Google's `access_type`.
 */
export interface MicrosoftOAuthConfig extends OAuthConfig {
  /** Directory tenant: a tenant id, `organizations`, `consumers`, or `common`
   *  (the default — works for both work/school and personal accounts). */
  tenant?: string;
}

export const OUTLOOK_SCOPES = ['offline_access', 'Calendars.ReadWrite'];
export const BOOKINGS_SCOPES = ['offline_access', 'Bookings.ReadWrite.All'];

function build(
  provider: 'outlook' | 'microsoft_bookings',
  defaultScopes: string[],
  config: MicrosoftOAuthConfig,
): OAuthClient {
  const tenant = encodeURIComponent(config.tenant ?? 'common');
  const inner = defineOAuth({
    ...config,
    provider,
    authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    defaultScopes,
    bodyFormat: 'form',
  });

  return {
    ...inner,
    authorizationUrl(options) {
      // Guarantee offline_access whatever the caller passes, otherwise a custom
      // scope list quietly costs them refresh entirely.
      const scopes = options?.scopes ?? defaultScopes;
      const withOffline = scopes.includes('offline_access')
        ? scopes
        : ['offline_access', ...scopes];
      return inner.authorizationUrl({ ...options, scopes: withOffline });
    },
  };
}

export function outlookOAuth(config: MicrosoftOAuthConfig): OAuthClient {
  return build('outlook', OUTLOOK_SCOPES, config);
}

export function microsoftBookingsOAuth(config: MicrosoftOAuthConfig): OAuthClient {
  return build('microsoft_bookings', BOOKINGS_SCOPES, config);
}
