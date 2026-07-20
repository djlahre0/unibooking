import { isUnibookingError, isRetryable } from 'unibooking';

/**
 * Serializable result envelope shared by both transports (direct + proxy) and
 * the proxy route, so the UI never has to know which path produced a result.
 */
export type ActionResult = {
  ok: boolean;
  data?: unknown;
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
