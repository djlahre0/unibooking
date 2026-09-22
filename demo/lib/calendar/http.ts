import type { ActionResult } from '../result';

/** Response helpers for the My Calendar routes — SERVER ONLY. Every response
 *  is `no-store`: they carry per-user data and, often, a fresh session cookie. */

function withCookies(headers: Headers, setCookies: string[]): Headers {
  headers.set('cache-control', 'no-store');
  for (const c of setCookies) headers.append('set-cookie', c);
  return headers;
}

export function json(body: ActionResult, status = 200, setCookies: string[] = []): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCookies(new Headers({ 'content-type': 'application/json' }), setCookies),
  });
}

export function redirect(location: string, setCookies: string[] = []): Response {
  return new Response(null, {
    status: 302,
    headers: withCookies(new Headers({ location }), setCookies),
  });
}

/** The My Calendar tab, with a status for its banner (`error=…`/`connected=…`).
 *  `error` is always either one of this app's own fixed codes or an OAuth
 *  `error` CODE already shape-checked by the callback route (see
 *  `oauthErrorCode` there) — never a provider's free-text `error_description`,
 *  which can contain arbitrary content. */
export function backToCalendar(origin: string, params: Record<string, string> = {}): string {
  const url = new URL('/', origin);
  url.searchParams.set('tab', 'calendar');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** State-changing requests must come from this app's own pages. SameSite=Lax
 *  already keeps the session cookie off cross-site POSTs; this is the second
 *  lock. Browsers send Origin on every POST, so a missing one is refused too. */
export function sameOrigin(req: Request, origin: string): boolean {
  return req.headers.get('origin') === origin;
}

export function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || 'unknown';
}

// `URL#hostname` keeps the brackets for an IPv6 literal (confirmed against
// Node's implementation: `new URL('http://[::1]:3000/').hostname === '[::1]'`),
// unlike the bare `::1` a Host header alone might show -- both forms are
// listed so either input shape matches.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * True only when the address THIS REQUEST ITSELF was made to is loopback —
 * i.e. its raw `Host` header, NOT `req.url`: under `next start`, a Route
 * Handler's `req.url` is built from this app's own configured origin (e.g.
 * always `http://localhost:3141`, the address it was started on) regardless
 * of what a client actually connected to or sent — confirmed by logging both
 * side by side against a real running server, not assumed. `req.headers.get
 * ('host')`, by contrast, is the one thing that reliably carries the exact
 * value THIS request's Host header had.
 *
 * Deliberately never `X-Forwarded-For` or any other *forwarded* header a
 * client sets itself: Next.js only ever back-fills `x-forwarded-for` from the
 * real socket when the incoming request didn't already carry one (see
 * `base-server.js`'s `??=`), so a request that supplies its own value keeps
 * it verbatim — any client can claim to be `127.0.0.1` this way, which is
 * exactly why the save route this guards must not trust it. `Host` is
 * different: a browser's `fetch()`/`XMLHttpRequest` can never override it
 * (it's a forbidden header name) — it always reflects the address the
 * browser actually connected to, so no visitor's browser can be made to say
 * `Host: localhost` while talking to a deployment reached over the network.
 * (A raw, non-browser HTTP client could still forge it; this app's actual
 * visitors are browsers, and CSRF's `sameOrigin` check above covers the
 * state-changing-request threat for the rest.)
 */
export function isLoopbackRequest(req: Request): boolean {
  const host = req.headers.get('host');
  if (!host) return false;
  try {
    // Parsed via URL (not a manual split) so an IPv6 literal's brackets and
    // an explicit port are both stripped the same way the platform itself
    // would, rather than a hand-rolled parser getting an edge case wrong.
    return LOOPBACK_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export const forbidden = (): Response =>
  json({ ok: false, error: { code: 'FORBIDDEN', message: 'Cross-origin request refused.' } }, 403);

/** The operator's OAuth setup form is a development-time affordance. It is
 *  refused outright in production because the loopback check that guards it
 *  reads the `Host` header, which a non-browser client can forge — so on a
 *  reachable deployment it would not be a boundary at all. */
export const setupDisabled = (): Response =>
  json(
    {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message:
          'Sign-in setup is only available when running locally. Configure this deployment with environment variables, or place .oauth-apps.json on the server.',
      },
    },
    403,
  );

export const localhostOnly = (): Response =>
  json(
    {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message:
          'The OAuth app can only be configured from the machine running this deployment — open it at http://localhost and try again there.',
      },
    },
    403,
  );

export const rateLimited = (): Response =>
  json(
    {
      ok: false,
      error: {
        code: 'RATE_LIMIT',
        message: 'Rate limit exceeded — max 20 requests/min. Try again shortly.',
        httpStatus: 429,
        retryable: true,
      },
    },
    429,
  );

export const disabled = (problem: string | undefined): Response =>
  json(
    {
      ok: false,
      error: {
        code: 'UNSUPPORTED',
        message: `My Calendar is not configured on this deployment (${problem ?? 'unknown reason'}).`,
      },
    },
    503,
  );
