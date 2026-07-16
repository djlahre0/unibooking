/**
 * Vagaro webhook verification. Unlike Square/Outlook, Vagaro does not HMAC-sign its
 * payloads — it sends a **static shared verification token** in the `X-Vagaro-Signature`
 * header that you compare against the token you configured. This is a constant-time
 * string comparison, not a signature check.
 */
export function verifyVagaroToken(received: string | null | undefined, expected: string): boolean {
  if (!received || !expected) return false;
  const a = new TextEncoder().encode(received);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
