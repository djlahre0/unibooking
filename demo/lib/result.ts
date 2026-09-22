import { isUnibookingError, isRetryable } from 'unibooking';

/**
 * Serializable result envelope shared by both transports (direct + proxy) and
 * the proxy route, so the UI never has to know which path produced a result.
 */
export type ActionResult = {
  ok: boolean;
  data?: unknown;
  /** My Calendar only: the connection is gone (revoked or expired grant) and
   *  the session has been cleared, so the UI should offer to reconnect. */
  reconnect?: boolean;
  error?: {
    code?: string;
    message: string;
    httpStatus?: number;
    provider?: string;
    providerCode?: string;
    retryable?: boolean;
  };
};

/** A provider connection: credentials plus an optional base URL override. */
export type Connection = {
  creds: Record<string, string>;
  /** Absent means "use the adapter's default host". */
  baseUrl?: string;
  /** Google/Outlook only: the visitor is signed in via My Calendar, so `run()`
   *  in call.ts routes to the session transport instead of direct/proxy --
   *  `creds`/`baseUrl` above are ignored entirely, the sealed session cookie
   *  supplies the token server-side. Absent (not just false) everywhere else,
   *  since most Connection literals in this codebase and its tests are built
   *  without ever knowing about My Calendar. */
  signedIn?: boolean;
};

/** Normalize any thrown value into an ActionResult error. */
export function serializeError(e: unknown): ActionResult {
  if (isUnibookingError(e)) {
    return {
      ok: false,
      error: {
        code: e.code,
        message: e.message,
        httpStatus: e.httpStatus,
        provider: e.provider,
        providerCode: e.providerCode,
        retryable: isRetryable(e.code),
      },
    };
  }
  return {
    ok: false,
    error: { message: e instanceof Error ? e.message : String(e) },
  };
}
