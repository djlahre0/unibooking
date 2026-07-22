import { hmacSha256Hex, timingSafeEqual } from '../crypto';

/**
 * Verify a Calendly webhook signature. Calendly signs `"<t>.<rawBody>"` with your
 * webhook signing key (HMAC-SHA256, hex) and sends it in the
 * `Calendly-Webhook-Signature` header as `t=<unix>,v1=<hex>`.
 *
 * Pass the EXACT raw request body (not a re-serialized object).
 *
 * Calendly's docs recommend rejecting deliveries whose `t=` timestamp is older
 * than a small tolerance (they suggest 3 minutes) to blunt replay attacks. Pass
 * `toleranceMs` to enable that check (off by default so a caller with clock
 * skew isn't silently locked out) — same opt-in shape as the Bookeo helper.
 */
export interface CalendlyWebhookInput {
  signingKey: string;
  body: string;
  /** Value of the `Calendly-Webhook-Signature` header (`t=...,v1=...`). */
  signatureHeader: string;
  /** When set, reject a `t=` (unix seconds) further than this from `now`.
   *  Calendly suggests 180000 (3 minutes). */
  toleranceMs?: number;
  /** Injectable clock for tests (epoch ms). */
  now?: () => number;
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
  if (input.toleranceMs !== undefined) {
    const sentSec = Number(t);
    if (!Number.isFinite(sentSec)) return false;
    const now = (input.now ?? (() => Date.now()))();
    if (Math.abs(now - sentSec * 1000) > input.toleranceMs) return false;
  }
  const expected = await hmacSha256Hex(input.signingKey, `${t}.${input.body}`);
  return timingSafeEqual(expected, v1);
}
