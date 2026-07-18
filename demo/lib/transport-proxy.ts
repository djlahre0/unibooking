import type { Op } from './dispatch';
import type { ActionResult } from './result';

/**
 * Client-side transport for providers that reject browser calls. Ships the
 * request to /api/call, which runs the same dispatch() server-side. The proxy
 * always answers with an ActionResult-shaped body (even for 4xx/429), so we
 * pass it straight through.
 */
export async function runProxy(
  provider: string,
  op: Op,
  creds: Record<string, string>,
  args: unknown,
): Promise<ActionResult> {
  try {
    const res = await fetch('/api/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, op, creds, args }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (json && typeof json === 'object' && 'ok' in json) {
      return json as ActionResult;
    }
    return { ok: false, error: { message: `Demo proxy error (HTTP ${res.status}).`, httpStatus: res.status } };
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : String(e) } };
  }
}
