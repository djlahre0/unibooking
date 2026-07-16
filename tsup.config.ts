import { defineConfig } from 'tsup';

export default defineConfig({
  // One entry per public module. Adapters and webhooks are individual entry
  // points so each is its own subpath export and consumers only bundle what
  // they import. `adapter-kit.ts` / `time.ts` / `http.ts` are internal and get
  // inlined into the entries that use them (splitting keeps shared chunks).
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
