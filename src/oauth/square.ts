import {
  defineOAuth,
  parseStandardTokens,
  type OAuthClient,
  type OAuthConfig,
  type OAuthTokens,
} from './core';
import { UnibookingError } from '../errors';

/** Square's scope list for an appointments integration. */
export const SQUARE_APPOINTMENT_SCOPES = [
  'APPOINTMENTS_ALL_READ',
  'APPOINTMENTS_ALL_WRITE',
  'APPOINTMENTS_READ',
  'APPOINTMENTS_WRITE',
  'APPOINTMENTS_BUSINESS_SETTINGS_READ',
  'CUSTOMERS_READ',
  'CUSTOMERS_WRITE',
  'EMPLOYEES_READ',
  'ITEMS_READ',
  'MERCHANT_PROFILE_READ',
];

export interface SquareOAuthConfig extends OAuthConfig {
  /** Point at the sandbox host during development. Defaults to production. */
  baseUrl?: string;
}

/**
 * Square OAuth2. **Server-only** — takes a client secret.
 *
 * Square deviates from the standard token response in one way that matters: it
 * returns `expires_at` as an **RFC3339 string**, not `expires_in` seconds. A
 * standard parser reads no expiry at all from that, which would leave
 * `withAutoRefresh` unable to ever refresh proactively.
 *
 * It also returns `merchant_id`, reachable via `tokens.raw`.
 *
 * Note the scope list above omits `ITEMS_WRITE`: this library only reads the
 * catalog. Requesting write scopes you do not use is a needless escalation, and
 * adding one later forces every connected merchant to re-consent.
 */
export function squareOAuth(config: SquareOAuthConfig): OAuthClient {
  const base = (config.baseUrl ?? 'https://connect.squareup.com').replace(/\/$/, '');
  return defineOAuth({
    ...config,
    provider: 'square',
    authorizeUrl: `${base}/oauth2/authorize`,
    tokenUrl: `${base}/oauth2/token`,
    defaultScopes: SQUARE_APPOINTMENT_SCOPES,
    bodyFormat: 'json',
    parseTokens: (provider, raw, now): OAuthTokens => {
      // Parse the standard fields first so an access_token is still required.
      const std = parseStandardTokens(provider, raw, now);
      if (typeof raw?.expires_at !== 'string') return std;
      const ms = Date.parse(raw.expires_at);
      if (Number.isNaN(ms)) {
        throw new UnibookingError({
          provider: 'square',
          code: 'UPSTREAM',
          message: `Square returned an unparseable expires_at: ${raw.expires_at}`,
        });
      }
      return { ...std, expiresAt: new Date(ms).toISOString() };
    },
  });
}
