import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Live integration tests opt in via env creds and are skipped otherwise.
    testTimeout: 10_000,
  },
});
