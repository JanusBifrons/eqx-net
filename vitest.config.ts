import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Phase 0: minimal vitest config.
 * `pnpm test`  -> unit tests (.test.ts)
 * `pnpm bench` -> benchmarks (.bench.ts)
 */
export default defineConfig({
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@shared-types': path.resolve(__dirname, 'src/shared-types'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**', 'tests/e2e/**', 'benchmarks/**'],
    benchmark: {
      include: ['benchmarks/**/*.bench.ts'],
    },
  },
});
