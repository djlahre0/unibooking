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

/** The resource states Google reports: `sync` is the handshake right after a
 *  channel opens (nothing changed yet); `exists` means something in the
 *  watched collection changed; `not_exists` that it was deleted. */
export type GoogleResourceState = 'sync' | 'exists' | 'not_exists';

export interface GoogleNotification {
  channelId: string;
  resourceId: string;
  state: GoogleResourceState;
  /** Increases per message on a channel; `sync` is 1. */
  messageNumber?: number;
  /** The `X-Goog-Channel-Token` — check it with `verifyGoogleChannelToken`. */
  channelToken?: string;
  /** When the channel stops, from `X-Goog-Channel-Expiration`. RFC3339. */
  expiresAt?: string;
}

type HeaderSource = Headers | Record<string, string | string[] | null | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() !== wanted) continue;
    const value = Array.isArray(v) ? v[0] : v;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

const STATES = new Set<GoogleResourceState>(['sync', 'exists', 'not_exists']);

/**
 * Read a Google Calendar push notification. Google sends headers only — no
 * body says what changed — so the response to one is `syncBookings` with your
 * stored sync token. Returns null when the request is not a channel
 * notification. Authenticity is `verifyGoogleChannelToken`'s job; this only
 * reads.
 */
export function parseGoogleNotification(headers: HeaderSource): GoogleNotification | null {
  const channelId = header(headers, 'x-goog-channel-id');
  const resourceId = header(headers, 'x-goog-resource-id');
  const state = header(headers, 'x-goog-resource-state') as GoogleResourceState | undefined;
  if (!channelId || !resourceId || !state || !STATES.has(state)) return null;
  const number = Number(header(headers, 'x-goog-message-number'));
  const token = header(headers, 'x-goog-channel-token');
  const expiration = Date.parse(header(headers, 'x-goog-channel-expiration') ?? '');
  return {
    channelId,
    resourceId,
    state,
    ...(Number.isFinite(number) && number > 0 ? { messageNumber: number } : {}),
    ...(token ? { channelToken: token } : {}),
    ...(!Number.isNaN(expiration) ? { expiresAt: new Date(expiration).toISOString() } : {}),
  };
}
