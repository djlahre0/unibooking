import { makeClient, PROXY_PROVIDERS } from '@/lib/providers';
import { dispatch, OPS, type Op } from '@/lib/dispatch';
import { serializeError, type ActionResult } from '@/lib/result';
import { assertSafeCalendarUrl } from '@/lib/validate-caldav';
import { allow } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * The ONLY server surface in the demo. It exclusively serves the 9 providers
 * that block browser (CORS) calls — a strict allowlist, so it can never be
 * abused to relay to Google/Microsoft/etc. Credentials are used to build the
 * client and then discarded; they are never logged or persisted.
 */
function reply(body: ActionResult, status = 200): Response {
  return Response.json(body, { status });
}

export async function POST(req: Request): Promise<Response> {
  // 1. Rate limit (cost control, not security).
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || 'unknown';
  if (!allow(ip)) {
    return reply(
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
  }

  // 2. Parse body.
  let payload: { provider?: unknown; op?: unknown; creds?: unknown; args?: unknown };
  try {
    payload = await req.json();
  } catch {
    return reply({ ok: false, error: { message: 'Invalid JSON body.' } }, 400);
  }
  const { provider, op, creds, args } = payload ?? {};

  // 3. Strict allowlist: only the 9 proxied providers.
  if (typeof provider !== 'string' || !PROXY_PROVIDERS.has(provider)) {
    return reply(
      { ok: false, error: { message: `Provider "${String(provider)}" is not available through the demo proxy.` } },
      400,
    );
  }

  // 4. Known operation.
  if (typeof op !== 'string' || !OPS.includes(op as Op)) {
    return reply({ ok: false, error: { message: `Unknown operation "${String(op)}".` } }, 400);
  }

  // 5. Credentials present.
  if (typeof creds !== 'object' || creds === null) {
    return reply({ ok: false, error: { message: 'Missing credentials.' } }, 400);
  }
  const credentials = creds as Record<string, string>;

  // 6. SSRF guard — the only user-supplied URL in the demo.
  if (provider === 'apple') {
    try {
      credentials.calendarUrl = assertSafeCalendarUrl(credentials.calendarUrl);
    } catch (e) {
      return reply(
        { ok: false, error: { code: 'INVALID_INPUT', message: e instanceof Error ? e.message : String(e) } },
        400,
      );
    }
  }

  // 7. Run the adapter and normalize the result.
  try {
    const client = makeClient(provider, credentials);
    const data = await dispatch(client, op as Op, args);
    return reply({ ok: true, data });
  } catch (e) {
    return reply(serializeError(e));
  }
}
