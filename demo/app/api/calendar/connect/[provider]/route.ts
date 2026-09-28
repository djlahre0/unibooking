import {
  appOrigin,
  customOAuthClient,
  isSaneCred,
  oauthClient,
  readCalendarConfig,
  redirectUri,
  scopesFor,
} from '@/lib/calendar/config';
import {
  FLOW_COOKIE,
  FLOW_TTL_S,
  isSecure,
  parseCookies,
  seal,
  writeCookie,
} from '@/lib/calendar/session';
import {
  backToCalendar,
  clientIp,
  disabled,
  forbidden,
  json,
  rateLimited,
  redirect,
  sameOrigin,
} from '@/lib/calendar/http';
import { isOAuthProvider } from '@/lib/calendar/types';
import { allow } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * Step 1 of "Continue with Google/Microsoft": build the provider's consent URL
 * with the library's OAuth client (PKCE S256 + a random `state`), remember both
 * in a short-lived sealed cookie, and send the browser to the provider.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  const config = readCalendarConfig();
  const origin = appOrigin(req, config);
  if (!isOAuthProvider(provider) || !config.providers[provider]) {
    return redirect(backToCalendar(origin, { error: 'not_configured' }));
  }

  const oauth = oauthClient(config, provider, redirectUri(origin, provider));
  const { url, state, codeVerifier } = await oauth.authorizationUrl({
    pkce: true,
    scopes: scopesFor(provider),
  });
  const flow = await seal(
    config.sessionSecret,
    FLOW_COOKIE,
    { provider, state, codeVerifier },
    FLOW_TTL_S,
  );
  return redirect(
    url,
    writeCookie(FLOW_COOKIE, flow, {
      maxAge: FLOW_TTL_S,
      secure: isSecure(),
      existing: parseCookies(req.headers.get('cookie')),
    }),
  );
}

/**
 * Step 1 of "bring your own OAuth app": the visitor posts their own client id
 * and secret instead of using the deployer's one-click button. Same PKCE +
 * state dance as GET above, but the authorize URL is built from the
 * visitor's own credentials (never `config.google`/`config.microsoft`), and
 * those credentials travel sealed in the flow cookie, never echoed back in
 * this response, so the callback, which has no server-side record of this
 * visitor's app, can complete the code exchange with the same app that
 * started it.
 *
 * A JSON body/response (not a raw redirect) so a bad client id/secret comes
 * back as an ordinary ActionResult the form can show inline, the same as
 * every other credential-entry flow in this demo; the browser then navigates
 * itself to the returned `url`. An optional `tenant` (Microsoft only: the
 * visitor's own Entra app registration may be restricted to one directory)
 * travels the same way; Microsoft defaults it to `common` when omitted.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  const config = readCalendarConfig();
  const origin = appOrigin(req, config);
  if (!sameOrigin(req, origin)) return forbidden();
  if (!allow(clientIp(req))) return rateLimited();
  if (!config.enabled) return disabled(config.problem); // sealing needs SESSION_SECRET
  if (!isOAuthProvider(provider)) {
    return json({ ok: false, error: { code: 'INVALID_INPUT', message: 'Unknown provider.' } }, 400);
  }

  let body: { clientId?: unknown; clientSecret?: unknown; tenant?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(
      { ok: false, error: { code: 'INVALID_INPUT', message: 'Invalid JSON body.' } },
      400,
    );
  }
  // Validated before anything touches them, and this message never repeats
  // what was submitted, no secret in an error, ever.
  if (!isSaneCred(body.clientId) || !isSaneCred(body.clientSecret)) {
    return json(
      {
        ok: false,
        error: { code: 'INVALID_INPUT', message: 'Enter a client ID and client secret.' },
      },
      400,
    );
  }
  // Tenant is optional (Microsoft only: defaults to `common`), but if given
  // it gets the same sanity bound as the id/secret before it touches anything.
  if (body.tenant !== undefined && !isSaneCred(body.tenant)) {
    return json(
      { ok: false, error: { code: 'INVALID_INPUT', message: 'Tenant is not a valid value.' } },
      400,
    );
  }
  const clientId = body.clientId.trim();
  const clientSecret = body.clientSecret.trim();
  const tenant = isSaneCred(body.tenant) ? body.tenant.trim() : undefined;

  const oauth = customOAuthClient(
    provider,
    { clientId, clientSecret, ...(tenant ? { tenant } : {}) },
    redirectUri(origin, provider),
  );
  const { url, state, codeVerifier } = await oauth.authorizationUrl({
    pkce: true,
    scopes: scopesFor(provider),
  });
  const flow = await seal(
    config.sessionSecret,
    FLOW_COOKIE,
    { provider, state, codeVerifier, custom: { clientId, clientSecret, ...(tenant ? { tenant } : {}) } },
    FLOW_TTL_S,
  );
  return json(
    { ok: true, data: { url } },
    200,
    writeCookie(FLOW_COOKIE, flow, {
      maxAge: FLOW_TTL_S,
      secure: isSecure(),
      existing: parseCookies(req.headers.get('cookie')),
    }),
  );
}
