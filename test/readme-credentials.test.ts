import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROVIDER_CREDENTIALS } from '../src/credentials';

/**
 * The README's required-credentials table is what an adopter reads before
 * writing any code, and a stale one sends them looking for a field that does
 * not exist. Same rationale as readme-table.test.ts: assert it against the
 * schema rather than re-checking it by hand.
 */
const README = readFileSync(
  resolve(fileURLToPath(new URL('../README.md', import.meta.url))),
  'utf8',
);

function expectedRow(id: string): string {
  const fields = PROVIDER_CREDENTIALS[id as keyof typeof PROVIDER_CREDENTIALS][0]!.fields;
  const fmt = (list: typeof fields) => list.map((f) => `\`${f.key}\``).join(', ');
  const req = fmt(fields.filter((f) => f.required));
  const opt = fmt(fields.filter((f) => !f.required)) || '-';
  return `| \`${id}\` | ${req} | ${opt} |`;
}

describe('README required-credentials table', () => {
  it('has a row for every provider, matching the schema exactly', () => {
    for (const id of Object.keys(PROVIDER_CREDENTIALS)) {
      expect(README, `${id}'s row is missing or stale`).toContain(expectedRow(id));
    }
  });

  it('leaves no unrendered placeholder behind', () => {
    expect(README).not.toContain('CREDENTIALS-TABLE');
  });

  it('never prints a credential value, only field names', () => {
    // The table is generated from keys; a value appearing here would mean
    // someone hand-edited a real credential into the docs.
    const table = README.slice(README.indexOf('| Provider | Required | Optional |'));
    const rows = table.slice(0, table.indexOf('\n\n'));
    // Long opaque strings are what a leaked token looks like.
    expect(rows).not.toMatch(/[A-Za-z0-9_-]{32,}/);
  });
});
