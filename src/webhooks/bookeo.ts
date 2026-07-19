import { hmacSha256Hex, timingSafeEqual } from '../crypto';

/**
 * Verify a Bookeo webhook signature.
 *
 * Bookeo signs every delivery with HMAC-SHA256 (hex) over the concatenation, in
 * order and with no separator, of:
 *
 *   X-Bookeo-Timestamp + X-Bookeo-MessageId + webhookUrl + rawBody
 *
 * keyed with your application's **secret key**. The signature arrives in
 * `X-Bookeo-Signature`.
 *
 * Bookeo's docs also recommend rejecting deliveries whose timestamp is more than
 * ~120 seconds from now, to blunt replay attacks. Pass `toleranceMs` to enable
 * that check (it is off by default so a caller with clock skew isn't silently
 * locked out).
 *
 * Pass the EXACT raw request body — never a re-serialized object — and the exact
 * webhook URL you registered with Bookeo.
 */
export interface BookeoWebhookInput {
  /** Your application's secret key. */
  secretKey: string;
  /** Value of the `X-Bookeo-Timestamp` header (unix millis, as sent). */
  timestamp: string;
  /** Value of the `X-Bookeo-MessageId` header. */
  messageId: string;
  /** The exact webhook URL registered with Bookeo. */
  webhookUrl: string;
  body: string;
  /** Value of the `X-Bookeo-Signature` header. */
  signature: string;
  /** When set, reject a timestamp further than this from `now`. Bookeo suggests 120000. */
  toleranceMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export async function verifyBookeoSignature(input: BookeoWebhookInput): Promise<boolean> {
  if (input.toleranceMs !== undefined) {
    const sent = Number(input.timestamp);
    if (!Number.isFinite(sent)) return false;
    const now = (input.now ?? (() => Date.now()))();
    if (Math.abs(now - sent) > input.toleranceMs) return false;
  }
  const payload = `${input.timestamp}${input.messageId}${input.webhookUrl}${input.body}`;
  const expected = await hmacSha256Hex(input.secretKey, payload);
  return timingSafeEqual(expected, input.signature);
}
