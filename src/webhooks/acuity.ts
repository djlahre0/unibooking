import { hmacSha256Base64, timingSafeEqual } from '../crypto';

/**
 * Verify an Acuity webhook. Acuity signs the raw request body with your API key
 * (HMAC-SHA256, base64) and sends it in the `X-Acuity-Signature` header.
 */
export interface AcuityWebhookInput {
  apiKey: string;
  body: string;
  /** Value of the `X-Acuity-Signature` header. */
  signature: string;
}

export async function verifyAcuitySignature(input: AcuityWebhookInput): Promise<boolean> {
  const expected = await hmacSha256Base64(input.apiKey, input.body);
  return timingSafeEqual(expected, input.signature);
}
