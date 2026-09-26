import { isUnibookingError } from 'unibooking';
import { appOrigin, readCalendarConfig } from '@/lib/calendar/config';
import {
  SESSION_COOKIE,
  clearCookie,
  parseCookies,
  readSession,
  sessionCookies,
  type StoredTokens,
} from '@/lib/calendar/session';
import { clientFor, RefreshFailed, runCalendarOp } from '@/lib/calendar/ops';
import { clientIp, disabled, forbidden, json, rateLimited, sameOrigin } from '@/lib/calendar/http';
import { CALENDAR_OPS, type CalendarOp } from '@/lib/calendar/types';
import { serializeError } from '@/lib/result';
import { allow } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * Every calendar operation for a connected user: `{ op, args }` in, the
 * standard ActionResult out. The session cookie supplies the credentials; the
 * browser only ever names an operation, a calendar and an event.
 *
 * A dead grant (refresh refused, or the provider answering AUTH) clears the
 * session and answers `reconnect: true`. A transient fault (network, timeout,
 * rate limit, 5xx) does not: a blip must never disconnect a working account.
 */
export async function POST(req: Request): Promise<Response> {
  const config = readCalendarConfig();
  const origin = appOrigin(req, config);
  if (!sameOrigin(req, origin)) return forbidden();
  if (!allow(clientIp(req))) return rateLimited();
  if (!config.enabled) return disabled(config.problem);

  const cookies = parseCookies(req.headers.get('cookie'));
  const session = await readSession(req, config);
  if (!session) {
    return json(
      { ok: false, reconnect: true, error: { code: 'AUTH', message: 'Not connected.' } },
      401,
    );
  }

  let payload: { op?: unknown; args?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json(
      { ok: false, error: { code: 'INVALID_INPUT', message: 'Invalid JSON body.' } },
      400,
    );
  }
  const op = payload.op;
  if (typeof op !== 'string' || !CALENDAR_OPS.includes(op as CalendarOp)) {
    return json(
      {
        ok: false,
        error: { code: 'INVALID_INPUT', message: `Unknown operation "${String(op)}".` },
      },
      400,
    );
  }
  const args =
    payload.args !== null && typeof payload.args === 'object'
      ? (payload.args as Record<string, unknown>)
      : {};
  const calendarId =
    typeof args.calendarId === 'string' && args.calendarId ? args.calendarId : undefined;

  let refreshed: StoredTokens | undefined;
  const resealed = async (): Promise<string[]> =>
    refreshed && session.provider !== 'apple'
      ? sessionCookies({ ...session, tokens: refreshed }, config, cookies)
      : [];

  let client;
  try {
    client = clientFor(session, config, origin, calendarId, (t) => {
      refreshed = t;
    });
  } catch (e) {
    // The SSRF guard on an Apple calendar URL.
    return json(
      {
        ok: false,
        error: { code: 'INVALID_INPUT', message: e instanceof Error ? e.message : String(e) },
      },
      400,
    );
  }

  try {
    const data = await runCalendarOp(client, op as CalendarOp, args);
    return json({ ok: true, data }, 200, await resealed());
  } catch (e) {
    if (e instanceof RefreshFailed || (isUnibookingError(e) && e.code === 'AUTH')) {
      const cause = serializeError(e instanceof RefreshFailed ? e.reason : e).error;
      return json(
        {
          ok: false,
          reconnect: true,
          error: {
            ...cause,
            code: 'AUTH',
            message: 'Your calendar connection expired or was revoked. Please reconnect.',
          },
        },
        200,
        clearCookie(SESSION_COOKIE, cookies),
      );
    }
    return json(serializeError(e), 200, await resealed());
  }
}
