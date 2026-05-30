/**
 * Heap-delta lock for `ImpactSparks` — proves spark particle Graphics +
 * the per-particle entry record are POOLED across spawn / die cycles.
 *
 * Pre-pool behaviour: every `spawnBurst` allocates `count` fresh
 * `Graphics` via `factories.makeSpark(tint)` AND `count` fresh
 * `{gfx, vx, vy, lifeS, initialLifeS}` object literals. At `high`
 * quality that's 24 per hit; in combat sessions where the user hits
 * every cooldown (~6 hits/s at 167 ms hitscan cd), that's ~144
 * Graphics/sec, dominating client allocation alongside the
 * EngineEmitter pre-pool baseline (capture 8y3njt).
 *
 * The fix mirrors `EngineEmitter`: tint-keyed Graphics free-pool +
 * entry record pool. Once the system has cycled enough spawn/die
 * pairs to populate the pool, further bursts must allocate nothing.
 *
 * Workload: spawn a hit-burst, tick until all particles die, repeat
 * for thousands of cycles. Stub Graphics factory counts its calls;
 * post-warmup the call rate should be ~0.
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect, vi } from 'vitest';
import { ImpactSparks, type ImpactFactories } from './ImpactSparks';

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

function makeStubGfx(): Record<string, unknown> {
  return { x: 0, y: 0, alpha: 1, scale: { set: () => {} }, destroy: () => {} };
}

function makeParent(): { addChild: () => unknown; removeChild: () => unknown } {
  return { addChild: () => undefined, removeChild: () => undefined };
}

describe('ImpactSparks heap-delta — sparks pooled across burst/die cycles (plan: lazy-mochi)', () => {
  it('factory.makeSpark stops being called after pool fills', () => {
    const makeSpark = vi.fn(() => makeStubGfx() as never);
    const factories: ImpactFactories = { makeSpark };
    const sparks = new ImpactSparks(makeParent() as never, () => 'high', factories);

    // Warmup: spawn 5 bursts (24 sparks each = 120 particles); tick long
    // enough for all to die (DEFAULT_LIFETIME_S = 0.32 s = ~20 ticks at
    // 1/60). Pool saturates at the steady-state size.
    for (let burst = 0; burst < 5; burst++) {
      sparks.spawnBurst(0, 0, { tint: 0xff8844 });
      for (let i = 0; i < 25; i++) sparks.tick(1 / 60);
    }
    const callsAfterWarmup = makeSpark.mock.calls.length;
    expect(callsAfterWarmup, 'warmup should have spawned sparks').toBeGreaterThan(0);

    // Steady state: 100 more burst/die cycles must reuse pooled Graphics.
    // With the pool in place we expect ZERO additional makeSpark calls
    // — every spawn pops a free Graphics, every death pushes one back.
    for (let burst = 0; burst < 100; burst++) {
      sparks.spawnBurst(0, 0, { tint: 0xff8844 });
      for (let i = 0; i < 25; i++) sparks.tick(1 / 60);
    }
    const callsAfterSteady = makeSpark.mock.calls.length;
    const newAllocsInSteadyState = callsAfterSteady - callsAfterWarmup;

    // Allow a small handful of topup allocations during the transition
    // into steady-state, but nothing close to the 2400 sparks the
    // unpooled path would allocate over 100 bursts × 24 sparks.
    expect(newAllocsInSteadyState).toBeLessThan(10);
  });

  it('factory.makeSpark stops being called across multiple tints', () => {
    // ImpactSparks gets two tints in practice: shield-hit cyan + hull-hit
    // orange. The pool must be tint-keyed so both can saturate without
    // forever re-allocating when tint alternates.
    const makeSpark = vi.fn(() => makeStubGfx() as never);
    const factories: ImpactFactories = { makeSpark };
    const sparks = new ImpactSparks(makeParent() as never, () => 'high', factories);

    // Warmup: alternate tints across 10 bursts.
    for (let burst = 0; burst < 10; burst++) {
      const tint = burst % 2 === 0 ? 0x00eeff : 0xff8844;
      sparks.spawnBurst(0, 0, { tint });
      for (let i = 0; i < 25; i++) sparks.tick(1 / 60);
    }
    const callsAfterWarmup = makeSpark.mock.calls.length;

    // Steady state across alternating tints.
    for (let burst = 0; burst < 100; burst++) {
      const tint = burst % 2 === 0 ? 0x00eeff : 0xff8844;
      sparks.spawnBurst(0, 0, { tint });
      for (let i = 0; i < 25; i++) sparks.tick(1 / 60);
    }
    const callsAfterSteady = makeSpark.mock.calls.length;
    const newAllocsInSteadyState = callsAfterSteady - callsAfterWarmup;

    expect(newAllocsInSteadyState).toBeLessThan(10);
  });

  it('heap growth is bounded under 100 burst/die cycles post-warmup', () => {
    const factories: ImpactFactories = { makeSpark: () => makeStubGfx() as never };
    const sparks = new ImpactSparks(makeParent() as never, () => 'high', factories);

    // Warmup: prime pools + JIT.
    for (let burst = 0; burst < 10; burst++) {
      sparks.spawnBurst(0, 0, { tint: 0xff8844 });
      for (let i = 0; i < 25; i++) sparks.tick(1 / 60);
    }

    const before = postGcHeap();
    for (let burst = 0; burst < 100; burst++) {
      sparks.spawnBurst(0, 0, { tint: 0xff8844 });
      for (let i = 0; i < 25; i++) sparks.tick(1 / 60);
    }
    const after = postGcHeap();

    const growthBytes = after - before;
    // 100 KB tolerance. The unpooled path allocates 24 Graphics + 24
    // entry literals per burst × 100 bursts = 4800 objects. Even with
    // stub Graphics, the per-cycle entry literal alone is ~80 bytes ×
    // 2400 = ~190 KB, well over the budget.
    expect(growthBytes).toBeLessThan(100_000);
  });
});
