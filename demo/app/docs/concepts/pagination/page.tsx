import type { Metadata } from 'next';
import { docMetadata } from '@/lib/docs/meta';
import { Callout, Code, DocPage, H2 } from '../../_components/Doc';

export const metadata: Metadata = docMetadata({
  title: 'Pagination',
  description: 'Opaque page tokens, listAll and collectAll.',
  href: '/docs/concepts/pagination',
});

export default function Pagination() {
  return (
    <DocPage
      href="/docs/concepts/pagination"
      title="Pagination"
      lead="Every list returns one page and, when there is more, a nextPageToken. Pass it back unchanged to get the next page."
    >
      <H2>Page by page</H2>
      <Code>{`
let pageToken: string | undefined;
do {
  const page = await client.listBookings({ range, limit: 100, pageToken });
  handle(page.bookings);
  pageToken = page.nextPageToken;
} while (pageToken);
`}</Code>
      <p>
        Treat the token as opaque. Depending on the provider it is a cursor, a page number or a full
        URL; the adapter knows which. A missing token means the last page.
      </p>

      <H2>Every booking at once</H2>
      <p>
        <code>listAll</code> walks every page for you as an async iterator, and{' '}
        <code>collectAll</code> gathers them into an array:
      </p>
      <Code>{`
import { listAll, collectAll } from 'unibooking';

for await (const booking of listAll(client, { range })) {
  await upsert(booking);
}

const all = await collectAll(client, { range }, { maxPages: 50 });
`}</Code>
      <p>
        Both stop on a missing, repeated or cycling token and at <code>maxPages</code> (default
        1000), so a misbehaving provider cannot loop forever.
      </p>

      <H2>About limit</H2>
      <p>
        <code>limit</code> is forwarded where the provider has a page size. Where it does not, the
        last page is trimmed locally, but a page that has a successor is never cut, because the
        items between the cut and the next page would be lost.
      </p>

      <Callout type="warning" title="Pass tokens back, do not build them">
        Outlook and Microsoft Bookings tokens are full Graph URLs. The library only ever sends
        credentials to the provider host you configured, so a forged token cannot leak them, but a
        token that did not come from the previous page is still an error, not a shortcut.
      </Callout>
    </DocPage>
  );
}
