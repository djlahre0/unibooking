import { hmacSha256Base64, hmacSha256Hex, timingSafeEqual } from '../crypto';

/**
 * Verify a Boulevard webhook signature.
 *
 * Boulevard sends a per-request salt in `x-blvd-hmac-salt` and the signature in
 * `x-blvd-hmac-sha256`. This helper computes HMAC-SHA256 over `salt + rawBody`
 * with your webhook signing secret and compares (accepting hex or base64).
 *
 * ⚠️ The exact concatenation/encoding is not fully specified in public docs, so
 * confirm against a live webhook before relying on it. Pass the EXACT raw request
 * body (not a re-serialized object). See docs/providers/boulevard.md.
 */
export interface BoulevardWebhookInput {
  signingSecret: string;
  /** Value of the `x-blvd-hmac-salt` header. */
  salt: string;
  body: string;
  /** Value of the `x-blvd-hmac-sha256` header. */
  signature: string;
}

export async function verifyBoulevardSignature(input: BoulevardWebhookInput): Promise<boolean> {
  const message = input.salt + input.body;
  const hex = await hmacSha256Hex(input.signingSecret, message);
  const b64 = await hmacSha256Base64(input.signingSecret, message);
  return timingSafeEqual(hex, input.signature) || timingSafeEqual(b64, input.signature);
}
