import { defineOAuth, type OAuthClient, type OAuthConfig } from './core';

/**
 * Calendly OAuth2. **Server-only** — takes a client secret.
 *
 * Authorization codes expire after **10 minutes**, so the callback must
 * exchange promptly rather than queueing the work.
 *
 * Calendly recommends PKCE; pass `pkce: true` to `authorizationUrl` and hand the
 * returned `codeVerifier` back to `exchangeCode`.
 */
export function calendlyOAuth(config: OAuthConfig): OAuthClient {
  return defineOAuth({
    ...config,
    provider: 'calendly',
    authorizeUrl: 'https://auth.calendly.com/oauth/authorize',
    tokenUrl: 'https://auth.calendly.com/oauth/token',
    // Calendly scopes are assigned to the OAuth app itself rather than
    // requested per authorization, so none are sent by default.
    defaultScopes: [],
    bodyFormat: 'json',
  });
}
