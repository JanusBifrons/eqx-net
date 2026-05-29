/**
 * Heap-delta lock for `DestructionFx` — proves destruction particle
 * Graphics + the per-particle entry record are POOLED across spawn / die
 * cycles.
 *
 * Pre-pool behaviour: every `spawnBurst` allocates `count` fresh
 * `Graphics` via `factories.makeParticleGfx(tint)` AND `count` fresh
 * `{gfx, vx, vy, lifeS, initialLifeS, tint}` object literals. At
 * `high` quality that's 40 per kill; in combat sessions where the
 * player chains kills (galaxy sectors with hostile drones) the
 * spawn/destroy bursts dominate the major-GC trigger pattern that
 * showed up as the rafGap 1 → 15 regression vs main.
 *
 * The fix mirrors `EngineEmitter` + `ImpactSparks`: tint-keyed
 * Graphics free-pool + entry record pool. Once the system has cycled
 * enough burst/die pairs to populate the pool, further bursts must
 * allocate nothing.
 *
 * Workload: spawn a destruction burst, tick until all particles die
 * (~1.2 s lifetime = ~72 ticks at 1/60), repeat for many cycles. Stub
 * Graphics factory counts its calls; post-warmup the call rate should
 * be ~0.
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect, vi } from 'vitest';
import { DestructionFx, type DestructionFactories } from './DestructionFx';

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
  return { x: 0, y: 0, alpha: 1, rotation: 0, scale: { set: () => {} }, destroy: () => {} };
}

function makeStubFilter(): Record<string, unknown> {
  return { time: 0, amplitude: 0, center: { x: 0, y: 0 } };
}

function makeParent(): { addChild: () => unknown; removeChild: () => unknown } {
  return { addChild: () => undefined, removeChild: () => undefined };
}

function makeApp(): { stage: { filters: unknown[] | null } } {
  return { stage: { filters: [] as unknown[] | null } };
}

describe('DestructionFx heap-delta — particles pooled across burst/die cycles (plan: lazy-mochi)', () => {
  it('factory.makeParticleGfx stops being called after pool fills', () => {
    const makeParticleGfx = vi.fn(() => makeStubGfx() as never);
    const factories: DestructionFactories = {
      makeParticleGfx,
      makeFallbackGfx: vi.fn(() => makeStubGfx() as never),
      makeShockFilter: vi.fn(() => makeStubFilter() as never),
    };
    const fx = new DestructionFx(makeParent() as never, makeApp() as never, () => 'high', factories);

    // Warmup: spawn 3 bursts (40 particles each = 120 particles); tick
    // long enough for all to die (lifetimeMs = 1200 = 72 ticks at 1/60).
    for (let burst = 0; burst < 3; burst++) {
      fx.spawnBurst(0, 0, { tint: 0xff9944 });
      for (let i = 0; i < 80; i++) fx.tick(1 / 60);
    }
    const callsAfterWarmup = makeParticleGfx.mock.calls.length;
    expect(callsAfterWarmup, 'warmup should have spawned particles').toBeGreaterThan(0);

    // Steady state: 50 more burst/die cycles must reuse pooled
    // Graphics. With the pool in place we expect ZERO additional
    // makeParticleGfx calls — every spawn pops a free Graphics, every
    // death pushes one back.
    for (let burst = 0; burst < 50; burst++) {
      fx.spawnBurst(0, 0, { tint: 0xff9944 });
      for (let i = 0; i < 80; i++) fx.tick(1 / 60);
    }
    const callsAfterSteady = makeParticleGfx.mock.calls.length;
    const newAllocsInSteadyState = callsAfterSteady - callsAfterWarmup;

    // Allow a small handful of topup allocations during the transition
    // into steady-state, but nothing close to the 2000 particles the
    // unpooled path would allocate over 50 bursts × 40 particles.
    expect(newAllocsInSteadyState).toBeLessThan(10);
  });

  it('factory.makeParticleGfx stops being called across multiple tints', () => {
    // Different ship kinds give different tint colours; the pool must
    // be tint-keyed so kills of different ship kinds don't forever
    // re-allocate.
    const makeParticleGfx = vi.fn(() => makeStubGfx() as never);
    const factories: DestructionFactories = {
      makeParticleGfx,
      makeFallbackGfx: vi.fn(() => makeStubGfx() as never),
      makeShockFilter: vi.fn(() => makeStubFilter() as never),
    };
    const fx = new DestructionFx(makeParent() as never, makeApp() as never, () => 'high', factories);

    // Warmup: alternate tints.
    for (let burst = 0; burst < 4; burst++) {
      const tint = burst % 2 === 0 ? 0xff9944 : 0x44ccff;
      fx.spawnBurst(0, 0, { tint });
      for (let i = 0; i < 80; i++) fx.tick(1 / 60);
    }
    const callsAfterWarmup = makeParticleGfx.mock.calls.length;

    // Steady state across alternating tints.
    for (let burst = 0; burst < 50; burst++) {
      const tint = burst % 2 === 0 ? 0xff9944 : 0x44ccff;
      fx.spawnBurst(0, 0, { tint });
      for (let i = 0; i < 80; i++) fx.tick(1 / 60);
    }
    const callsAfterSteady = makeParticleGfx.mock.calls.length;
    const newAllocsInSteadyState = callsAfterSteady - callsAfterWarmup;

    expect(newAllocsInSteadyState).toBeLessThan(10);
  });

  it('heap growth is bounded under 50 burst/die cycles post-warmup', () => {
    const factories: DestructionFactories = {
      makeParticleGfx: () => makeStubGfx() as never,
      makeFallbackGfx: () => makeStubGfx() as never,
      makeShockFilter: () => makeStubFilter() as never,
    };
    const fx = new DestructionFx(makeParent() as never, makeApp() as never, () => 'high', factories);

    // Warmup: prime pools + JIT.
    for (let burst = 0; burst < 5; burst++) {
      fx.spawnBurst(0, 0, { tint: 0xff9944 });
      for (let i = 0; i < 80; i++) fx.tick(1 / 60);
    }

    const before = postGcHeap();
    for (let burst = 0; burst < 50; burst++) {
      fx.spawnBurst(0, 0, { tint: 0xff9944 });
      for (let i = 0; i < 80; i++) fx.tick(1 / 60);
    }
    const after = postGcHeap();

    const growthBytes = after - before;
    // 100 KB tolerance. The unpooled path allocates 40 Graphics + 40
    // entry literals per burst × 50 bursts = 4000 objects. Even with
    // stub Graphics, the per-cycle entry literal alone is ~96 bytes
    // (6 fields) × 2000 = ~192 KB, well over the budget.
    expect(growthBytes).toBeLessThan(100_000);
  });
});
