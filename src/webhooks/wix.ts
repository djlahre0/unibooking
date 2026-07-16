import { verifyRs256Jwt } from '../crypto';

/**
 * Verify a Wix webhook. Wix delivers events as an RS256-signed JWT in the raw
 * request body, signed with your Wix app's public key (from the app dashboard).
 *
 * Returns the decoded JWT payload on success (its `data` field is itself a
 * JSON-encoded string you then parse), or `null` if the signature is invalid.
 *
 * Pass the EXACT raw request body (the JWT string) and your app's public key PEM.
 */
export interface WixWebhookInput {
  /** The raw request body — a signed JWT. */
  jwt: string;
  /** Your Wix app public key (SPKI PEM). */
  publicKey: string;
}

export async function verifyWixWebhook(
  input: WixWebhookInput,
): Promise<Record<string, any> | null> {
  return verifyRs256Jwt(input.jwt.trim(), input.publicKey);
}
