import { PROVIDER_GUIDES, PROVIDER_ORDER } from './provider-guides';

/**
 * The docs' table of contents: the sidebar, the prev/next links under every
 * page, and the search index all read this one list, so a page added here
 * appears in all three and a page missing here appears in none.
 * `test/docs-nav.test.ts` checks every href has a page file behind it.
 */
export type DocLink = { title: string; href: string; description: string };
export type DocSection = { title: string; items: DocLink[] };

export const DOC_SECTIONS: DocSection[] = [
  {
    title: 'Get started',
    items: [
      {
        title: 'Introduction',
        href: '/docs',
        description: 'What unibooking is, what it is not, and how these docs are organised.',
      },
      {
        title: 'Quickstart',
        href: '/docs/quickstart',
        description: 'Install the package and make your first call in five minutes.',
      },
      {
        title: 'Installation',
        href: '/docs/installation',
        description: 'Requirements, entry points, and which imports are server-only.',
      },
    ],
  },
  {
    title: 'Core concepts',
    items: [
      {
        title: 'Clients & capabilities',
        href: '/docs/concepts/capabilities',
        description: 'One client per provider, and flags that say what each one can do.',
      },
      {
        title: 'Times & ranges',
        href: '/docs/concepts/time',
        description: 'Offset-bearing instants, display time zones and all-day events.',
      },
      {
        title: 'Errors',
        href: '/docs/concepts/errors',
        description: 'One error type with ten codes, whatever the provider said.',
      },
      {
        title: 'Pagination',
        href: '/docs/concepts/pagination',
        description: 'Opaque page tokens, listAll and collectAll.',
      },
    ],
  },
  {
    title: 'Guides',
    items: [
      {
        title: 'Connecting a provider',
        href: '/docs/guides/connecting',
        description: 'Collect the right credentials and prove they work.',
      },
      {
        title: 'OAuth & token refresh',
        href: '/docs/guides/oauth',
        description: 'Send users to consent, exchange the code, keep tokens fresh.',
      },
      {
        title: 'Multi-tenant connections',
        href: '/docs/guides/multi-tenant',
        description: 'Many businesses, many providers, one store you own.',
      },
      {
        title: 'Webhooks & change sync',
        href: '/docs/guides/webhooks',
        description: 'Verify signed deliveries, watch calendars, sync what changed.',
      },
      {
        title: 'Retries & idempotency',
        href: '/docs/guides/retries',
        description: 'Retry transient failures without double-booking anyone.',
      },
      {
        title: 'Going to production',
        href: '/docs/guides/production',
        description: 'The checklist to work through before real customers depend on it.',
      },
      {
        title: 'Running the explorer',
        href: '/docs/guides/explorer',
        description: 'Run and deploy this site, including one-click calendar sign-in.',
      },
    ],
  },
  {
    title: 'Reference',
    items: [
      {
        title: 'BookingClient',
        href: '/docs/reference/client',
        description: 'Every method on a client, what it needs and what it returns.',
      },
      {
        title: 'Capability flags',
        href: '/docs/reference/capabilities',
        description: 'Each flag, what it unlocks, and which providers set it.',
      },
      {
        title: 'Architecture',
        href: '/docs/reference/architecture',
        description:
          'The layers, the request pipeline, the guarantees, and how the explorer works.',
      },
    ],
  },
  {
    title: 'Providers',
    items: [
      {
        title: 'Overview',
        href: '/docs/providers',
        description: 'Every provider side by side: what it supports and how to connect.',
      },
      ...PROVIDER_ORDER.map((id) => ({
        title: PROVIDER_GUIDES[id].name,
        href: `/docs/providers/${id}`,
        description: PROVIDER_GUIDES[id].summary,
      })),
    ],
  },
];

/** Every page in reading order. */
export const DOC_PAGES: DocLink[] = DOC_SECTIONS.flatMap((s) => s.items);

/** The pages either side of `href`, for the footer of each page. */
export function neighbours(href: string): { prev?: DocLink; next?: DocLink } {
  const i = DOC_PAGES.findIndex((p) => p.href === href);
  if (i === -1) return {};
  return {
    ...(i > 0 ? { prev: DOC_PAGES[i - 1] } : {}),
    ...(i < DOC_PAGES.length - 1 ? { next: DOC_PAGES[i + 1] } : {}),
  };
}

/** The section a page belongs to, shown above its title. */
export function sectionOf(href: string): string | undefined {
  return DOC_SECTIONS.find((s) => s.items.some((p) => p.href === href))?.title;
}
