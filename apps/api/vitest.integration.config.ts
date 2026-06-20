import { defineConfig } from 'vitest/config';

// Integration tests — run the real services against a disposable Postgres
// (DATABASE_URL). Kept separate from the fast unit suite (`vitest.config.ts`):
// these need a database, so they are gated behind `pnpm test:integration` and a
// CI job with a Postgres service. Files share one database, so run them
// sequentially (no file parallelism) and reset tables between tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.int.spec.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
