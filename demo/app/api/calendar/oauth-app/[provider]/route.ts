import {
  appOrigin,
  isConfiguredByEnv,
  isSaneCred,
  readCalendarConfig,
} from '@/lib/calendar/config';
import { removeOAuthApp, writeOAuthApp } from '@/lib/calendar/oauth-apps';
import { isOAuthProvider } from '@/lib/calendar/types';
import {
  clientIp,
  forbidden,
  isLoopbackRequest,
  json,
  localhostOnly,
  rateLimited,
  setupDisabled,
  sameOrigin,
} from '@/lib/calendar/http';
import { allow } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * The operator's one-time OAuth app registration: SERVER ONLY writes, and
 * the secret is never echoed back in the response (see writeOAuthApp's doc
 * comment on oauth-apps.ts, and status/route.ts, which reports only whether
 * a provider is configured).
 *
 * This is deliberately NOT the same thing as the "bring your own OAuth app"
 * POST on connect/[provider]/route.ts: that seals a VISITOR's own client
 * id/secret into their own short-lived sign-in cookie, used once, for their
 * own account, and is left working unchanged. This route instead persists
 * ONE app registration, server-side, that every later visitor then signs
 * into via the ordinary one-click "Continue with…" button: GET on
 * connect/[provider]/route.ts, also unchanged, which is exactly why this
 * route is restricted to the machine running the deployment: anyone who
 * could reach it remotely could plant an app every later visitor would then
 * unknowingly sign in through.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  const config = readCalendarConfig();
  const origin = appOrigin(req, config);
  if (!sameOrigin(req, origin)) return forbidden();
  // Setup does not exist in production, and this check comes FIRST because the
  // loopback test below trusts the `Host` header, which a non-browser client
  // (curl) can simply forge. On a reachable deployment that alone would let a
  // stranger plant an OAuth app every later visitor unknowingly signs in
  // through. NODE_ENV is set by the server process, not by the request, so it
  // is the only part of this gate a caller cannot influence. Configure a
  // production deployment with env vars, or by placing .oauth-apps.json on the
  // server.
  if (process.env.NODE_ENV === 'production') return setupDisabled();
  if (!isLoopbackRequest(req)) return localhostOnly();
  if (!allow(clientIp(req))) return rateLimited();
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
  if (body.tenant !== undefined && !isSaneCred(body.tenant)) {
    return json(
      { ok: false, error: { code: 'INVALID_INPUT', message: 'Tenant is not a valid value.' } },
      400,
    );
  }
  const clientId = body.clientId.trim();
  const clientSecret = body.clientSecret.trim();
  const tenant = isSaneCred(body.tenant) ? body.tenant.trim() : undefined;

  const saved = writeOAuthApp(provider, { clientId, clientSecret, ...(tenant ? { tenant } : {}) });
  if (!saved) {
    return json(
      {
        ok: false,
        error: {
          code: 'UPSTREAM',
          message: "Could not save: this deployment's filesystem is read-only.",
        },
      },
      500,
    );
  }
  return json({ ok: true, data: { saved: true } });
}

/**
 * Removes the saved registration so the operator can register a different
 * client id/secret from the setup form, instead of hand-editing
 * `.oauth-apps.json` and restarting.
 *
 * Gated identically to the POST above, in the same order and for the same
 * reason: on a reachable deployment an un-gated version of this would let a
 * stranger knock out sign-in for every visitor. Unsetting is not a smaller
 * privilege than setting, so it does not get a smaller gate.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  const config = readCalendarConfig();
  const origin = appOrigin(req, config);
  if (!sameOrigin(req, origin)) return forbidden();
  if (process.env.NODE_ENV === 'production') return setupDisabled();
  if (!isLoopbackRequest(req)) return localhostOnly();
  if (!allow(clientIp(req))) return rateLimited();
  if (!isOAuthProvider(provider)) {
    return json({ ok: false, error: { code: 'INVALID_INPUT', message: 'Unknown provider.' } }, 400);
  }

  // Env vars outrank the saved file (see config.ts), so for an env-configured
  // provider this would delete a file entry and leave the card exactly as it
  // was. Say where the setting actually lives rather than report a success
  // that changes nothing.
  if (isConfiguredByEnv(provider)) {
    return json(
      {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message:
            'This provider is configured by environment variables, which take precedence. Change them where this deployment sets them.',
        },
      },
      409,
    );
  }

  if (!removeOAuthApp(provider)) {
    return json(
      {
        ok: false,
        error: {
          code: 'UPSTREAM',
          message: "Could not reset: this deployment's filesystem is read-only.",
        },
      },
      500,
    );
  }
  return json({ ok: true, data: { reset: true } });
}
