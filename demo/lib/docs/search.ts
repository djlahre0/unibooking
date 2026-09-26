import { DOC_SECTIONS } from './nav';
import { EXPLORER_SECTIONS } from '../explorer-sections';

/** One thing the ⌘K search can take you to. */
export type SearchEntry = {
  title: string;
  href: string;
  description: string;
  /** Shown beside the title: the docs section, or "Explorer". */
  group: string;
};

export const SEARCH_INDEX: SearchEntry[] = [
  ...DOC_SECTIONS.flatMap((s) => s.items.map((p) => ({ ...p, group: s.title }))),
  ...EXPLORER_SECTIONS.map((s) => ({
    title: s.label,
    href: `/?tab=${s.id}`,
    description: s.description,
    group: 'Explorer',
  })),
];

/**
 * Rank entries for a query. Every word must appear somewhere; a title that
 * starts with the query beats one that contains it, which beats a match in the
 * description. An empty query returns the Get started pages, a sensible
 * default for someone who opened search to look around.
 */
export function searchDocs(query: string, limit = 8): SearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return SEARCH_INDEX.filter((e) => e.group === 'Get started').slice(0, limit);
  const words = q.split(/\s+/);
  const scored: Array<{ e: SearchEntry; score: number }> = [];
  for (const e of SEARCH_INDEX) {
    const title = e.title.toLowerCase();
    const hay = `${title} ${e.description.toLowerCase()} ${e.group.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const score = title.startsWith(q) ? 3 : title.includes(q) ? 2 : 1;
    scored.push({ e, score });
  }
  // Stable: equal scores keep index order, which is reading order.
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.e);
}
