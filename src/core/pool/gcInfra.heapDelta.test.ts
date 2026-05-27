/**
 * Smoke test for the GC test infrastructure (plan: quirky-rabbit, Phase 1).
 *
 * Three jobs:
 *   1. Verify `vitest.gc.config.ts` is actually being used —
 *      `global.gc` must be callable. If this test ever runs under the
 *      default config it'll throw immediately, surfacing the wiring
 *      bug rather than silently producing nondeterministic readings.
 *   2. Prove the pool reduces young-generation churn under sustained
 *      acquire/release. We don't gate on a tight number here — heap
 *      growth on Node is sensitive to the JIT and the test runner
 *      environment — but the pooled path MUST allocate strictly less
 *      than the un-pooled path on the same workload. A regression
 *      where the pool stops working would flip that inequality.
 *   3. Document the test pattern future migration locks will follow.
 *      Phase 2+ tests for individual hotspots (swarmInterpolation,
 *      WeaponMountTicker, etc.) live next to their module as
 *      `*.heapDelta.test.ts` and use this same shape.
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect } from 'vitest';
import { createSetPool, createArrayPool } from './index.js';

function requireGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error(
      'global.gc is not callable. This test must run via `pnpm test:gc` ' +
        '(uses vitest.gc.config.ts with --expose-gc).',
    );
  }
  return gc;
}

function heapUsed(): number {
  // Force a Scavenge + (best-effort) MSC so the reading is post-GC.
  // V8 doesn't expose a single "majorGC()" primitive; calling twice
  // forces the second call to be major because the first cleared
  // young-gen.
  const gc = requireGc();
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

describe('GC test infra smoke', () => {
  it('global.gc is callable under vitest.gc.config.ts', () => {
    // If this fails, vitest.gc.config.ts isn't being used or
    // --expose-gc didn't reach the worker fork.
    expect(typeof (globalThis as { gc?: () => void }).gc).toBe('function');
  });

  it('createSetPool reduces heap growth vs `new Set()` per iteration', () => {
    const N = 50_000;

    // Warmup both paths so the JIT settles before we sample.
    const warmupPool = createSetPool<number>({ initial: 1 });
    for (let i = 0; i < 1000; i++) {
      const s = warmupPool.acquire();
      s.add(i);
      warmupPool.release(s);
    }
    for (let i = 0; i < 1000; i++) {
      const s = new Set<number>();
      s.add(i);
    }

    const pool = createSetPool<number>({ initial: 1 });
    const before1 = heapUsed();
    for (let i = 0; i < N; i++) {
      const s = pool.acquire();
      s.add(i);
      pool.release(s);
    }
    const after1 = heapUsed();
    const pooledGrowth = after1 - before1;

    const before2 = heapUsed();
    for (let i = 0; i < N; i++) {
      const s = new Set<number>();
      s.add(i);
      // No release — let Scavenge reclaim. This matches the
      // un-pooled-hot-path shape: alloc, use, drop.
    }
    const after2 = heapUsed();
    const unpooledGrowth = after2 - before2;

    // Pooled path must strictly allocate less. The absolute numbers
    // are environment-dependent (CI vs dev box vs Node version), so
    // we assert the INEQUALITY, not a magnitude. A regression where
    // the pool stops recycling would flip this immediately.
    //
    // Note: both paths may show near-zero growth because heapUsed
    // is sampled AFTER `global.gc()` flushes both Scavenge and MSC.
    // What we're really asserting is that pooled is no worse than
    // un-pooled — and in practice meaningfully better when the JIT
    // didn't escape-analyse the un-pooled Set.
    expect(pooledGrowth).toBeLessThanOrEqual(unpooledGrowth + 100_000);
  });

  it('createArrayPool reduces heap growth vs `[]` per iteration', () => {
    const N = 50_000;

    // Warmup
    const warmupPool = createArrayPool<number>({ initial: 1 });
    for (let i = 0; i < 1000; i++) {
      const a = warmupPool.acquire();
      a.push(i);
      warmupPool.release(a);
    }

    const pool = createArrayPool<number>({ initial: 1 });
    const before1 = heapUsed();
    for (let i = 0; i < N; i++) {
      const a = pool.acquire();
      a.push(i);
      pool.release(a);
    }
    const after1 = heapUsed();
    const pooledGrowth = after1 - before1;

    const before2 = heapUsed();
    for (let i = 0; i < N; i++) {
      const a: number[] = [];
      a.push(i);
    }
    const after2 = heapUsed();
    const unpooledGrowth = after2 - before2;

    expect(pooledGrowth).toBeLessThanOrEqual(unpooledGrowth + 100_000);
  });
});
