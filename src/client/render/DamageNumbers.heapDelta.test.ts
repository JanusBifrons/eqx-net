/**
 * Heap-delta lock for `DamageNumberManager` — proves the per-target
 * accumulator (plan: melodic-engelbart Step 4, 2026-05-30) actually
 * eliminates the per-hit `new Text({...})` allocation cost it was built
 * for.
 *
 * Pre-accumulator: every `spawn(x, y, damage)` called `new Text(...)`
 * (capped at POOL_CAP=20 with FIFO eviction, evicting old + destroying
 * old + allocating new on each spawn past the cap). Under sustained
 * beam fire at ~30 Hz (smooth-beam splitter retune 2026-05-22) this
 * was a top non-FX allocator surfaced by the imperative-taco hostile
 * CDP profile.
 *
 * Post-accumulator: hits on the same `targetId` ACCUMULATE into the
 * existing bucket — no new Text. Only a brand-new targetId opens a
 * new bucket.
 *
 * The two locks below:
 *
 *   1. Construction counter — spy on the Pixi Text constructor (via
 *      the inner-container child count) to prove that 1000 hits on
 *      ONE target produce EXACTLY 1 Text instance. Pre-accumulator
 *      this would have created + destroyed ~980 Texts (POOL_CAP=20
 *      circular eviction).
 *
 *   2. Heap-growth measurement — run a sustained spawn workload and
 *      assert post-GC heap stays bounded. Mirror the
 *      `EngineEmitter.heapDelta.test.ts` recipe.
 *
 * Workload: 10 000 spawn calls distributed across 5 targetIds with
 * occasional `update()` ticks to drive the lifetime + counter-scale
 * code paths. Without the accumulator each call would alloc a Text;
 * with it, ≤ 5 Texts exist at any time.
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect } from 'vitest';
import { Container, Text } from 'pixi.js';
import { DamageNumberManager } from './DamageNumbers.js';
import type { Camera } from './worker/Camera.js';

function requireGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error('global.gc not available — run via `pnpm test:gc`.');
  }
  return gc;
}

function postGcHeap(): number {
  const gc = requireGc();
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

function makeMockCamera(initialScale = 1): Camera {
  const cam = {
    scale: { x: initialScale, y: initialScale } as { x: number; y: number },
  };
  return cam as unknown as Camera;
}

function innerContainer(parent: Container): Container {
  return parent.children[0] as Container;
}

describe('DamageNumberManager heap-delta — per-target accumulator avoids per-hit Text construction', () => {
  it('1000 hits on ONE target produce exactly 1 Text instance (no per-spawn alloc)', () => {
    const parent = new Container();
    const camera = makeMockCamera(1);
    const mgr = new DamageNumberManager(parent, camera);
    const inner = innerContainer(parent);

    // Sustained-fire-on-one-target workload — no update() between
    // spawns so the stay-window never expires, the bucket is reused
    // for every hit.
    for (let i = 0; i < 1000; i++) {
      mgr.spawn('drone-1', i % 100, 0, 1);
    }

    // EXACTLY one Pixi Text under the container — all 1000 hits
    // accumulated into one bucket. Pre-accumulator this would have
    // been POOL_CAP=20 Texts with ~980 created+destroyed cycles
    // (every spawn past the cap evicts oldest + destroys + allocates
    // new).
    expect(inner.children.length).toBe(1);
    expect((inner.children[0] as Text).text).toBe('-1000');
    expect(mgr.getActiveCount()).toBe(1);
  });

  it('10 000 hits across 5 targets produce exactly 5 Text instances (one per target)', () => {
    const parent = new Container();
    const camera = makeMockCamera(1);
    const mgr = new DamageNumberManager(parent, camera);
    const inner = innerContainer(parent);

    for (let i = 0; i < 10_000; i++) {
      mgr.spawn(`drone-${i % 5}`, 0, 0, 1);
    }

    expect(inner.children.length).toBe(5);
    expect(mgr.getActiveCount()).toBe(5);
    // Each of 5 buckets accumulated 2000 hits × 1 damage = 2000.
    for (let i = 0; i < 5; i++) {
      expect((inner.children[i] as Text).text).toBe('-2000');
    }
  });

  it('mixed accumulate + tick + expire workload — Text count tracks active-target count, never spawn count', () => {
    const parent = new Container();
    const camera = makeMockCamera(1);
    const mgr = new DamageNumberManager(parent, camera);
    const inner = innerContainer(parent);

    // Interleave spawns + occasional ticks. The total spawn count
    // is 5000 but at any moment there should be ≤ POOL_CAP buckets.
    for (let i = 0; i < 5000; i++) {
      mgr.spawn(`drone-${i % 8}`, 0, 0, 1);
      if (i % 50 === 49) mgr.update();
    }

    // 8 distinct targetIds were used, so at most 8 buckets — well
    // under POOL_CAP. The 5000 spawns themselves did not multiply
    // the Text count.
    expect(inner.children.length).toBeLessThanOrEqual(8);
    expect(mgr.getActiveCount()).toBeLessThanOrEqual(8);
  });

  it('heap growth bounded under sustained-fire workload (post-warmup)', () => {
    const parent = new Container();
    const camera = makeMockCamera(1);
    const mgr = new DamageNumberManager(parent, camera);

    // Warmup — JIT + initial bucket allocation. 5 targets, 200
    // spawns each.
    for (let i = 0; i < 1000; i++) {
      mgr.spawn(`drone-${i % 5}`, 0, 0, 1);
    }

    const before = postGcHeap();
    // Steady state — 10 000 more spawns across the same 5 targets.
    // Each spawn should mutate an existing bucket (no Text alloc, no
    // Map alloc — `pendingByTag` stays unallocated for untagged
    // calls). The only allocation we expect is the integer arithmetic
    // + the string assignment to `.text` (V8 small-string interning
    // makes that effectively free for short strings).
    for (let i = 0; i < 10_000; i++) {
      mgr.spawn(`drone-${i % 5}`, 0, 0, 1);
    }
    const after = postGcHeap();

    const growthBytes = after - before;
    // Budget: 200 KB across 10 000 spawns = 20 bytes/spawn. The
    // unpooled pre-accumulator path allocated a Text + a
    // DamageNumberEntry object every spawn past the cap; even with
    // V8 interning that's > 200 bytes per Text → 2 MB+ for 10 000
    // spawns. The accumulator path mutates in place, so observed
    // growth should be dominated by V8 housekeeping noise (well
    // under 200 KB).
    expect(growthBytes).toBeLessThan(200_000);
  });

  it('worst-case rollback storm — every-shot-mispredicts workload — heap turnover bounded by Pixi Text cost', () => {
    const parent = new Container();
    const camera = makeMockCamera(1);
    const mgr = new DamageNumberManager(parent, camera);

    // 5000 predicted hits where every shot is rolled back immediately
    // — the worst-case mispredict storm. The accumulator design does
    // NOT optimise this scenario (the bucket gets destroyed each
    // cycle so the next spawn re-allocates Text + Map + entry); it
    // optimises the COMMON case where predictions confirm and
    // accumulate. This test measures the pathological worst case so
    // we have an upper bound to detect regressions.
    const before = postGcHeap();
    for (let i = 0; i < 5000; i++) {
      const tag = `shot-${i}`;
      mgr.spawn(`drone-${i % 3}`, 0, 0, 10, tag);
      mgr.cancelByTag(tag);
    }
    const after = postGcHeap();

    // Realistic budget: ~7 MB for 5000 spawn+cancel cycles. The
    // dominant cost is `new Text(...)` per cycle (~700–1500 bytes
    // each, depending on V8 string interning + Pixi internal mesh
    // buffers). Pre-accumulator the same workload would still alloc
    // a Text per spawn (different code path, same per-hit alloc); the
    // accumulator does not improve this case but does not regress
    // it either.
    //
    // Future improvement: a Text free-list pool would let this case
    // approach the steady-state numbers in the previous tests, but
    // that is a separate refactor — and given this scenario is rare
    // in production (predictions usually CONFIRM), the bigger win
    // already shipped is the common-case accumulator.
    const growthBytes = after - before;
    expect(growthBytes).toBeLessThan(10_000_000);
  });
});
