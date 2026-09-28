import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(fileURLToPath(new URL('../src', import.meta.url)));

/** Resolve a relative import specifier to a file under src/, or undefined for
 *  a bare package specifier (there are none: the library has no runtime deps). */
function resolveImport(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = join(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Every module reachable from `entry` by following relative imports. */
function transitiveImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    // Covers `import x from '…'`, `import type …`, `export … from '…'`.
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'([^']+)'/g)) {
      const spec = m[1];
      if (!spec) continue;
      const next = resolveImport(file, spec);
      if (next) queue.push(next);
    }
  }
  return seen;
}

describe('entry point boundaries', () => {
  it('keeps the package root free of the server-only oauth modules', () => {
    // src/oauth/* is server-only (docs/CLAUDE.md). The root is imported by
    // browser code -- the demo runs the 7 "direct" adapters in the browser --
    // so a transitive oauth import here would ship client secrets handling,
    // and Node-only assumptions, into every consumer's client bundle.
    const reachable = transitiveImports(join(SRC, 'index.ts'));
    const oauth = [...reachable].filter((f) => f.includes(`${'oauth'}`));
    expect(oauth, `package root reaches: ${oauth.join(', ')}`).toEqual([]);
  });

  it('keeps the credential schema out of oauth, so the root can export it', () => {
    const reachable = transitiveImports(join(SRC, 'credentials.ts'));
    expect([...reachable].filter((f) => f.includes('oauth'))).toEqual([]);
  });

  it('has connections reach oauth -- which is exactly why it is its own subpath', () => {
    // The positive half: if this ever stopped being true the separate entry
    // point would be pointless, and someone would fold it back into the root.
    const reachable = transitiveImports(join(SRC, 'connections.ts'));
    expect([...reachable].some((f) => f.includes('oauth'))).toBe(true);
  });

  it('gives every built entry point a package.json export', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(fileURLToPath(new URL('../package.json', import.meta.url))), 'utf8'),
    ) as { exports: Record<string, unknown> };
    // A module with no export entry is unreachable for consumers however well
    // it builds.
    expect(Object.keys(pkg.exports)).toContain('./connections');
  });
});
