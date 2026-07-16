import { timingSafeEqual } from '../crypto';

/**
 * Google Calendar push notifications aren't HMAC-signed; instead you set a
 * channel `token` when creating the watch, and Google echoes it back in the
 * `X-Goog-Channel-Token` header. Verify it matches what you registered.
 */
export interface GoogleWebhookInput {
  expectedToken: string;
  /** Value of the `X-Goog-Channel-Token` header. */
  channelToken: string | null | undefined;
}

export function verifyGoogleChannelToken(input: GoogleWebhookInput): boolean {
  // A misconfigured watch with no token must never accept a request (an empty
  // expected token would otherwise match an empty header).
  if (!input.expectedToken || input.channelToken == null) return false;
  return timingSafeEqual(input.expectedToken, input.channelToken);
}
