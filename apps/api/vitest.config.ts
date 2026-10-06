import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Com TEST_PG=1 sobe um PostgreSQL real descartável antes dos testes (ver test/pg-global-setup.ts).
    globalSetup: process.env.TEST_PG === '1' ? ['./test/pg-global-setup.ts'] : [],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
