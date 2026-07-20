import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
  },
  resolve: {
    // route.ts imports via "@/lib/...", which Next resolves through tsconfig
    // paths. Vitest needs it spelled out.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
});
