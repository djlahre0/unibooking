import type { OAuthClient } from 'unibooking/oauth';
import { googleOAuth, GOOGLE_CALENDAR_SCOPES } from 'unibooking/oauth/google';
import { outlookOAuth } from 'unibooking/oauth/microsoft';
import { readOAuthApps, type OAuthAppsOverrides } from './oauth-apps';
import { resolveSessionSecret, type SecretOverrides } from './secret';
import type { CalendarProvider, OAuthProvider } from './types';

/**
 * My Calendar configuration — SERVER ONLY. The demo needs no environment
 * variables: the cookie-sealing key is resolved by `./secret` (env override,
 * else a generated + persisted file, else an in-memory key for this process —
 * see that module's doc comment), so `enabled` is true in the normal case.
 *
 * The one-click "Continue with Google/Microsoft" app an operator registers
 * once, for every later visitor to sign in through, comes from either of two
 * sources — env, or the operator's own saved setup — in this precedence:
 *
 *   1. GOOGLE_CLIENT_ID/SECRET, MICROSOFT_CLIENT_ID/SECRET/TENANT in the
 *      environment. Optional, and kept as a higher-precedence override for
 *      hosting that manages secrets that way (e.g. Vercel project settings).
 *   2. Otherwise, whatever the operator saved from the My Calendar or
 *      Connect tab while visiting from localhost (see the loopback-gated
 *      setup route) — persisted to `./oauth-apps.ts`'s git-ignored file, the
 *      same way `./secret.ts` persists the cookie-sealing key.
 *
 *   APP_URL   Optional public origin, for deployments behind a proxy where
 *             the request URL is an internal host.
 *
 * Apple needs no OAuth app: the user signs in with an app-specific password.
 */
export interface CalendarConfig {
  enabled: boolean;
  problem?: string;
  sessionSecret: string;
  providers: Record<CalendarProvider, boolean>;
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string; clientSecret: string; tenant: string };
  appUrl?: string;
}

const MIN_SECRET = 32;

/** Outlook needs `offline_access` for a refresh token and `User.Read` for the
 *  `/me` identity read that `checkConnection` performs. */
const OUTLOOK_DEMO_SCOPES = ['offline_access', 'User.Read', 'Calendars.ReadWrite'];

function value(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

/** The env var pair that outranks the saved file for each provider, below. */
const ENV_KEYS: Record<OAuthProvider, readonly [string, string]> = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  outlook: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
};

/**
 * Whether this provider's credentials come from the environment rather than
 * `.oauth-apps.json`. `readCalendarConfig` below prefers env over the saved
 * file, so deleting the file entry for an env-configured provider would
 * report success and change nothing the visitor can see — the reset route
 * checks this first and says to change the env vars instead.
 */
export function isConfiguredByEnv(
  provider: OAuthProvider,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const [idKey, secretKey] = ENV_KEYS[provider];
  return !!value(env, idKey) && !!value(env, secretKey);
}

export function readCalendarConfig(
  env: Record<string, string | undefined> = process.env,
  secretOverrides: Pick<SecretOverrides, 'filePath'> = {},
  oauthAppsOverrides: OAuthAppsOverrides = {},
): CalendarConfig {
  const explicitSecret = value(env, 'SESSION_SECRET');
  // The only "genuinely broken" case left: a deployer set SESSION_SECRET
  // explicitly but it's too short. Silently falling back to the generated,
  // per-instance key (./secret) here would quietly reintroduce the exact
  // multi-instance session bug that override exists to prevent (see
  // README.md's serverless caveat) — better to fail loudly instead. Nothing
  // set at all is the normal case: it resolves through `resolveSessionSecret`
  // below and stays enabled.
  const problem =
    explicitSecret !== undefined && explicitSecret.length < MIN_SECRET
      ? `SESSION_SECRET must be at least ${MIN_SECRET} characters`
      : undefined;
  const enabled = problem === undefined;
  const secret = enabled ? resolveSessionSecret({ env, ...secretOverrides }).secret : '';

  // The operator's own saved setup — lower precedence than env, read
  // unconditionally (cheap and cached; see oauth-apps.ts) so `enabled` alone
  // still gates the `providers` booleans below exactly as before.
  const apps = readOAuthApps(oauthAppsOverrides);
  const gId = value(env, 'GOOGLE_CLIENT_ID') ?? apps.google?.clientId;
  const gSecret = value(env, 'GOOGLE_CLIENT_SECRET') ?? apps.google?.clientSecret;
  const mId = value(env, 'MICROSOFT_CLIENT_ID') ?? apps.outlook?.clientId;
  const mSecret = value(env, 'MICROSOFT_CLIENT_SECRET') ?? apps.outlook?.clientSecret;
  const appUrl = value(env, 'APP_URL');

  return {
    enabled,
    ...(problem ? { problem } : {}),
    sessionSecret: secret,
    providers: {
      google: enabled && !!gId && !!gSecret,
      outlook: enabled && !!mId && !!mSecret,
      apple: enabled,
    },
    ...(gId && gSecret ? { google: { clientId: gId, clientSecret: gSecret } } : {}),
    ...(mId && mSecret
      ? {
          microsoft: {
            clientId: mId,
            clientSecret: mSecret,
            tenant: value(env, 'MICROSOFT_TENANT') ?? apps.outlook?.tenant ?? 'common',
          },
        }
      : {}),
    ...(appUrl ? { appUrl } : {}),
  };
}

/** The public origin redirects and the Origin check are built against. */
export function appOrigin(req: Request, config: CalendarConfig): string {
  return new URL(config.appUrl ?? req.url).origin;
}

/** Must match a redirect URI registered with the provider exactly. */
export function redirectUri(origin: string, provider: OAuthProvider): string {
  return `${origin}/api/calendar/callback/${provider}`;
}

export function scopesFor(provider: OAuthProvider): string[] {
  return provider === 'google' ? [...GOOGLE_CALENDAR_SCOPES] : [...OUTLOOK_DEMO_SCOPES];
}

/** The library's OAuth client for a configured provider. Throws if the
 *  provider is not configured — callers check `providers[p]` first. */
export function oauthClient(
  config: CalendarConfig,
  provider: OAuthProvider,
  redirect: string,
): OAuthClient {
  if (provider === 'google') {
    if (!config.google) throw new Error('Google sign-in is not configured');
    return googleOAuth({ ...config.google, redirectUri: redirect });
  }
  if (!config.microsoft) throw new Error('Microsoft sign-in is not configured');
  return outlookOAuth({ ...config.microsoft, redirectUri: redirect });
}

/** A visitor's own client id/secret, as posted to the connect route for
 *  "bring your own OAuth app". `tenant` is Microsoft-only (a visitor's own
 *  Entra app registration may be restricted to one directory); Google
 *  ignores it if present. Absent, Microsoft's own default (`common`) applies —
 *  see `customOAuthClient` below. */
export interface CustomOAuthCreds {
  clientId: string;
  clientSecret: string;
  tenant?: string;
}

/** The upper bound on how long a submitted client id/secret/tenant may be.
 *  Generous for every real provider's own format (Google's client ids and
 *  secrets are well under 200 chars; Microsoft's are GUID/base64-ish and
 *  shorter still) — this exists only to reject obvious junk before it is
 *  ever used, not to encode a real provider limit. */
const MAX_CUSTOM_CRED_LEN = 512;

/** True for a non-empty, sanely-bounded string — what a submitted client id,
 *  client secret or tenant must be before it touches anything. Anything else
 *  is INVALID_INPUT, checked by the caller before any request is made. */
export function isSaneCred(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const trimmed = v.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_CUSTOM_CRED_LEN;
}

/**
 * The library's OAuth client built directly from a visitor-supplied client
 * id/secret — "bring your own OAuth app". Deliberately never reads
 * `config.google`/`config.microsoft`: this is the visitor's own app, not the
 * deployer's, and the two must never be conflated (refreshing a token later
 * has to use the SAME client id/secret that requested it). The authorize and
 * token URLs still come from the library's fixed `googleOAuth`/`outlookOAuth`
 * helpers — only the id/secret/tenant are attacker-controlled input, never a
 * host, so this cannot become an SSRF vector. `creds.tenant` reaches
 * `outlookOAuth` through the spread below, which already defaults an absent
 * tenant to `common` (see src/oauth/microsoft.ts) — Google's client silently
 * ignores the extra property.
 */
export function customOAuthClient(
  provider: OAuthProvider,
  creds: CustomOAuthCreds,
  redirect: string,
): OAuthClient {
  return provider === 'google'
    ? googleOAuth({ ...creds, redirectUri: redirect })
    : outlookOAuth({ ...creds, redirectUri: redirect }); // default 'common' tenant
}
