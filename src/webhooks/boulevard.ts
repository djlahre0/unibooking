import { base64ToBytes, hmacSha256BytesBase64, timingSafeEqual } from '../crypto';

/**
 * Verify a Boulevard webhook signature.
 *
 * Boulevard sends a per-request salt in `x-blvd-hmac-salt` and the signature in
 * `x-blvd-hmac-sha256`. The signed payload is the **full salt header value, a
 * literal colon, then the raw body**:
 *
 *   payload   = "&lt;x-blvd-hmac-salt&gt;" + ":" + rawBody
 *   raw_key   = base64Decode(appSecret)          // the secret is base64 at rest
 *   signature = base64( HMAC-SHA256(payload, raw_key) )
 *
 * The salt itself has the form
 * `blvd-webhook-v1:&lt;API Application UUID&gt;:&lt;unix-seconds&gt;` — pass it through
 * verbatim, inner colons included. The signature is base64 only; Boulevard never
 * emits hex.
 *
 * The signing secret is the API *application* secret (same base64-at-rest form as
 * the Admin API key), not the Admin API secret itself.
 *
 * Pass the EXACT raw request body — never a re-serialized object.
 *
 * Note: Boulevard delivers a `PING` event on webhook creation, so your handler
 * must tolerate that payload shape. Never return HTTP 410 from the endpoint —
 * Boulevard treats 410 Gone as a permanent unsubscribe.
 */
export interface BoulevardWebhookInput {
  /** API application secret, base64-encoded (as issued). */
  signingSecret: string;
  /** Full value of the `x-blvd-hmac-salt` header, colons included. */
  salt: string;
  body: string;
  /** Value of the `x-blvd-hmac-sha256` header. */
  signature: string;
}

export async function verifyBoulevardSignature(input: BoulevardWebhookInput): Promise<boolean> {
  const payload = `${input.salt}:${input.body}`;
  const expected = await hmacSha256BytesBase64(base64ToBytes(input.signingSecret), payload);
  return timingSafeEqual(expected, input.signature);
}
