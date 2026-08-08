import { defineOAuth, type OAuthClient, type OAuthConfig } from './core';

/**
 * Acuity Scheduling OAuth2. **Server-only** — takes a client secret.
 *
 * The token endpoint requires `application/x-www-form-urlencoded` and rejects a
 * JSON body, hence `bodyFormat: 'form'`.
 *
 * Acuity also supports API-key Basic auth, which the adapter accepts directly —
 * this module is only for the OAuth2 path.
 */
export function acuityOAuth(config: OAuthConfig): OAuthClient {
  return defineOAuth({
    ...config,
    provider: 'acuity',
    authorizeUrl: 'https://acuityscheduling.com/oauth2/authorize',
    tokenUrl: 'https://acuityscheduling.com/oauth2/token',
    defaultScopes: ['api-v1'],
    bodyFormat: 'form',
  });
}
