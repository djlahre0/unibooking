import type { Op } from './dispatch';
import { serializeError, type ActionResult } from './result';

/**
 * Client-side transport for a provider the visitor is signed into via My
 * Calendar (Google or Outlook -- the only two providers that support signing
 * in today). No credential of any kind travels through this module: the
 * sealed, HttpOnly session cookie already carries the token, the browser
 * attaches it by itself, and the call itself runs server-side in
 * /api/calendar/explore against the same dispatch() op set the pasted-token
 * transports (transport-direct.ts, transport-proxy.ts) use. This function's
 * shape mirrors transport-direct.ts's try/catch-then-serializeError pattern;
 * what changes is that the "call" being wrapped is a fetch to our own server
 * instead of dispatch() running against a locally built adapter.
 */
export async function runSession(op: Op, args: unknown): Promise<ActionResult> {
  try {
    const res = await fetch('/api/calendar/explore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, args }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (json && typeof json === 'object' && 'ok' in json) {
      return json as ActionResult;
    }
    return {
      ok: false,
      error: { message: `My Calendar error (HTTP ${res.status}).`, httpStatus: res.status },
    };
  } catch (e) {
    return serializeError(e);
  }
}
