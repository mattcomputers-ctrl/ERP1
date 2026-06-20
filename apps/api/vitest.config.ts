import { defineConfig } from 'vitest/config';

// Unit tests for the API's pure logic (no DB / Nest container). Spec files live
// next to the code they cover (src/**/*.spec.ts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Integration tests (test/integration/**) need a database and run via
    // `pnpm test:integration` (vitest.integration.config.ts) — keep them out of
    // the fast unit suite.
    exclude: ['**/node_modules/**', 'test/integration/**'],
  },
});
