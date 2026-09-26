import type { MetadataRoute } from 'next';
import { DOC_PAGES } from '../lib/docs/nav';
import { siteUrl } from '../lib/site';

/** Every public page: the Explorer and each docs page, from the same list
 *  the docs sidebar reads, so a new page is listed here automatically. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const url = (path: string) => new URL(path, base).toString();
  return [
    { url: url('/'), changeFrequency: 'weekly', priority: 1 },
    ...DOC_PAGES.map((p) => ({
      url: url(p.href),
      changeFrequency: 'monthly' as const,
      priority: p.href === '/docs' || p.href === '/docs/quickstart' ? 0.9 : 0.7,
    })),
  ];
}
