/**
 * OAuth connect helpers — **server-only**.
 *
 * These take a client secret. Never import this subpath into browser code. No
 * adapter imports it, so bundling an adapter cannot pull it in by accident.
 *
 *   import { withAutoRefresh } from 'unibooking/oauth';
 *   import { googleOAuth } from 'unibooking/oauth/google';
 *
 * Nothing here persists anything. `exchangeCode` and `refresh` return token
 * data; storing it is yours. `withAutoRefresh` hands new tokens to an
 * `onRefresh` callback for exactly that reason.
 */
export {
  defineOAuth,
  withAutoRefresh,
  parseStandardTokens,
  unsupportedOAuth,
  type OAuthTokens,
  type OAuthClient,
  type OAuthConfig,
  type AuthorizationUrl,
  type AuthorizationUrlOptions,
  type AutoRefreshConfig,
  type DefineOAuthConfig,
} from './core';
