import { dispatch, type Op } from './dispatch';
import { sampleClient } from './sample/client';
import { serializeError, type ActionResult } from './result';

/**
 * Third transport, beside direct and proxy: the sample provider runs entirely
 * in the browser against localStorage. No credentials, no host, no network --
 * so it takes neither a Connection nor a base URL.
 */
export async function runLocal(op: Op, args: unknown): Promise<ActionResult> {
  try {
    return { ok: true, data: await dispatch(sampleClient(), op, args) };
  } catch (e) {
    return serializeError(e);
  }
}
