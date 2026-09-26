import type { CalendarConfig } from './config';
import type { Account, OAuthProvider } from './types';

/**
 * The My Calendar session: SERVER ONLY.
 *
 * Tokens (or the Apple app-specific password) live in an encrypted, HttpOnly
 * cookie rather than a database, so the demo server stays stateless: it holds
 * nothing between requests, and browser JavaScript can never read a token.
 *
 * Sealing is AES-256-GCM with a key derived from SESSION_SECRET by HKDF-SHA256.
 * The cookie NAME is bound in as additional authenticated data, so a value
 * sealed for the short-lived OAuth-flow cookie can't be replayed as a session.
 * An expiry travels inside the ciphertext and is checked on unseal: the
 * cookie's own Max-Age is only a hint to the browser.
 *
 * Microsoft's tokens push a sealed session past the ~4 KB a single cookie may
 * carry, so values are split across `name.0`, `name.1`, … chunks.
 */

export const SESSION_COOKIE = 'ub_cal';
export const FLOW_COOKIE = 'ub_oauth';
export const COOKIE_PATH = '/api/calendar';
export const SESSION_TTL_S = 30 * 24 * 60 * 60;
export const FLOW_TTL_S = 10 * 60;

const CHUNK = 3800;
const enc = new TextEncoder();

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
}

/** The visitor's own OAuth app, sealed alongside the tokens it issued:
 *  "bring your own OAuth app". Present only when this session was connected
 *  that way; absent for the deployer's env-configured app. Never returned to
 *  the page (see status/route.ts): the session cookie is the only place it
 *  lives, and it exists there because refreshing the token later must use the
 *  SAME client id/secret that requested it in the first place. */
export interface CustomApp {
  clientId: string;
  clientSecret: string;
  /** Microsoft-only: the visitor's own Entra app may be restricted to one
   *  directory. Absent means Microsoft's own `common` default applies:
   *  never read from env (see lib/calendar/config.ts). Ignored for Google. */
  tenant?: string;
}

export type CalendarSession =
  | { provider: OAuthProvider; tokens: StoredTokens; account: Account; custom?: CustomApp }
  | { provider: 'apple'; apple: { username: string; appPassword: string }; account: Account };

/** The in-flight OAuth handshake: what the callback must see echoed back.
 *  `custom` carries a "bring your own OAuth app" visitor's client id/secret
 *  through the short-lived sign-in cookie: the callback has no server-side
 *  record of this visitor's app, so it can only get them back this way. */
export interface FlowState {
  provider: OAuthProvider;
  state: string;
  codeVerifier: string;
  custom?: CustomApp;
}

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const unb64u = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, 'base64url'));

async function aesKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode('unibooking-demo'),
      info: enc.encode('session-v1'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(
  secret: string,
  name: string,
  payload: object,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = enc.encode(
    JSON.stringify({ ...payload, exp: Math.floor(nowMs / 1000) + ttlSeconds }),
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(name) },
    await aesKey(secret),
    body,
  );
  return `v1.${b64u(iv)}.${b64u(new Uint8Array(ciphertext))}`;
}

/** The payload, or null for anything tampered, expired, malformed, sealed
 *  under another secret or for another cookie name. Never throws. */
export async function unseal<T>(
  secret: string,
  name: string,
  value: string | undefined,
  nowMs: number = Date.now(),
): Promise<T | null> {
  const [version, iv, ciphertext] = value?.split('.') ?? [];
  if (version !== 'v1' || !iv || !ciphertext) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(iv), additionalData: enc.encode(name) },
      await aesKey(secret),
      unb64u(ciphertext),
    );
    const { exp, ...payload } = JSON.parse(new TextDecoder().decode(plain)) as {
      exp?: unknown;
    } & Record<string, unknown>;
    if (typeof exp !== 'number' || exp * 1000 <= nowMs) return null;
    return payload as T;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = part.slice(eq + 1).trim();
  }
  return out;
}

/** A chunked cookie's value: `name.0` + `name.1` + … up to the first gap. */
export function readCookie(cookies: Record<string, string>, name: string): string | undefined {
  let value = '';
  for (let i = 0; cookies[`${name}.${i}`] !== undefined; i++) value += cookies[`${name}.${i}`];
  return value || undefined;
}

function attributes(maxAge: number, secure: boolean): string {
  return `Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** `Set-Cookie` values writing `value` in chunks, plus deletions for any
 *  higher-numbered chunk a previous, longer value left behind. */
export function writeCookie(
  name: string,
  value: string,
  opts: { maxAge: number; secure: boolean; existing: Record<string, string> },
): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += CHUNK) chunks.push(value.slice(i, i + CHUNK));
  const headers = chunks.map(
    (c, i) => `${name}.${i}=${c}; ${attributes(opts.maxAge, opts.secure)}`,
  );
  for (const key of Object.keys(opts.existing)) {
    const m = new RegExp(`^${name}\\.(\\d+)$`).exec(key);
    if (m && Number(m[1]) >= chunks.length) {
      headers.push(`${key}=; ${attributes(0, opts.secure)}`);
    }
  }
  return headers;
}

/** `Set-Cookie` values deleting every chunk of `name` the request carried. */
export function clearCookie(name: string, existing: Record<string, string>): string[] {
  return writeCookie(name, '', { maxAge: 0, secure: isSecure(), existing });
}

export function isSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

export async function readSession(
  req: Request,
  config: CalendarConfig,
): Promise<CalendarSession | null> {
  if (!config.enabled) return null;
  const cookies = parseCookies(req.headers.get('cookie'));
  return unseal<CalendarSession>(
    config.sessionSecret,
    SESSION_COOKIE,
    readCookie(cookies, SESSION_COOKIE),
  );
}

export async function sessionCookies(
  session: CalendarSession,
  config: CalendarConfig,
  existing: Record<string, string>,
): Promise<string[]> {
  const sealed = await seal(config.sessionSecret, SESSION_COOKIE, session, SESSION_TTL_S);
  return writeCookie(SESSION_COOKIE, sealed, {
    maxAge: SESSION_TTL_S,
    secure: isSecure(),
    existing,
  });
}
