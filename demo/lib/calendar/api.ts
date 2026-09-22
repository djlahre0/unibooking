import type { ActionResult } from '../result';
import type { CalendarOp, OAuthProvider } from './types';

/**
 * Browser-side calls to the My Calendar routes. The session travels in an
 * HttpOnly cookie the browser attaches by itself; nothing here ever sees a
 * token. Every call resolves to an ActionResult, never throws.
 */

async function request(path: string, init?: RequestInit): Promise<ActionResult> {
  try {
    const res = await fetch(path, { cache: 'no-store', ...init });
    const json: unknown = await res.json().catch(() => null);
    if (json && typeof json === 'object' && 'ok' in json) return json as ActionResult;
    return {
      ok: false,
      error: { message: `Calendar API error (HTTP ${res.status}).`, httpStatus: res.status },
    };
  } catch (e) {
    return {
      ok: false,
      error: { code: 'NETWORK', message: e instanceof Error ? e.message : String(e) },
    };
  }
}

function post(path: string, body: unknown): Promise<ActionResult> {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function getStatus(): Promise<ActionResult> {
  return request('/api/calendar/status');
}

/** A full-page navigation target: the route redirects to the provider. */
export function connectUrl(provider: OAuthProvider): string {
  return `/api/calendar/connect/${provider}`;
}

/**
 * The operator's one-time OAuth app setup -- POSTs a client id/secret(/tenant)
 * to be saved server-side for every later visitor to sign in through. Only
 * accepted when this request itself comes from the machine running the
 * deployment (see isLoopbackRequest in lib/calendar/http.ts); callers are
 * expected to only render the form that calls this when `calendarStatus.isLocalhost`
 * is true, but the real enforcement is server-side regardless.
 */
export function saveOAuthApp(
  provider: OAuthProvider,
  clientId: string,
  clientSecret: string,
  tenant?: string,
): Promise<ActionResult> {
  return post(`/api/calendar/oauth-app/${provider}`, {
    clientId,
    clientSecret,
    ...(tenant ? { tenant } : {}),
  });
}

export function connectApple(appleId: string, appPassword: string): Promise<ActionResult> {
  return post('/api/calendar/apple', { appleId, appPassword });
}

export function calendarCall(op: CalendarOp, args: Record<string, unknown>): Promise<ActionResult> {
  return post('/api/calendar/call', { op, args });
}

export function disconnect(): Promise<ActionResult> {
  return post('/api/calendar/disconnect', {});
}
