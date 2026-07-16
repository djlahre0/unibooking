/**
 * Tiny Web Crypto helpers for webhook signature verification. Uses the global
 * `crypto.subtle`, available in Node 18+, edge runtimes, Deno, Bun, and browsers.
 */

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Decode a standard base64 string to bytes (used for keys that arrive base64,
 *  e.g. Boulevard's API secret). */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return base64ToBytes(b64 + pad);
}

export async function hmacSha256Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return toBase64(new Uint8Array(sig));
}

/** HMAC-SHA256 rendered as lowercase hex (e.g. Calendly's `v1=` signature). */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return toHex(new Uint8Array(sig));
}

/** HMAC-SHA256 (base64 output) with a raw-bytes key — for providers whose signing
 *  key is not the literal string but its decoded bytes (e.g. Boulevard signs with
 *  the base64-decoded API secret). */
export async function hmacSha256BytesBase64(
  keyBytes: Uint8Array,
  message: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return toBase64(new Uint8Array(sig));
}

/**
 * Verify an RS256-signed JWT against an RSA public key (SPKI PEM) and return the
 * decoded payload, or `null` if the signature is invalid or the token is
 * malformed. Used for webhook events delivered as signed JWTs (e.g. Wix).
 */
export async function verifyRs256Jwt(
  jwt: string,
  publicKeyPem: string,
): Promise<Record<string, any> | null> {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let key: CryptoKey;
  try {
    key = await importRsaPublicKey(publicKeyPem);
  } catch {
    return null;
  }
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle
    .verify({ name: 'RSASSA-PKCS1-v1_5' }, key, base64UrlToBytes(sigB64!), data)
    .catch(() => false);
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64!)));
  } catch {
    return null;
  }
}

async function importRsaPublicKey(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const der = base64ToBytes(b64);
  return crypto.subtle.importKey(
    'spki',
    der as unknown as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

/** Length-independent, constant-time-ish string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
