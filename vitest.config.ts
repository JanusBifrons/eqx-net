import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vitest config.
 *
 * - `pnpm test`  -> unit + component tests (.test.ts / .test.tsx)
 * - `pnpm bench` -> benchmarks (.bench.ts)
 *
 * Per-file environment selection via `environmentMatchGlobs`:
 *   - `*.test.tsx` ⇒ jsdom (component tests need a DOM)
 *   - everything else ⇒ node (server logic, schemas, helpers — fastest)
 *
 * The `@vitejs/plugin-react` plugin is loaded so JSX in `.test.tsx`
 * is transformed correctly. Setup file registers `@testing-library/
 * jest-dom` matchers + the per-test cleanup, both gated to the jsdom
 * environment.
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
    exclude: ['**/node_modules/**', 'dist/**', 'tests/e2e/**', 'benchmarks/**'],
    benchmark: {
      include: ['benchmarks/**/*.bench.ts'],
    },
  },
});
