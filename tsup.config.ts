import { defineConfig } from 'tsup';

export default defineConfig({
  // One entry per public module. Adapters and webhooks are individual entry
  // points so each is its own subpath export and consumers only bundle what
  // they import. Shared modules (`adapter-kit.ts`, `time.ts`, `http.ts`, …) are
  // re-exported from `index.ts` rather than given their own subpath; splitting
  // keeps them in shared chunks instead of duplicating them per entry.
  entry: ['src/index.ts', 'src/adapters/*.ts', 'src/webhooks/*.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  splitting: true,
  treeshake: true,
  outDir: 'dist',
});
