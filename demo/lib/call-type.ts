import type { ActionResult, Connection } from './result';
import type { Op } from './dispatch';

/** One provider call, over whichever transport call.ts picks. Injected into
 *  the sync engines so they run without a network in tests. */
export type Call = (
  provider: string,
  conn: Connection,
  op: Op,
  args: Record<string, unknown>,
) => Promise<ActionResult>;
