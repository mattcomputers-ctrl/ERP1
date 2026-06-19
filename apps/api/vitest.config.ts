import { defineConfig } from 'vitest/config';

// Unit tests for the API's pure logic (no DB / Nest container). Spec files live
// next to the code they cover (src/**/*.spec.ts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
