import { makeClient } from './providers';
import { dispatch, type Op } from './dispatch';
import { serializeError, type ActionResult } from './result';

/**
 * Client-side transport for CORS-friendly providers. The adapter runs in the
 * browser with the browser's own fetch, so the visitor's token goes straight
 * to the provider and never reaches our server.
 */
export async function runDirect(
  provider: string,
  op: Op,
  creds: Record<string, string>,
  args: unknown,
): Promise<ActionResult> {
  try {
    const client = makeClient(provider, creds);
    const data = await dispatch(client, op, args);
    return { ok: true, data };
  } catch (e) {
    const result = serializeError(e);
    // A browser CORS rejection surfaces as a generic NETWORK error; add a hint
    // so it isn't baffling.
    if (result.error?.code === 'NETWORK') {
      result.error.message +=
        ' — the browser may have blocked this cross-origin request (CORS). If so, this provider must be called from a server.';
    }
    return result;
  }
}
