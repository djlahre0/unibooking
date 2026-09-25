import { describe, expect, it } from 'vitest';
import { parseGoogleNotification } from '../src/webhooks/google';
import { parseGraphNotifications } from '../src/webhooks/outlook';

/**
 * What a notification says, once it is known to be authentic. Google sends
 * headers and no body (developers.google.com/calendar/api/guides/push); Graph
 * posts a changeNotificationCollection, with lifecycle events on their own URL
 * (learn.microsoft.com/graph/change-notifications-lifecycle-events).
 */

describe('parseGoogleNotification', () => {
  const HEADERS = {
    'X-Goog-Channel-ID': 'ch-1',
    'X-Goog-Channel-Token': 'shared-secret',
    'X-Goog-Channel-Expiration': 'Tue, 29 Sep 2026 10:00:00 GMT',
    'X-Goog-Resource-ID': 'o3hgv1538sdjfh',
    'X-Goog-Resource-URI':
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?alt=json',
    'X-Goog-Resource-State': 'exists',
    'X-Goog-Message-Number': '3',
  };

  it('reads the channel headers, from a Headers object or a plain record', () => {
    const expected = {
      channelId: 'ch-1',
      resourceId: 'o3hgv1538sdjfh',
      state: 'exists',
      messageNumber: 3,
      channelToken: 'shared-secret',
      expiresAt: '2026-09-29T10:00:00.000Z',
    };
    expect(parseGoogleNotification(new Headers(HEADERS))).toEqual(expected);
    // Node's IncomingMessage lower-cases header names.
    const lowerCased = Object.fromEntries(
      Object.entries(HEADERS).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(parseGoogleNotification(lowerCased)).toEqual(expected);
  });

  it('marks the handshake that follows a new channel', () => {
    const n = parseGoogleNotification({ ...HEADERS, 'X-Goog-Resource-State': 'sync' });
    expect(n?.state).toBe('sync');
  });

  it('returns null for a request that is not a channel notification', () => {
    expect(parseGoogleNotification({ 'content-type': 'application/json' })).toBeNull();
    expect(parseGoogleNotification({ ...HEADERS, 'X-Goog-Resource-State': 'bogus' })).toBeNull();
  });
});

describe('parseGraphNotifications', () => {
  it('reads change notifications', () => {
    const body = {
      value: [
        {
          id: 'lsgTZMr9KwAAA',
          subscriptionId: '7f105c7d-2dc5-4530-97cd-4e7ae6534c07',
          subscriptionExpirationDateTime: '2026-09-29T09:50:00+00:00',
          clientState: 'shared-secret',
          changeType: 'updated',
          resource: 'Users/8ee44408/Events/AAMk-1',
          tenantId: 'bb8775a4-4d8c-42cf-a1d4-4d58c2bb668f',
          resourceData: {
            '@odata.type': '#Microsoft.Graph.Event',
            '@odata.id': 'Users/8ee44408/Events/AAMk-1',
            '@odata.etag': 'W/"DwAAABYAAAB"',
            id: 'AAMk-1',
          },
        },
      ],
    };
    expect(parseGraphNotifications(body)).toEqual([
      {
        subscriptionId: '7f105c7d-2dc5-4530-97cd-4e7ae6534c07',
        clientState: 'shared-secret',
        changeType: 'updated',
        resource: 'Users/8ee44408/Events/AAMk-1',
        resourceId: 'AAMk-1',
        subscriptionExpiresAt: '2026-09-29T09:50:00+00:00',
      },
    ]);
  });

  it('reads lifecycle notifications', () => {
    const body = {
      value: [
        {
          subscriptionId: '7f105c7d-2dc5-4530-97cd-4e7ae6534c07',
          subscriptionExpirationDateTime: '2026-09-29T09:50:00+00:00',
          tenantId: 'bb8775a4-4d8c-42cf-a1d4-4d58c2bb668f',
          clientState: 'shared-secret',
          lifecycleEvent: 'reauthorizationRequired',
        },
      ],
    };
    expect(parseGraphNotifications(body)[0]).toMatchObject({
      subscriptionId: '7f105c7d-2dc5-4530-97cd-4e7ae6534c07',
      lifecycleEvent: 'reauthorizationRequired',
    });
  });

  it('parses a raw JSON string and ignores malformed entries', () => {
    expect(parseGraphNotifications('{"value":[{"nope":1},null]}')).toEqual([]);
    expect(parseGraphNotifications('not json')).toEqual([]);
    expect(parseGraphNotifications(undefined)).toEqual([]);
  });
});
