import { apple } from 'unibooking/adapters/apple';
import { isUnibookingError } from 'unibooking';
import { appOrigin, readCalendarConfig } from '@/lib/calendar/config';
import { parseCookies, sessionCookies } from '@/lib/calendar/session';
import { clientIp, disabled, forbidden, json, rateLimited, sameOrigin } from '@/lib/calendar/http';
import { serializeError } from '@/lib/result';
import { allow } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * "Connect Apple iCloud". Apple offers third parties no OAuth for calendars;
 * an app-specific password (appleid.apple.com) is the supported route. The
 * credentials are validated by running CalDAV discovery against iCloud before
 * anything is stored, then sealed into the session cookie like OAuth tokens.
 */
export async function POST(req: Request): Promise<Response> {
  const config = readCalendarConfig();
  if (!sameOrigin(req, appOrigin(req, config))) return forbidden();
  if (!allow(clientIp(req))) return rateLimited();
  if (!config.enabled) return disabled(config.problem);

  let body: { appleId?: unknown; appPassword?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(
      { ok: false, error: { code: 'INVALID_INPUT', message: 'Invalid JSON body.' } },
      400,
    );
  }
  const appleId = typeof body.appleId === 'string' ? body.appleId.trim() : '';
  const appPassword = typeof body.appPassword === 'string' ? body.appPassword.trim() : '';
  if (!appleId || !appPassword) {
    return json(
      {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Enter your Apple ID and an app-specific password.',
        },
      },
      400,
    );
  }

  try {
    await apple({ username: appleId, appPassword }, { timeoutMs: 10_000 }).listCalendars!();
  } catch (e) {
    if (isUnibookingError(e) && (e.code === 'AUTH' || e.code === 'FORBIDDEN')) {
      return json(
        {
          ok: false,
          error: {
            code: 'AUTH',
            message:
              'Apple ID or app-specific password was rejected. Create an app-specific password at appleid.apple.com (your normal Apple ID password will not work).',
          },
        },
        401,
      );
    }
    return json(serializeError(e));
  }

  const account = { email: appleId, name: appleId };
  const cookies = await sessionCookies(
    { provider: 'apple', apple: { username: appleId, appPassword }, account },
    config,
    parseCookies(req.headers.get('cookie')),
  );
  return json({ ok: true, data: { provider: 'apple', account } }, 200, cookies);
}
