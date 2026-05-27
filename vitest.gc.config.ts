import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest config — GC / heap-delta tests (plan: quirky-rabbit, Phase 1).
 *
 * `process.memoryUsage().heapUsed` is non-deterministic without
 * `global.gc()` between samples — V8 may interleave a Scavenge or a
 * MSC between the snapshots and the delta is meaningless. To make
 * heap-delta tests deterministic we need TWO things the default
 * vitest config does not provide:
 *
 *   1. `--expose-gc` so `global.gc()` is callable. We pass it via
 *      `poolOptions.forks.execArgv`; the `forks` pool is the only one
 *      where execArgv reliably reaches the worker process.
 *   2. Serial execution. Module-scope scratch in pooled modules
 *      (Phase 2+ migrations) means two heap-delta tests running in
 *      parallel would share the same pool and the deltas would
 *      conflate. `sequence.concurrent: false` plus a single fork
 *      enforces strict serial.
 *
 * Run with `pnpm test:gc`. Matches `**\/*.heapDelta.test.ts`; the
 * default config excludes those files so they don't run twice.
 *
 * Inside a heap-delta test:
 *
 *   ```ts
 *   import { describe, it, expect } from 'vitest';
 *
 *   describe('foo', () => {
 *     it('does not grow heap under N iterations', () => {
 *       if (typeof global.gc !== 'function') {
 *         throw new Error('--expose-gc not set; run via pnpm test:gc');
 *       }
 *       global.gc!();
 *       const before = process.memoryUsage().heapUsed;
 *       for (let i = 0; i < 10_000; i++) doWork();
 *       global.gc!();
 *       const after = process.memoryUsage().heapUsed;
 *       expect(after - before).toBeLessThan(50_000);
 *     });
 *   });
 *   ```
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
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--expose-gc'],
        // One fork at a time — module-scope scratch in pooled modules
        // must not be shared across concurrent test workers.
        singleFork: true,
      },
    },
    sequence: {
      concurrent: false,
    },
    include: ['src/**/*.heapDelta.test.ts', 'tests/**/*.heapDelta.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**', '**/.claude/**'],
  },
});
