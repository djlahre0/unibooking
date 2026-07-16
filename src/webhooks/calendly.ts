import { hmacSha256Hex, timingSafeEqual } from '../crypto';

/**
 * Verify a Calendly webhook signature. Calendly signs `"<t>.<rawBody>"` with your
 * webhook signing key (HMAC-SHA256, hex) and sends it in the
 * `Calendly-Webhook-Signature` header as `t=<unix>,v1=<hex>`.
 *
 * Pass the EXACT raw request body (not a re-serialized object).
 */
export interface CalendlyWebhookInput {
  signingKey: string;
  body: string;
  /** Value of the `Calendly-Webhook-Signature` header (`t=...,v1=...`). */
  signatureHeader: string;
}

function parseHeader(header: string): { t?: string; v1?: string } {
  const out: { t?: string; v1?: string } = {};
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    const key = k?.trim();
    const val = v?.trim();
    if (!val) continue;
    if (key === 't') out.t = val;
    else if (key === 'v1') out.v1 = val;
  }
  return out;
}

export async function verifyCalendlySignature(input: CalendlyWebhookInput): Promise<boolean> {
  const { t, v1 } = parseHeader(input.signatureHeader);
  if (!t || !v1) return false;
  const expected = await hmacSha256Hex(input.signingKey, `${t}.${input.body}`);
  return timingSafeEqual(expected, v1);
}
