import type { Metadata } from 'next';
import { SITE_NAME } from '../site';

/**
 * A docs page's full metadata. Next.js merges metadata shallowly, so a page
 * that set only `openGraph.url` would drop the social title and description
 * the root layout declared. Building the whole object here keeps every page's
 * share card complete, and the canonical URL pointed at itself.
 */
export function docMetadata({
  title,
  description,
  href,
}: {
  title: string;
  description: string;
  href: string;
}): Metadata {
  const full = `${title} | ${SITE_NAME}`;
  // The root opengraph-image is only inherited while no child sets
  // `openGraph` itself, so a page that does must name it again.
  const images = [{ url: '/opengraph-image', width: 1200, height: 630, alt: full }];
  return {
    title,
    description,
    alternates: { canonical: href },
    openGraph: {
      type: 'article',
      siteName: SITE_NAME,
      title: full,
      description,
      url: href,
      images,
    },
    twitter: { card: 'summary_large_image', title: full, description, images },
  };
}
