import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Each test that touches PgEngine boots a fresh PGlite (WASM Postgres)
    // instance, which is much slower than the pure-JS logic this suite
    // previously exercised.
    testTimeout: 30000,
  },
});
