import { timingSafeEqual } from '../crypto';

/**
 * Microsoft Graph webhooks (Outlook calendar events: Graph v1.0 does not
 * support subscriptions on Bookings resources) use two mechanisms:
 *
 *  1. A validation handshake: when you create a subscription, Graph immediately
 *     GETs/POSTs your notification URL with a `validationToken` query param that
 *     you must echo back as `text/plain` with 200. Use `graphValidationToken`.
 *  2. `clientState`: you set it on the subscription and Graph includes it in
 *     every notification. Compare it with `verifyGraphClientState`.
 *     (Full payload signing requires encrypted resource data + certificates,
 *     which is out of scope for this helper.)
 */
export function graphValidationToken(
  query: URLSearchParams | Record<string, string | undefined> | string,
): string | undefined {
  let params: URLSearchParams;
  if (typeof query === 'string') {
    params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  } else if (query instanceof URLSearchParams) {
    params = query;
  } else {
    const token = query['validationToken'];
    return token !== undefined && token !== '' ? token : undefined;
  }
  const token = params.get('validationToken');
  return token !== null && token !== '' ? token : undefined;
}

/** True if every notification in the payload carries the expected clientState.
 *  An empty `expectedClientState` always fails: clientState is the shared
 *  secret, and a missing/empty one would accept any forged payload that also
 *  sends an empty string. */
export function verifyGraphClientState(payload: unknown, expectedClientState: string): boolean {
  if (!expectedClientState) return false;
  const notifications = (payload as any)?.value;
  if (!Array.isArray(notifications) || notifications.length === 0) return false;
  return notifications.every(
    (n) =>
      typeof n?.clientState === 'string' && timingSafeEqual(n.clientState, expectedClientState),
  );
}

/** What one Graph notification says. Either a change (`changeType`) or, on a
 *  lifecycle URL, a `lifecycleEvent`. */
export interface GraphNotification {
  subscriptionId: string;
  clientState?: string;
  changeType?: 'created' | 'updated' | 'deleted';
  /** The changed resource's path, e.g. `Users/{id}/Events/{eventId}`. */
  resource?: string;
  /** The changed event's id, from `resourceData.id`. */
  resourceId?: string;
  /** `reauthorizationRequired` (renew with fresh credentials),
   *  `subscriptionRemoved` (subscribe again) or `missed` (resync). */
  lifecycleEvent?: 'reauthorizationRequired' | 'subscriptionRemoved' | 'missed';
  subscriptionExpiresAt?: string;
}

const CHANGE_TYPES = new Set(['created', 'updated', 'deleted']);
const LIFECYCLE_EVENTS = new Set(['reauthorizationRequired', 'subscriptionRemoved', 'missed']);

/**
 * Read a Graph change- or lifecycle-notification body (the raw JSON string or
 * its parsed form). Malformed entries are skipped and unreadable input is an
 * empty list, never a throw, so the endpoint can still answer 202 quickly, as
 * Graph requires. Check `verifyGraphClientState` first: this only reads.
 */
export function parseGraphNotifications(payload: unknown): GraphNotification[] {
  let body = payload;
  if (typeof payload === 'string') {
    try {
      body = JSON.parse(payload);
    } catch {
      return [];
    }
  }
  const list = (body as any)?.value;
  if (!Array.isArray(list)) return [];
  const out: GraphNotification[] = [];
  for (const n of list) {
    if (!n || typeof n !== 'object' || typeof n.subscriptionId !== 'string') continue;
    const id = n.resourceData?.id;
    out.push({
      subscriptionId: n.subscriptionId,
      ...(typeof n.clientState === 'string' ? { clientState: n.clientState } : {}),
      ...(CHANGE_TYPES.has(n.changeType) ? { changeType: n.changeType } : {}),
      ...(typeof n.resource === 'string' ? { resource: n.resource } : {}),
      ...(typeof id === 'string' && id ? { resourceId: id } : {}),
      ...(LIFECYCLE_EVENTS.has(n.lifecycleEvent) ? { lifecycleEvent: n.lifecycleEvent } : {}),
      ...(typeof n.subscriptionExpirationDateTime === 'string'
        ? { subscriptionExpiresAt: n.subscriptionExpirationDateTime }
        : {}),
    });
  }
  return out;
}
