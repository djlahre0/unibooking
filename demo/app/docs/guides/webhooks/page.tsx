import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import Link from 'next/link';
import { Callout, Code, DocPage, H2, H3 } from '../../_components/Doc';
import { PROVIDER_GUIDES, PROVIDER_ORDER } from '@/lib/docs/provider-guides';

export const metadata: Metadata = docMetadata({
  title: 'Webhooks & change sync',
  description: 'Verify signed deliveries, watch calendars, and sync what changed.',
  href: '/docs/guides/webhooks',
});

const withWebhooks = PROVIDER_ORDER.filter((id) => PROVIDER_GUIDES[id].webhook);

export default function Webhooks() {
  return (
    <DocPage
      href="/docs/guides/webhooks"
      title="Webhooks & change sync"
      lead="There are two ways to learn that bookings changed: the provider calls your endpoint (webhooks), or you ask what changed since last time (sync). Calendars support both."
    >
      <H2>Verify every delivery</H2>
      <p>
        A webhook endpoint is public, so anyone can post to it. Verify each delivery against the
        <strong> raw request body</strong>. Re-serialising parsed JSON changes the bytes and the
        signature will not match.
      </p>
      <Code title="app/webhooks/square/route.ts">{`
import { verifySquareSignature } from 'unibooking/webhooks/square';

export async function POST(request: Request) {
  const body = await request.text(); // raw, exactly as sent
  const valid = await verifySquareSignature({
    signatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY!,
    notificationUrl: 'https://app.example.com/webhooks/square',
    body,
    signature: request.headers.get('x-square-hmacsha256-signature') ?? '',
  });
  if (!valid) return new Response('invalid signature', { status: 401 });

  await queue.push(JSON.parse(body)); // process after answering
  return new Response(null, { status: 200 });
}
`}</Code>
      <p>
        Verifiers return <code>false</code> for a missing or malformed signature instead of
        throwing, so an unsigned request gets your 401, not a 500. Comparisons are constant-time.
      </p>

      <H3>Verifiers by provider</H3>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Import from</th>
            <th>Functions</th>
          </tr>
        </thead>
        <tbody>
          {withWebhooks.map((id) => {
            const w = PROVIDER_GUIDES[id].webhook!;
            return (
              <tr key={id}>
                <td>
                  <Link href={`/docs/providers/${id}`}>{PROVIDER_GUIDES[id].name}</Link>
                </td>
                <td>
                  <code>{w.module}</code>
                </td>
                <td>
                  {w.fns.map((f, i) => (
                    <span key={f}>
                      {i > 0 && ', '}
                      <code>{f}</code>
                    </span>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Callout type="tip" title="Reject replays">
        Calendly and Bookeo sign a timestamp. Pass <code>toleranceMs</code> (180000 and 120000 are
        their suggestions) to reject deliveries replayed later.
      </Callout>

      <H2>Watch a calendar</H2>
      <p>
        Google and Outlook can notify you when a calendar changes. Open a watch, store it, renew it
        before it expires, and stop it when you disconnect:
      </p>
      <Code>{`
const watch = await client.watchBookings!({
  address: 'https://app.example.com/webhooks/calendar',
  token: crypto.randomUUID(), // echoed on every notification; verify it
  ttlSeconds: 7 * 24 * 3600,
});
await db.saveWatch(tenantId, watch); // { id, resourceId?, expiresAt }

// Before watch.expiresAt:
const renewed = await client.renewWatch!(watch, input);

// On disconnect:
await client.stopWatch!(watch);
`}</Code>
      <p>
        Outlook validates your endpoint while creating the subscription: answer Graph&apos;s{' '}
        <code>validationToken</code> with <code>graphValidationToken</code>. Google&apos;s
        notifications carry no body: they only say &ldquo;something changed&rdquo;, so answer them
        with a sync.
      </p>

      <H2>Sync what changed</H2>
      <p>
        <code>syncBookings</code> returns changes since a sync token (Google, Outlook, Apple). The
        first call, without a token, returns everything as upserts:
      </p>
      <Code>{`
let { syncToken } = await db.loadSyncState(calendarId);
let pageToken: string | undefined;

do {
  const page = await client.syncBookings!({ syncToken, pageToken, range });
  if (page.fullSyncRequired) {
    await db.clearMirror(calendarId); // the token expired: start again
    syncToken = undefined;
    continue;
  }
  for (const change of page.changes) {
    if (change.type === 'upsert') await db.upsert(change.booking);
    else await db.remove(change.id);
  }
  pageToken = page.nextPageToken;
  if (page.syncToken) syncToken = page.syncToken;
} while (pageToken);

await db.saveSyncState(calendarId, { syncToken });
`}</Code>
    </DocPage>
  );
}
