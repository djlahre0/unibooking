import { timingSafeEqual } from '../crypto';

/**
 * Microsoft Graph webhooks (Outlook & Microsoft Bookings) use two mechanisms:
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

/** True if every notification in the payload carries the expected clientState. */
export function verifyGraphClientState(payload: unknown, expectedClientState: string): boolean {
  const notifications = (payload as any)?.value;
  if (!Array.isArray(notifications) || notifications.length === 0) return false;
  return notifications.every(
    (n) => typeof n?.clientState === 'string' && timingSafeEqual(n.clientState, expectedClientState),
  );
}
