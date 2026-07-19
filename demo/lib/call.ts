'use client';

import {
  createRegistry,
  isRetryable,
  codeForStatus,
  isUnibookingError,
  UnibookingError,
} from 'unibooking';
import type { ProviderId } from 'unibooking';

/* ── Webhook verifiers (pure crypto — run client-side) ── */
import { verifySquareSignature } from 'unibooking/webhooks/square';
import { verifyAcuitySignature } from 'unibooking/webhooks/acuity';
import { verifyCalendlySignature } from 'unibooking/webhooks/calendly';
import { verifyGoogleChannelToken } from 'unibooking/webhooks/google';
import { verifyMindbodySignature } from 'unibooking/webhooks/mindbody';
import { graphValidationToken, verifyGraphClientState } from 'unibooking/webhooks/outlook';
import { verifyBoulevardSignature } from 'unibooking/webhooks/boulevard';
import { verifyVagaroToken } from 'unibooking/webhooks/vagaro';
import { verifyWixWebhook } from 'unibooking/webhooks/wix';

import { ADAPTERS, isDirect } from './providers';
import { type Op } from './dispatch';
import { serializeError, type ActionResult } from './result';
import { runDirect } from './transport-direct';
import { runProxy } from './transport-proxy';

export type { ActionResult } from './result';

/* ═══════════════════════════════════════════════════════════
   Transport picker — the one place that chooses direct vs proxy.
   ═══════════════════════════════════════════════════════════ */
function run(
  provider: string,
  creds: Record<string, string>,
  op: Op,
  args: unknown,
): Promise<ActionResult> {
  return isDirect(provider)
    ? runDirect(provider, op, creds, args)
    : runProxy(provider, op, creds, args);
}

/* ═══════════════════════════════════════════════════════════
   Pure operations — no network, run client-side for every provider.
   ═══════════════════════════════════════════════════════════ */
export async function getCapabilities(providerId: string): Promise<ActionResult> {
  if (!Object.hasOwn(ADAPTERS, providerId)) {
    return { ok: false, error: { message: `Unknown provider: ${providerId}` } };
  }
  const adapter = ADAPTERS[providerId];
  return { ok: true, data: { id: adapter.id, capabilities: adapter.capabilities } };
}

export async function demoRegistry(): Promise<ActionResult> {
  try {
    const registry = createRegistry(Object.values(ADAPTERS));
    const ids = registry.ids();
    const details = ids.map((id: ProviderId) => {
      const adapter = registry.get(id);
      return { id: adapter.id, capabilities: adapter.capabilities };
    });
    return {
      ok: true,
      data: {
        registeredProviders: ids,
        count: ids.length,
        details,
        hasSquare: registry.has('square'),
        tryGetNonExistent: registry.tryGet('nonexistent' as ProviderId) === undefined,
      },
    };
  } catch (e) {
    return serializeError(e);
  }
}

export async function demoErrorHelpers(): Promise<ActionResult> {
  return {
    ok: true,
    data: {
      codeForStatus: {
        '401 → ': codeForStatus(401),
        '403 → ': codeForStatus(403),
        '404 → ': codeForStatus(404),
        '409 → ': codeForStatus(409),
        '422 → ': codeForStatus(422),
        '429 → ': codeForStatus(429),
        '500 → ': codeForStatus(500),
        '503 → ': codeForStatus(503),
      },
      isRetryable: {
        AUTH: isRetryable('AUTH'),
        RATE_LIMIT: isRetryable('RATE_LIMIT'),
        UPSTREAM: isRetryable('UPSTREAM'),
        NETWORK: isRetryable('NETWORK'),
        TIMEOUT: isRetryable('TIMEOUT'),
        NOT_FOUND: isRetryable('NOT_FOUND'),
        CONFLICT: isRetryable('CONFLICT'),
        INVALID_INPUT: isRetryable('INVALID_INPUT'),
        UNSUPPORTED: isRetryable('UNSUPPORTED'),
      },
      isUnibookingError: {
        'new UnibookingError(...)': isUnibookingError(
          new UnibookingError({ provider: 'google', code: 'AUTH', message: 'test' }),
        ),
        'new Error(...)': isUnibookingError(new Error('plain error')),
        string: isUnibookingError('not an error'),
      },
    },
  };
}

export async function verifyWebhook(
  provider: string,
  fields: Record<string, string>,
): Promise<ActionResult> {
  try {
    let result: unknown;
    switch (provider) {
      case 'square':
        result = await verifySquareSignature({
          signatureKey: fields.signatureKey || '',
          notificationUrl: fields.notificationUrl || '',
          body: fields.body || '',
          signature: fields.signature || '',
        });
        break;
      case 'acuity':
        result = await verifyAcuitySignature({
          apiKey: fields.apiKey || '',
          body: fields.body || '',
          signature: fields.signature || '',
        });
        break;
      case 'calendly':
        result = await verifyCalendlySignature({
          signingKey: fields.signingKey || '',
          body: fields.body || '',
          signatureHeader: fields.signatureHeader || '',
        });
        break;
      case 'google':
        result = verifyGoogleChannelToken({
          expectedToken: fields.expectedToken || '',
          channelToken: fields.channelToken || '',
        });
        break;
      case 'mindbody':
        result = await verifyMindbodySignature({
          signatureKey: fields.signatureKey || '',
          body: fields.body || '',
          signature: fields.signature || '',
        });
        break;
      case 'outlook':
        if (fields.mode === 'validation') {
          result = graphValidationToken(fields.queryString || '');
        } else {
          let payload: unknown;
          try {
            payload = JSON.parse(fields.payload || '{}');
          } catch {
            payload = {};
          }
          result = verifyGraphClientState(payload, fields.expectedClientState || '');
        }
        break;
      case 'boulevard':
        result = await verifyBoulevardSignature({
          signingSecret: fields.signingSecret || '',
          salt: fields.salt || '',
          body: fields.body || '',
          signature: fields.signature || '',
        });
        break;
      case 'vagaro':
        result = verifyVagaroToken(fields.received || '', fields.expected || '');
        break;
      case 'wix':
        result = await verifyWixWebhook({
          jwt: fields.jwt || '',
          publicKey: fields.publicKey || '',
        });
        break;
      default:
        return { ok: false, error: { message: `Unknown webhook provider: ${provider}` } };
    }
    return { ok: true, data: { provider, verified: result } };
  } catch (e) {
    return serializeError(e);
  }
}

/* ═══════════════════════════════════════════════════════════
   Client-requiring operations — same signatures the page already
   used, so call sites are unchanged. Each picks its transport.
   ═══════════════════════════════════════════════════════════ */
export function callCreateBooking(
  providerId: string,
  creds: Record<string, string>,
  input: {
    title: string;
    start: string;
    end: string;
    serviceId?: string;
    staffId?: string;
    customerName?: string;
    customerEmail?: string;
    idempotencyKey?: string;
  },
): Promise<ActionResult> {
  return run(providerId, creds, 'createBooking', input);
}

export function callGetBooking(
  providerId: string,
  creds: Record<string, string>,
  bookingId: string,
): Promise<ActionResult> {
  return run(providerId, creds, 'getBooking', { bookingId });
}

export function callUpdateBooking(
  providerId: string,
  creds: Record<string, string>,
  bookingId: string,
  input: { title?: string; start?: string; end?: string; staffId?: string; serviceId?: string },
): Promise<ActionResult> {
  return run(providerId, creds, 'updateBooking', { bookingId, input });
}

export function callCancelBooking(
  providerId: string,
  creds: Record<string, string>,
  bookingId: string,
  reason?: string,
): Promise<ActionResult> {
  return run(providerId, creds, 'cancelBooking', { bookingId, reason });
}

export function callListBookings(
  providerId: string,
  creds: Record<string, string>,
  query: { start: string; end: string; limit?: number; pageToken?: string },
): Promise<ActionResult> {
  return run(providerId, creds, 'listBookings', query);
}

export function callSearchAvailability(
  providerId: string,
  creds: Record<string, string>,
  query: { start: string; end: string; timezone?: string; serviceId?: string; staffId?: string },
): Promise<ActionResult> {
  return run(providerId, creds, 'searchAvailability', query);
}

export function callFindOrCreateCustomer(
  providerId: string,
  creds: Record<string, string>,
  customer: { name?: string; email?: string; phone?: string },
): Promise<ActionResult> {
  return run(providerId, creds, 'findOrCreate', customer);
}

export function demoWithRetry(
  providerId: string,
  creds: Record<string, string>,
  query: { start: string; end: string },
): Promise<ActionResult> {
  return run(providerId, creds, 'withRetryList', query);
}

export function demoCollectAll(
  providerId: string,
  creds: Record<string, string>,
  query: { start: string; end: string },
): Promise<ActionResult> {
  return run(providerId, creds, 'collectAll', query);
}

export function demoListAll(
  providerId: string,
  creds: Record<string, string>,
  query: { start: string; end: string },
): Promise<ActionResult> {
  return run(providerId, creds, 'listAll', query);
}
