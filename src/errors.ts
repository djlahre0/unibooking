import type { ProviderId } from './types';

/**
 * Normalized failure taxonomy. Every adapter throws `UnibookingError` (never a
 * raw provider exception) so consumers branch on `code` without learning each
 * vendor's error format.
 */
export type ErrorCode =
  | 'AUTH' // 401 — missing/invalid/expired credentials
  | 'FORBIDDEN' // 403 — authenticated but not allowed / missing scope
  | 'NOT_FOUND' // 404/410 — booking or resource does not exist
  | 'CONFLICT' // 409 — slot already taken / duplicate / version conflict
  | 'RATE_LIMIT' // 429 — throttled; see retryAfterMs
  | 'INVALID_INPUT' // 400/422 — the request was malformed or rejected
  | 'UNSUPPORTED' // capability not offered by this provider
  | 'UPSTREAM' // 5xx or an unexpected/unparseable provider response
  | 'NETWORK' // the request never completed (DNS, connection, fetch threw)
  | 'TIMEOUT'; // the request was aborted after ClientOptions.timeoutMs

export interface UnibookingErrorInit {
  provider: ProviderId;
  code: ErrorCode;
  message: string;
  /** HTTP status, when the failure came from an HTTP response. */
  httpStatus?: number;
  /** The provider's own error code/string, for debugging. */
  providerCode?: string;
  /** Populated from `Retry-After` on 429 responses. */
  retryAfterMs?: number;
  /** Provider request/correlation id, when exposed via response headers. */
  requestId?: string;
  cause?: unknown;
}

export class UnibookingError extends Error {
  readonly provider: ProviderId;
  readonly code: ErrorCode;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly retryAfterMs?: number;
  readonly requestId?: string;

  constructor(init: UnibookingErrorInit) {
    super(
      `[${init.provider}] ${init.code}: ${init.message}`,
      init.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.name = 'UnibookingError';
    this.provider = init.provider;
    this.code = init.code;
    if (init.httpStatus !== undefined) this.httpStatus = init.httpStatus;
    if (init.providerCode !== undefined) this.providerCode = init.providerCode;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (init.requestId !== undefined) this.requestId = init.requestId;
  }
}

export function isUnibookingError(e: unknown): e is UnibookingError {
  return e instanceof UnibookingError;
}

/** Map an HTTP status to a canonical error code. Single source of truth so
 *  every adapter maps failures identically. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 422:
      return 'INVALID_INPUT';
    case 401:
      return 'AUTH';
    case 403:
      return 'FORBIDDEN';
    case 404:
    case 410:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMIT';
    default:
      // Unmapped 4xx and all 5xx fall through to UPSTREAM.
      return 'UPSTREAM';
  }
}

/** Codes for which a retry might succeed (used by `withRetry`). */
export function isRetryable(code: ErrorCode): boolean {
  return code === 'RATE_LIMIT' || code === 'UPSTREAM' || code === 'NETWORK' || code === 'TIMEOUT';
}
