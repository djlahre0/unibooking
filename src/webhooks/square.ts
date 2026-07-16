import { hmacSha256Base64, timingSafeEqual } from '../crypto';

/**
 * Verify a Square webhook signature. Square signs `notificationUrl + rawBody`
 * with your webhook signature key (HMAC-SHA256, base64) and sends it in the
 * `x-square-hmacsha256-signature` header.
 *
 * Pass the EXACT raw request body (not a re-serialized object) and the exact
 * notification URL you configured in Square.
 */
export interface SquareWebhookInput {
  signatureKey: string;
  notificationUrl: string;
  body: string;
  /** Value of the `x-square-hmacsha256-signature` header. */
  signature: string;
}

export async function verifySquareSignature(input: SquareWebhookInput): Promise<boolean> {
  const expected = await hmacSha256Base64(input.signatureKey, input.notificationUrl + input.body);
  return timingSafeEqual(expected, input.signature);
}
