import type { ClientOptions, CredsInput, ProviderId } from './types';
import { UnibookingError, codeForStatus } from './errors';

export type QueryValue = string | number | boolean | undefined | null;

export interface HttpRequest {
  method?: string;
  /** Appended to the configured base URL. */
  path: string;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /** Serialized as JSON unless it is a string/URLSearchParams/undefined. */
  body?: unknown;
  /** How to read the response body. Default `'json'`. */
  parse?: 'json' | 'text' | 'none';
  /** Observe response metadata (status, headers) before the body is parsed —
   *  e.g. to capture an `ETag` for CalDAV optimistic concurrency. Called for
   *  both success and error responses. */
  onResponse?: (meta: { status: number; headers: Headers }) => void;
}

/** Given resolved credentials, produce the auth to apply to a request. May be
 *  async — some providers sign each request (e.g. a per-request HMAC token). */
export type AuthResult = {
  headers?: Record<string, string>;
  query?: Record<string, string>;
};
export type AuthFn<TCreds> = (creds: TCreds) => AuthResult | Promise<AuthResult>;

export interface HttpConfig<TCreds> {
  provider: ProviderId;
  baseUrl: string;
  creds: CredsInput<TCreds>;
  auth: AuthFn<TCreds>;
  options?: ClientOptions | undefined;
  /** Response header carrying a request/correlation id, if the provider sets one. */
  requestIdHeader?: string;
  /** Pull a provider-specific error code/message out of a parsed error body. */
  parseError?: (status: number, body: unknown) => { providerCode?: string; message?: string };
}

/**
 * A per-provider HTTP context. Adapter methods `resolve()` credentials once at
 * the top of the call (which runs the refresh function, if any) and pass the
 * resolved creds into every `request()` — so auth and routing fields
 * (locationId, calendarId, siteId, …) come from a single, consistent snapshot.
 */
export interface HttpContext<TCreds> {
  resolve(): Promise<TCreds>;
  request<T = any>(creds: TCreds, req: HttpRequest): Promise<T>;
}

const COMMON_REQUEST_ID_HEADERS = [
  'x-request-id',
  'request-id',
  'x-ms-request-id',
  'client-request-id',
  'x-amzn-requestid',
];

async function resolveCreds<T>(creds: CredsInput<T>): Promise<T> {
  return typeof creds === 'function' ? await (creds as () => T | Promise<T>)() : creds;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, QueryValue> | undefined,
  authQuery: Record<string, string> | undefined,
): string {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  // A leading slash on `path` would drop base subpaths, so strip it.
  const url = new URL(path.replace(/^\//, ''), base);
  const apply = (obj: Record<string, QueryValue> | undefined) => {
    if (!obj) return;
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  };
  apply(query);
  apply(authQuery);
  return url.toString();
}

function parseRetryAfter(header: string | null, now: () => Date): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - now().getTime());
}

function readRequestId(headers: Headers, configured: string | undefined): string | undefined {
  if (configured) {
    const v = headers.get(configured);
    if (v) return v;
  }
  for (const h of COMMON_REQUEST_ID_HEADERS) {
    const v = headers.get(h);
    if (v) return v;
  }
  return undefined;
}

function truncate(s: string, max = 500): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function createHttp<TCreds>(config: HttpConfig<TCreds>): HttpContext<TCreds> {
  const doFetch = config.options?.fetch ?? globalThis.fetch;
  const timeoutMs = config.options?.timeoutMs ?? 15_000;
  const now = config.options?.now ?? (() => new Date());

  if (typeof doFetch !== 'function') {
    throw new UnibookingError({
      provider: config.provider,
      code: 'INVALID_INPUT',
      message:
        'No fetch implementation available. Use Node >= 20, or pass options.fetch explicitly.',
    });
  }

  async function request<T = any>(creds: TCreds, req: HttpRequest): Promise<T> {
    const authed = await config.auth(creds);
    const url = buildUrl(config.baseUrl, req.path, req.query, authed.query);

    const headers: Record<string, string> = { accept: 'application/json' };
    Object.assign(headers, authed.headers ?? {});
    let body: BodyInit | undefined;
    if (req.body !== undefined) {
      if (typeof req.body === 'string' || req.body instanceof URLSearchParams) {
        body = req.body;
      } else {
        body = JSON.stringify(req.body);
        headers['content-type'] = 'application/json';
      }
    }
    Object.assign(headers, req.headers ?? {});

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await doFetch(url, {
        method: req.method ?? 'GET',
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === 'AbortError';
      throw new UnibookingError({
        provider: config.provider,
        code: aborted ? 'TIMEOUT' : 'NETWORK',
        message: aborted
          ? `request timed out after ${timeoutMs}ms: ${req.method ?? 'GET'} ${req.path}`
          : `network error: ${req.method ?? 'GET'} ${req.path}`,
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    const requestId = readRequestId(res.headers, config.requestIdHeader);
    req.onResponse?.({ status: res.status, headers: res.headers });

    if (!res.ok) {
      const rawText = await res.text().catch(() => '');
      let parsedBody: unknown = rawText;
      try {
        parsedBody = rawText ? JSON.parse(rawText) : undefined;
      } catch {
        /* leave as text */
      }
      const extra = config.parseError?.(res.status, parsedBody);
      const retryAfterMs =
        res.status === 429 ? parseRetryAfter(res.headers.get('retry-after'), now) : undefined;
      throw new UnibookingError({
        provider: config.provider,
        code: codeForStatus(res.status),
        message: extra?.message ?? `HTTP ${res.status}: ${truncate(rawText)}`,
        httpStatus: res.status,
        ...(extra?.providerCode !== undefined ? { providerCode: extra.providerCode } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      });
    }

    const mode = req.parse ?? 'json';
    if (mode === 'none' || res.status === 204) return undefined as T;
    const text = await res.text();
    if (mode === 'text') return text as T;
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new UnibookingError({
        provider: config.provider,
        code: 'UPSTREAM',
        message: `expected JSON but got: ${truncate(text)}`,
        httpStatus: res.status,
        ...(requestId !== undefined ? { requestId } : {}),
        cause,
      });
    }
  }

  return {
    resolve: () => resolveCreds(config.creds),
    request,
  };
}
