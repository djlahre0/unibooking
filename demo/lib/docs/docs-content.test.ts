import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isValidElement } from 'react';
import { PROVIDER_CREDENTIALS } from 'unibooking';
import { ADAPTERS } from '../providers';
import { DOC_PAGES, DOC_SECTIONS, neighbours } from './nav';
import { PROVIDER_GUIDES, PROVIDER_ORDER } from './provider-guides';
import { CAPABILITY_INFO } from './capabilities';
import { tokenize } from './highlight';
import { inline } from './inline';
import { searchDocs, SEARCH_INDEX } from './search';
import { EXPLORER_SECTIONS } from '../explorer-sections';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');

/** The page file that serves a docs href. */
function pageFileFor(href: string): string {
  const provider = /^\/docs\/providers\/([a-z_]+)$/.exec(href);
  if (provider) return join(APP, 'docs', 'providers', '[id]', 'page.tsx');
  return join(APP, ...href.split('/').filter(Boolean), 'page.tsx');
}

describe('docs navigation', () => {
  it('every link in the sidebar has a page behind it', () => {
    for (const page of DOC_PAGES) {
      expect(existsSync(pageFileFor(page.href)), page.href).toBe(true);
    }
  });

  it('has no duplicate pages and a description for each', () => {
    const hrefs = DOC_PAGES.map((p) => p.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const p of DOC_PAGES) expect(p.description.length, p.href).toBeGreaterThan(10);
  });

  it('links neighbours in reading order', () => {
    const first = DOC_SECTIONS[0]!.items[0]!;
    expect(neighbours(first.href).prev).toBeUndefined();
    expect(neighbours(first.href).next?.href).toBe(DOC_SECTIONS[0]!.items[1]!.href);
    expect(neighbours('/nope')).toEqual({});
  });
});

describe('provider guides', () => {
  it('cover exactly the providers the library ships', () => {
    expect([...PROVIDER_ORDER].sort()).toEqual(Object.keys(PROVIDER_CREDENTIALS).sort());
    expect(new Set(PROVIDER_ORDER).size).toBe(PROVIDER_ORDER.length);
  });

  it('give every usable provider steps, notes and an https docs link', () => {
    for (const id of PROVIDER_ORDER) {
      const g = PROVIDER_GUIDES[id];
      expect(g.steps.length, id).toBeGreaterThan(0);
      expect(g.notes.length, id).toBeGreaterThan(0);
      expect(g.docsUrl, id).toMatch(/^https:\/\//);
      if (g.portal) expect(g.portal.href, id).toMatch(/^https:\/\//);
    }
  });

  it('only name webhook verifiers for providers whose adapter says it has them', () => {
    for (const id of PROVIDER_ORDER) {
      const caps = ADAPTERS[id]!.capabilities;
      if (PROVIDER_GUIDES[id].webhook && id !== 'google' && id !== 'outlook') {
        expect(caps.webhooks, id).toBe(true);
      }
    }
  });
});

describe('capability labels', () => {
  it('cover every flag the adapters report', () => {
    const flags = Object.keys(ADAPTERS.square!.capabilities).sort();
    expect(Object.keys(CAPABILITY_INFO).sort()).toEqual(flags);
  });
});

describe('highlight', () => {
  it('colours keywords, strings, comments, calls and types, losing no text', () => {
    const code = "import { square } from 'unibooking'; // hi\nconst c = square(Creds);";
    const tokens = tokenize(code, 'ts');
    expect(tokens.map((t) => t.text).join('')).toBe(code);
    const typeOf = (text: string) => tokens.find((t) => t.text === text)?.type;
    expect(typeOf('import')).toBe('keyword');
    expect(typeOf("'unibooking'")).toBe('string');
    expect(typeOf('// hi')).toBe('comment');
    expect(typeOf('Creds')).toBe('type');
    expect(tokens.find((t) => t.text === 'square' && t.type === 'fn')).toBeTruthy();
  });

  it('marks the command word of each shell line', () => {
    const tokens = tokenize('npm install unibooking\n# note', 'bash');
    expect(tokens[0]).toEqual({ type: 'fn', text: 'npm' });
    expect(tokens.find((t) => t.type === 'comment')?.text).toBe('# note');
  });
});

describe('inline markup', () => {
  it('builds elements for code, bold and links, and leaves the rest as text', () => {
    const out = inline('Use `x` and **y** at [docs](https://example.com) now');
    expect(out.filter((n) => typeof n === 'string')).toEqual(['Use ', ' and ', ' at ', ' now']);
    expect(out.filter(isValidElement)).toHaveLength(3);
  });

  it('never links a javascript: URL', () => {
    const out = inline('[click](javascript:alert(1))');
    expect(out.some(isValidElement)).toBe(false);
  });

  it('does not italicise snake_case', () => {
    expect(inline('microsoft_bookings_id')).toEqual(['microsoft_bookings_id']);
  });
});

describe('search', () => {
  it('indexes docs pages, providers and every explorer section', () => {
    expect(SEARCH_INDEX.length).toBe(DOC_PAGES.length + EXPLORER_SECTIONS.length);
  });

  it('ranks a title match first and needs every word', () => {
    expect(searchDocs('square')[0]?.href).toBe('/docs/providers/square');
    expect(searchDocs('oauth refresh')[0]?.href).toBe('/docs/guides/oauth');
    expect(searchDocs('zzzz-nothing')).toEqual([]);
  });

  it('suggests the Get started pages for an empty query', () => {
    expect(searchDocs('').map((r) => r.href)).toContain('/docs/quickstart');
  });
});
