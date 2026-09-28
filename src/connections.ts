import { UnibookingError } from './errors';
import {
  PROVIDER_CREDENTIALS,
  matchCredentialSet,
  requiredCredentials,
  type CredentialSet,
} from './credentials';
import type {
  AdapterFactory,
  BookingClient,
  ClientOptions,
  CredsInput,
  ProviderCredentials,
  ProviderId,
} from './types';
import {
  withAutoRefresh,
  type OAuthClient,
  type OAuthConfig,
  type OAuthTokens,
} from './oauth/core';

import { acuityOAuth } from './oauth/acuity';
import { calendlyOAuth } from './oauth/calendly';
import { googleOAuth } from './oauth/google';
import { microsoftBookingsOAuth, outlookOAuth } from './oauth/microsoft';
import { setmoreOAuth } from './oauth/setmore';
import { squareOAuth } from './oauth/square';
import { wixOAuth } from './oauth/wix';

import { acuity } from './adapters/acuity';
import { apple } from './adapters/apple';
import { bookeo } from './adapters/bookeo';
import { booker } from './adapters/booker';
import { boulevard } from './adapters/boulevard';
import { calendly } from './adapters/calendly';
import { google } from './adapters/google';
import { mangomint } from './adapters/mangomint';
import { microsoftBookings } from './adapters/microsoft_bookings';
import { mindbody } from './adapters/mindbody';
import { outlook } from './adapters/outlook';
import { phorest } from './adapters/phorest';
import { setmore } from './adapters/setmore';
import { square } from './adapters/square';
import { vagaro } from './adapters/vagaro';
import { wix } from './adapters/wix';
import { zenoti } from './adapters/zenoti';

/**
 * Per-tenant connections, for consumers running many tenants against many
 * providers.
 *
 * **Server-only.** This module imports `src/oauth/*`, which must never reach a
 * browser bundle, which is why it is the `unibooking/connections` subpath and
 * not part of the package root. The credential schema it builds on IS at the
 * root, because a consumer's connect form needs it client-side.
 *
 * The library remains stateless. It defines the store interface; it never
 * implements one, never holds a credential between calls, and ships none.
 */

/** What a consumer persists for one tenant + provider. */
export interface ConnectionRecord {
  provider: ProviderId;
  /** Present when the provider authenticates with OAuth. */
  tokens?: OAuthTokens;
  /** Keys, and provider-specific ids: `calendarId`, `locationId`, `siteId`… */
  fields?: Record<string, string>;
}

/**
 * The persistence port. Implement it against your own database.
 *
 * Encrypting `tokens` and `fields` at rest is your responsibility: they are
 * live credentials. Use your platform's KMS, or `node:crypto` with a key from
 * your environment, never a key committed to your repository.
 */
export interface ConnectionStore {
  get(tenantId: string, provider: ProviderId): Promise<ConnectionRecord | undefined>;
  put(tenantId: string, provider: ProviderId, record: ConnectionRecord): Promise<void>;
  delete(tenantId: string, provider: ProviderId): Promise<void>;
  /** Optional: powers "which calendars has this tenant connected?". */
  list?(tenantId: string): Promise<ConnectionRecord[]>;
}

/** An adapter factory with its credential type erased. */
type AnyAdapter = (
  creds: CredsInput<ProviderCredentials>,
  options?: ClientOptions,
) => BookingClient;

/**
 * Each `AdapterFactory<T>` is contravariant in its own credential type, so it
 * cannot be widened by assignment. The erasure is sound because the runtime
 * check does what the compiler cannot see: `matchCredentialSet` has already
 * confirmed every field the adapter's type requires is present, against the
 * schema that `test/credentials.test.ts` pins to those same types. One cast,
 * here, rather than seventeen at the call sites.
 */
const erase = <T extends ProviderCredentials>(f: AdapterFactory<T>): AnyAdapter =>
  f as unknown as AnyAdapter;

interface Wiring {
  adapter: AnyAdapter;
  /** Absent for providers with no OAuth flow. */
  oauth?: (app: OAuthConfig) => OAuthClient;
  /** Which stored field carries the OAuth access token for this provider.
   *  Calendly calls it `token`; everything else `accessToken`. */
  tokenField?: string;
}

/**
 * The mapping every consumer would otherwise hand-write for all 17 providers:
 * which adapter, which OAuth client, and where the access token belongs in the
 * credential object. Internal, so credential shapes stay an implementation
 * detail rather than public API.
 */
const WIRING: Record<ProviderId, Wiring> = {
  google: { adapter: erase(google), oauth: googleOAuth, tokenField: 'accessToken' },
  outlook: { adapter: erase(outlook), oauth: outlookOAuth, tokenField: 'accessToken' },
  microsoft_bookings: {
    adapter: erase(microsoftBookings),
    oauth: microsoftBookingsOAuth,
    tokenField: 'accessToken',
  },
  square: { adapter: erase(square), oauth: squareOAuth, tokenField: 'accessToken' },
  acuity: { adapter: erase(acuity), oauth: acuityOAuth, tokenField: 'accessToken' },
  calendly: { adapter: erase(calendly), oauth: calendlyOAuth, tokenField: 'token' },
  setmore: { adapter: erase(setmore), oauth: setmoreOAuth, tokenField: 'accessToken' },
  wix: { adapter: erase(wix), oauth: wixOAuth, tokenField: 'accessToken' },
  apple: { adapter: erase(apple) },
  bookeo: { adapter: erase(bookeo) },
  booker: { adapter: erase(booker) },
  mindbody: { adapter: erase(mindbody) },
  vagaro: { adapter: erase(vagaro) },
  zenoti: { adapter: erase(zenoti) },
  boulevard: { adapter: erase(boulevard) },
  phorest: { adapter: erase(phorest) },
  mangomint: { adapter: erase(mangomint) },
};

const fail = (provider: ProviderId, code: 'AUTH' | 'INVALID_INPUT', message: string): never => {
  throw new UnibookingError({ provider, code, message });
};

/**
 * Names what is missing, never what was supplied. An error message is a place
 * a credential leaks into a log, so this only ever prints field *keys*.
 */
function missingFields(provider: ProviderId, fields: Record<string, string>): string {
  const perSet = PROVIDER_CREDENTIALS[provider].map((set) => {
    const missing = set.fields.filter((f) => f.required && !fields[f.key]).map((f) => f.key);
    return `${set.kind}: needs ${missing.join(', ')}`;
  });
  return perSet.join('; or ');
}

export interface ConnectionOptions {
  tenantId: string;
  provider: ProviderId;
  store: ConnectionStore;
  /** YOUR OAuth app, from YOUR environment. Required for a provider whose
   *  stored tokens can expire; the package supplies no client id or secret. */
  app?: OAuthConfig;
  /** Passed straight to the adapter (custom fetch, baseUrl, timeouts). */
  clientOptions?: ClientOptions;
}

/**
 * Build a ready `BookingClient` for one tenant's stored connection.
 *
 * For an OAuth provider with a refresh token, credentials resolve through
 * `withAutoRefresh`, so an expiring token is refreshed and written back
 * through `store.put` **before** the request goes out. A failed write aborts
 * the request rather than proceeding with tokens the store never received:
 * that ordering is what stops a refresh token being lost permanently.
 *
 * A fresh client is returned per call. There is deliberately no cross-tenant
 * cache: a cache keyed wrong hands one tenant another's credentials, and the
 * convenience does not justify that.
 */
export async function connectionFor(opts: ConnectionOptions): Promise<BookingClient> {
  const { tenantId, provider, store, app, clientOptions } = opts;
  const wiring = WIRING[provider];
  if (!wiring) fail(provider, 'INVALID_INPUT', `Unknown provider '${String(provider)}'.`);

  const record = await store.get(tenantId, provider);
  if (!record) {
    // AUTH rather than a new NOT_CONNECTED code: `ErrorCode` is exported and
    // consumers switch on it exhaustively, so widening it would break them,
    // and AUTH is already documented as missing/invalid/expired credentials.
    fail(provider, 'AUTH', `No stored connection for this tenant and ${provider}.`);
  }

  const fields: Record<string, string> = { ...record!.fields };
  const tokens = record!.tokens;

  // Tokens live in their own field on the record; fold the access token into
  // the credential object under whichever key this provider expects.
  if (tokens?.accessToken && wiring.tokenField) fields[wiring.tokenField] ??= tokens.accessToken;

  const set: CredentialSet | undefined = matchCredentialSet(provider, fields);
  if (!set) {
    fail(
      provider,
      'INVALID_INPUT',
      `Incomplete credentials -- ${missingFields(provider, fields)}.`,
    );
  }

  // Non-OAuth, or OAuth with nothing to refresh: the stored values are used
  // as-is. A provider with no refresh token (Vagaro, Setmore's short-lived
  // bearer) legitimately lands here.
  if (set!.kind !== 'oauth' || !tokens?.refreshToken) {
    return wiring.adapter(fields as ProviderCredentials, clientOptions);
  }

  if (!wiring.oauth) {
    return wiring.adapter(fields as ProviderCredentials, clientOptions);
  }
  if (!app) {
    fail(
      provider,
      'INVALID_INPUT',
      `${provider} has a refresh token but no OAuth app was supplied. Pass your own clientId/clientSecret/redirectUri as \`app\`.`,
    );
  }

  const creds = withAutoRefresh<ProviderCredentials>({
    oauth: wiring.oauth(app!),
    tokens,
    onRefresh: async (next) => {
      await store.put(tenantId, provider, { ...record!, tokens: next });
    },
    toCreds: (t) => ({ ...fields, [wiring.tokenField!]: t.accessToken }) as ProviderCredentials,
  });

  return wiring.adapter(creds, clientOptions);
}

/**
 * Remove a tenant's stored connection. A thin pass-through, here so a consumer
 * has one place for the whole lifecycle rather than reaching into the store
 * for one half of it.
 */
export async function disconnect(
  tenantId: string,
  provider: ProviderId,
  store: ConnectionStore,
): Promise<void> {
  await store.delete(tenantId, provider);
}

export { requiredCredentials };
export type { CredentialSet, OAuthConfig, OAuthTokens };
