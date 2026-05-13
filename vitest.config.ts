import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vitest config — main (unit + component + scenario) suite.
 *
 * - `pnpm test`              -> this config (default `vitest.config.ts`)
 * - `pnpm test:integration`  -> `vitest.integration.config.ts` (Phase A1+)
 * - `pnpm bench`             -> benchmarks (.bench.ts)
 *
 * Integration tests live under `tests/integration/` and run in a separate
 * vitest invocation because they need a different pool configuration
 * (Colyseus's process-level handlers fight with isolated fork workers —
 * see vitest.integration.config.ts for the full incident report).
 *
 * Per-file environment selection via `environmentMatchGlobs`:
 *   - `*.test.tsx` ⇒ jsdom (component tests need a DOM)
 *   - everything else ⇒ node (server logic, schemas, helpers — fastest)
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@shared-types': path.resolve(__dirname, 'src/shared-types'),
    },
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['src/**/*.test.tsx', 'jsdom'],
    ],
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/unit/**/*.test.ts',
      // Stage 4.5 — scenario-harness regression fixtures (network-feel roadmap).
      'tests/scenarios/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      'dist/**',
      'tests/e2e/**',
      'benchmarks/**',
      // Phase A1 — integration tests run via `pnpm test:integration`.
      'tests/integration/**',
    ],
    benchmark: {
      include: ['benchmarks/**/*.bench.ts'],
    },
  },
});
