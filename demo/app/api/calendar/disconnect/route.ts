import { appOrigin, readCalendarConfig } from '@/lib/calendar/config';
import {
  FLOW_COOKIE,
  SESSION_COOKIE,
  clearCookie,
  parseCookies,
  readSession,
} from '@/lib/calendar/session';
import { clientIp, forbidden, json, rateLimited, sameOrigin } from '@/lib/calendar/http';
import { allow } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/**
 * Forget the connection. For Google, also revoke the grant (best effort) so
 * the app disappears from the user's Google account permissions. Microsoft
 * has no equivalent token-revocation endpoint for this flow, and an Apple
 * app-specific password is revoked by the user at appleid.apple.com.
 */
export async function POST(req: Request): Promise<Response> {
  const config = readCalendarConfig();
  if (!sameOrigin(req, appOrigin(req, config))) return forbidden();
  // Rate limited like every other state-changing route here: with a live
  // Google session this makes an outbound call to Google's revoke endpoint,
  // so it must not be usable as an unbounded request pump.
  if (!allow(clientIp(req))) return rateLimited();

  const cookies = parseCookies(req.headers.get('cookie'));
  const session = await readSession(req, config);
  if (session?.provider === 'google') {
    const token = session.tokens.refreshToken ?? session.tokens.accessToken;
    try {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Best effort: the session is cleared either way.
    }
  }

  return json({ ok: true, data: { disconnected: true } }, 200, [
    ...clearCookie(SESSION_COOKIE, cookies),
    ...clearCookie(FLOW_COOKIE, cookies),
  ]);
}
