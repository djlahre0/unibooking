import { hmacSha256Base64, timingSafeEqual } from '../crypto';

/**
 * Verify a Mindbody webhook signature. Mindbody signs the raw request body with
 * your webhook signature key (HMAC-SHA256, base64) and sends it in the
 * `X-Mindbody-Signature` header (optionally prefixed `sha256=`).
 *
 * Pass the EXACT raw request body (not a re-serialized object).
 */
export interface MindbodyWebhookInput {
  signatureKey: string;
  body: string;
  /** Value of the `X-Mindbody-Signature` header. */
  signature: string;
}

export async function verifyMindbodySignature(input: MindbodyWebhookInput): Promise<boolean> {
  const provided = input.signature.replace(/^sha256=/i, '');
  const expected = await hmacSha256Base64(input.signatureKey, input.body);
  return timingSafeEqual(expected, provided);
}
