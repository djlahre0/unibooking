import { timingSafeEqual } from 'node:crypto';
import { google } from 'unibooking/adapters/google';
import { outlook } from 'unibooking/adapters/outlook';
import type { BookingClient } from 'unibooking';
import {
  appOrigin,
  customOAuthClient,
  oauthClient,
  readCalendarConfig,
  redirectUri,
} from '@/lib/calendar/config';
import {
  FLOW_COOKIE,
  clearCookie,
  parseCookies,
  readCookie,
  sessionCookies,
  unseal,
  type FlowState,
} from '@/lib/calendar/session';
import { backToCalendar, redirect } from '@/lib/calendar/http';
import { storedTokens } from '@/lib/calendar/ops';
import { isOAuthProvider, type Account } from '@/lib/calendar/types';

export const runtime = 'nodejs';

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** An OAuth 2.0 `error` value is one of a small set of fixed, spec-defined
 *  identifiers (RFC 6749 §4.1.2.1, §5.2 -- `access_denied`, `invalid_client`,
 *  `redirect_uri_mismatch`, etc.), never user data and never secret, so unlike
 *  `error_description` (provider free text -- see the doc comment on GET
 *  below) it is safe to put in the redirect for the tab to read and explain.
 *  Still shape-checked before it travels anywhere: a provider that sent
 *  something else, or a crafted request straight to this route, falls back to
 *  a fixed code instead of reflecting arbitrary text. */
const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/;

function oauthErrorCode(raw: string): string {
  return OAUTH_ERROR_CODE.test(raw) ? raw : 'oauth_error';
}

/** Who just connected. Google's liveness probe does not name the account, but
 *  the primary calendar's id is the account's email address. */
async function identify(client: BookingClient, fallback: Account): Promise<Account> {
  if (client.id !== 'google' || !client.listCalendars) return fallback;
  const { calendars } = await client.listCalendars();
  const primary = calendars.find((c) => c.primary);
  return primary ? { email: primary.id, name: primary.name } : fallback;
}

/**
 * Step 2: the provider sends the browser back here. Verify it is the same
 * handshake we started (state, compared in constant time), exchange the code
 * with the PKCE verifier, confirm the new tokens actually work, and seal them
 * into the session cookie. Any failure lands back on the tab with a fixed
 * code -- the OAuth `error` CODE (see `oauthErrorCode` above) rides along so
 * the tab can give honest, specific guidance, but the provider's free-text
 * `error_description` is never forwarded.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  const config = readCalendarConfig();
  const origin = appOrigin(req, config);
  const cookies = parseCookies(req.headers.get('cookie'));
  const clearFlow = clearCookie(FLOW_COOKIE, cookies);

  // Provider name validity only here -- NOT `config.providers[provider]`: a
  // "bring your own OAuth app" flow deliberately has no deployer config for
  // this provider, and whether one was actually started is what the flow
  // cookie check just below settles either way. Checked before `fail` below
  // is defined, so an invalid route slug is never the thing echoed back.
  if (!isOAuthProvider(provider))
    return redirect(backToCalendar(origin, { error: 'not_configured' }), clearFlow);

  // From here `provider` is a known OAuthProvider (never arbitrary route-slug
  // text), so every failure below can safely name it -- the tab uses this for
  // provider-specific help, e.g. the exact redirect URL to register after a
  // redirect_uri_mismatch.
  const fail = (error: string) => redirect(backToCalendar(origin, { error, provider }), clearFlow);

  const url = new URL(req.url);
  const rawError = url.searchParams.get('error');
  if (rawError) return fail(oauthErrorCode(rawError));

  const flow = await unseal<FlowState>(
    config.sessionSecret,
    FLOW_COOKIE,
    readCookie(cookies, FLOW_COOKIE),
  );
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!flow || flow.provider !== provider || !code || !state || !sameState(state, flow.state)) {
    return fail('state_mismatch');
  }
  // Not a custom app, and the deployer hasn't configured one either: nothing
  // to exchange with. Can't happen via this app's own UI today -- GET
  // /connect above already redirects to not_configured, and POST /connect
  // only ever seals a flow cookie for a custom app -- but a flow cookie for a
  // since-removed deployer config should fail closed here rather than throw
  // inside oauthClient().
  if (!flow.custom && !config.providers[provider]) return fail('not_configured');

  try {
    // A custom app's client id/secret came from the visitor, sealed in the
    // flow cookie above; the deployer's own app (if any) comes from env
    // config. Never mixed: a refresh later must use whichever one issued the
    // token, so which one that was has to survive into the session (below).
    const oauth = flow.custom
      ? customOAuthClient(provider, flow.custom, redirectUri(origin, provider))
      : oauthClient(config, provider, redirectUri(origin, provider));
    const tokens = await oauth.exchangeCode(code, { codeVerifier: flow.codeVerifier });
    const client =
      provider === 'google'
        ? google({ accessToken: tokens.accessToken })
        : outlook({ accessToken: tokens.accessToken });
    const health = await client.checkConnection();
    if (!health.ok) return fail('exchange_failed');
    const account = await identify(client, health.account ?? {});
    const session = await sessionCookies(
      {
        provider,
        tokens: storedTokens(tokens),
        account,
        // Sealed into the session cookie alongside the tokens -- never
        // returned to the page (see status/route.ts) -- because refreshing
        // this token later needs the SAME client id/secret that requested it;
        // the deployer's env-configured app, if any, is a different app.
        ...(flow.custom ? { custom: flow.custom } : {}),
      },
      config,
      cookies,
    );
    return redirect(backToCalendar(origin, { connected: provider }), [...session, ...clearFlow]);
  } catch {
    return fail('exchange_failed');
  }
}
