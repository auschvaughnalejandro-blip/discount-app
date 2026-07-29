import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Stage 7 relies on unique-constraint behaviour for idempotency (R8); tests
    // that share a database must not run concurrently.
    fileParallelism: false,
  },
});
