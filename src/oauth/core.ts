import type { CredsInput, ProviderCredentials, ProviderId } from '../types';
import { UnibookingError, codeForStatus } from '../errors';

/**
 * Stateless OAuth helpers.
 *
 * ## Server-only
 *
 * Every client here takes a **client secret**. Nothing under `unibooking/oauth`
 * may be imported into browser code, and no adapter imports it — so bundling an
 * adapter can never drag secrets-handling code into a client build.
 *
 * ## Nothing is persisted
 *
 * These are pure functions: configuration and inputs in, token data out. The
 * library never stores a token. Persistence is the consumer's job, which is the
 * same contract `CredsInput`'s function form already establishes.
 */

export interface OAuthTokens {
  accessToken: string;
  /** Absent when the provider issues none, or when a refresh response omits it
   *  — Google returns a refresh token only on the first consent. */
  refreshToken?: string;
  /** RFC3339 instant. Derived from `expires_in` where the provider sends a
   *  duration, so a consumer never has to know which encoding it got. */
  expiresAt?: string;
  /** Space-separated, as GRANTED — which is not always what was requested. */
  scope?: string;
  raw: unknown;
}

export interface AuthorizationUrl {
  url: string;
  /** CSRF token. Generated unless the caller supplied one. Store it and compare
   *  on callback — this library cannot verify it for you without keeping state. */
  state: string;
  /** Present only when `pkce: true`. Store alongside `state` and pass it back to
   *  `exchangeCode`. */
  codeVerifier?: string;
}

export interface AuthorizationUrlOptions {
  scopes?: string[];
  state?: string;
  /** Generate a PKCE verifier/challenge pair (S256). Providers that do not
   *  support PKCE ignore the extra parameters rather than failing, so enabling
   *  it is never a breaking choice. */
  pkce?: boolean;
  /** Merged into the query string for provider-specific parameters. */
  params?: Record<string, string>;
}

export interface OAuthClient {
  readonly provider: ProviderId;
  /** Async because PKCE challenges are derived with `crypto.subtle.digest`.
   *  Using the platform primitive rather than a bundled SHA-256 keeps
   *  security-sensitive code out of this package. */
  authorizationUrl(options?: AuthorizationUrlOptions): Promise<AuthorizationUrl>;
  exchangeCode(code: string, options?: { codeVerifier?: string }): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must match the value registered with the provider exactly. */
  redirectUri: string;
  /** Inject a custom fetch (testing, proxies, non-global-fetch runtimes). */
  fetch?: typeof fetch;
}

// --- primitives -------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomUrlSafe(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64Url(buf);
}

/** RFC 7636 S256: base64url(SHA-256(verifier)). */
async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

// --- token parsing ----------------------------------------------------------

/** Seconds-from-now → RFC3339 instant. */
function expiryFromSeconds(seconds: unknown, now: number): string | undefined {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(now + n * 1000).toISOString();
}

/**
 * The standard OAuth2 token response. Providers that deviate override this via
 * `parseTokens` — Square sends `expires_at` as an RFC3339 string rather than
 * `expires_in` seconds.
 */
export function parseStandardTokens(provider: ProviderId, raw: any, now: number): OAuthTokens {
  const accessToken = raw?.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new UnibookingError({
      provider,
      code: 'UPSTREAM',
      message: 'token response contained no access_token',
    });
  }
  const expiresAt = expiryFromSeconds(raw?.expires_in, now);
  return {
    accessToken,
    ...(typeof raw?.refresh_token === 'string' ? { refreshToken: raw.refresh_token } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof raw?.scope === 'string' ? { scope: raw.scope } : {}),
    raw,
  };
}

export interface DefineOAuthConfig extends OAuthConfig {
  provider: ProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  defaultScopes: string[];
  /** How the token request body is encoded. Acuity requires form encoding and
   *  rejects JSON; Square requires JSON. */
  bodyFormat: 'form' | 'json';
  /** Fixed extra parameters on the authorize URL — Google's
   *  `access_type=offline` + `prompt=consent`, without which no refresh token
   *  is ever issued. */
  authorizeParams?: Record<string, string>;
  /** Override for providers whose token response deviates from the standard. */
  parseTokens?: (provider: ProviderId, raw: any, now: number) => OAuthTokens;
  /** Injectable clock, for deterministic expiry assertions in tests. */
  now?: () => number;
}

/** Build a standard authorization-code OAuth client. */
export function defineOAuth(config: DefineOAuthConfig): OAuthClient {
  const now = config.now ?? (() => Date.now());
  const parse = config.parseTokens ?? parseStandardTokens;

  async function post(body: Record<string, string>): Promise<OAuthTokens> {
    const doFetch = config.fetch ?? globalThis.fetch;
    const isForm = config.bodyFormat === 'form';
    let res: Response;
    try {
      res = await doFetch(config.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json',
          accept: 'application/json',
        },
        body: isForm ? new URLSearchParams(body).toString() : JSON.stringify(body),
      });
    } catch (cause) {
      throw new UnibookingError({
        provider: config.provider,
        code: 'NETWORK',
        message: 'token request failed',
        cause,
      });
    }

    const text = await res.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { body: text };
    }

    if (!res.ok) {
      // OAuth2 error bodies are `{ error, error_description }`. The request body
      // is never echoed into the message — it carries the client secret.
      const detail = parsed?.error_description ?? parsed?.message ?? parsed?.error;
      throw new UnibookingError({
        provider: config.provider,
        code: codeForStatus(res.status),
        message: typeof detail === 'string' ? detail : `token endpoint returned ${res.status}`,
        httpStatus: res.status,
        ...(typeof parsed?.error === 'string' ? { providerCode: parsed.error } : {}),
      });
    }
    return parse(config.provider, parsed, now());
  }

  return {
    provider: config.provider,

    async authorizationUrl(options) {
      const state = options?.state ?? randomUrlSafe(16);
      const scopes = options?.scopes ?? config.defaultScopes;
      const url = new URL(config.authorizeUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('state', state);
      for (const [k, v] of Object.entries(config.authorizeParams ?? {})) {
        url.searchParams.set(k, v);
      }
      let codeVerifier: string | undefined;
      if (options?.pkce) {
        // RFC 7636: 43-128 unreserved characters. 32 random bytes base64url = 43.
        codeVerifier = randomUrlSafe(32);
        url.searchParams.set('code_challenge', await codeChallengeS256(codeVerifier));
        url.searchParams.set('code_challenge_method', 'S256');
      }
      // Caller params last so they can override anything above.
      for (const [k, v] of Object.entries(options?.params ?? {})) url.searchParams.set(k, v);
      return { url: url.toString(), state, ...(codeVerifier ? { codeVerifier } : {}) };
    },

    exchangeCode(code, options) {
      return post({
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        ...(options?.codeVerifier ? { code_verifier: options.codeVerifier } : {}),
      });
    },

    refresh(refreshToken) {
      return post({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
    },
  };
}

/** Throw a consistent UNSUPPORTED for an operation a provider's OAuth flow does
 *  not have (Setmore has no authorize step; Wix has no user redirect). */
export function unsupportedOAuth(provider: ProviderId, detail: string): never {
  throw new UnibookingError({ provider, code: 'UNSUPPORTED', message: detail });
}

// --- withAutoRefresh --------------------------------------------------------

export interface AutoRefreshConfig<TCreds extends ProviderCredentials> {
  oauth: OAuthClient;
  /** What you loaded from your database. */
  tokens: OAuthTokens;
  /** Called ONLY when a refresh actually happened. Persist here. */
  onRefresh: (tokens: OAuthTokens) => void | Promise<void>;
  /** Refresh this far ahead of expiry. Default 60_000. */
  skewMs?: number;
  /** Build the adapter's credential object from the current tokens. This is
   *  what varies per provider — Square also needs `locationId`, Google a
   *  `calendarId`. */
  toCreds: (tokens: OAuthTokens) => TCreds;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Bridge OAuth refresh into the adapter credential system.
 *
 * Returns a `CredsInput` function, so it is resolved fresh before every request
 * and cannot race a mid-request expiry. The library still stores nothing — the
 * `onRefresh` callback is how new tokens reach your database.
 *
 * Concurrent de-duplication is deliberately absent: an in-memory lock would be
 * per-process and would not dedupe across instances, which is misleading for
 * exactly the multi-instance deployments that would need it.
 */
export function withAutoRefresh<TCreds extends ProviderCredentials>(
  config: AutoRefreshConfig<TCreds>,
): CredsInput<TCreds> {
  const skewMs = config.skewMs ?? 60_000;
  const now = config.now ?? (() => Date.now());
  let current = config.tokens;

  return async (): Promise<TCreds> => {
    const expiresAt = current.expiresAt ? Date.parse(current.expiresAt) : NaN;
    // No expiry means the provider told us nothing. Guessing a lifetime would be
    // worse than its own silence — checkConnection covers the diagnosis.
    const stale = Number.isFinite(expiresAt) && now() >= expiresAt - skewMs;
    if (!stale || !current.refreshToken) return config.toCreds(current);

    const next = await config.oauth.refresh(current.refreshToken);
    // Google returns a refresh token only on first consent, so a refresh
    // response that omits one must not erase the token we still need.
    const merged: OAuthTokens = {
      ...next,
      ...(next.refreshToken ? {} : { refreshToken: current.refreshToken }),
    };
    // Persist BEFORE handing the credentials out. If the write fails the error
    // propagates and the request does not proceed — continuing as though the
    // token were saved is how a refresh token gets lost permanently.
    await config.onRefresh(merged);
    current = merged;
    return config.toCreds(merged);
  };
}
