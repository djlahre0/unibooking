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
import { clientFor, RefreshFailed } from '@/lib/calendar/ops';
import { clientIp, disabled, forbidden, json, rateLimited, sameOrigin } from '@/lib/calendar/http';
import { dispatch, OPS, type Op } from '@/lib/dispatch';
import { serializeError } from '@/lib/result';
import { allow } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * The explorer tabs (Bookings, Availability, Customers, Catalog, Utilities)
 * for a visitor signed in via My Calendar: `{ op, args }` in, the standard
 * ActionResult out. Guards are copied verbatim from ./call/route.ts (same
 * origin check, rate limit, config.enabled, session read, refresh/re-seal,
 * dead-grant handling) -- what differs is the op set: this runs dispatch()
 * from lib/dispatch.ts, the FULL set the pasted-credential transports use,
 * not the narrower CALENDAR_OPS the My Calendar tab itself is limited to.
 * That's what lets a signed-in visitor use those tabs without ever pasting a
 * token -- the sealed session cookie supplies the credentials server-side,
 * and the browser never sees them.
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
  if (typeof op !== 'string' || !OPS.includes(op as Op)) {
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
  // Threaded through exactly like ./call/route.ts, though today's explorer
  // tabs never populate it -- dispatch()'s ops don't read args.calendarId --
  // so this only matters once a caller starts sending one; until then every
  // signed-in call targets the account's default/primary calendar.
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
    const data = await dispatch(client, op as Op, args);
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
