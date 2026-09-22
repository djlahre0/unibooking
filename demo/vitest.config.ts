import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Component tests (*.test.tsx) opt into jsdom per file with a
    // `@vitest-environment jsdom` docblock; everything else stays on node.
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts', 'app/**/*.test.tsx'],
  },
  resolve: {
    // route.ts imports via "@/lib/...", which Next resolves through tsconfig
    // paths. Vitest needs it spelled out.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
});
