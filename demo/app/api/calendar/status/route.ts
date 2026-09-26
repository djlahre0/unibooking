import { readCalendarConfig } from '@/lib/calendar/config';
import { readSession } from '@/lib/calendar/session';
import { isLoopbackRequest, json } from '@/lib/calendar/http';
import type { CalendarStatus } from '@/lib/calendar/types';

export const runtime = 'nodejs';

/** What the My Calendar tab renders from: which connect options this
 *  deployment offers, and who (if anyone) is connected. Never carries a token. */
export async function GET(req: Request): Promise<Response> {
  const config = readCalendarConfig();
  const session = await readSession(req, config);
  const data: CalendarStatus = {
    enabled: config.enabled,
    ...(config.problem ? { problem: config.problem } : {}),
    providers: config.providers,
    // Computed fresh per request from THIS request's own address, never
    // cached or trusted from the client: see isLoopbackRequest's doc comment.
    isLocalhost: isLoopbackRequest(req),
    // `custom` is a fact ("a bring-your-own app is in use"), never the id or
    // secret: those live only in the sealed session cookie and are never
    // read back out into a response body.
    connection: session
      ? {
          provider: session.provider,
          account: session.account,
          ...(session.provider !== 'apple' && session.custom ? { custom: true } : {}),
        }
      : null,
  };
  return json({ ok: true, data });
}
