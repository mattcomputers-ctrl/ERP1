import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests — run the real services against a disposable Postgres
// (DATABASE_URL). Kept separate from the fast unit suite (`vitest.config.ts`):
// these need a database, so they are gated behind `pnpm test:integration` and a
// CI job with a Postgres service. Files share one database, so run them
// sequentially (no file parallelism) and reset tables between tests.
export default defineConfig({
  test: {
    environment: 'node',
    // `*.int.spec.ts` = service-level flow tests; `*.http.spec.ts` = HTTP-layer
    // tests (real Nest app + supertest) covering guards + the ValidationPipe.
    include: ['test/integration/**/*.{int,http}.spec.ts'],
    // The HTTP tests instantiate the real Nest container, whose DI reads
    // `design:paramtypes` decorator metadata — load the reflect-metadata polyfill
    // before any decorated module is imported.
    setupFiles: ['reflect-metadata'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  plugins: [
    // NestJS constructor injection relies on emitted decorator metadata, which
    // vitest's default esbuild transform cannot produce. Transform with SWC so
    // the real module graph (AppModule) can be built by Nest's container in the
    // HTTP-layer tests. Scoped to the integration config only — the unit suite
    // covers pure logic with no decorators.
    swc.vite({
      jsc: {
        target: 'es2021',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
