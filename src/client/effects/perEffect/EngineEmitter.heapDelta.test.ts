/**
 * Heap-delta lock for `EngineEmitter` — proves particle Graphics + the
 * per-particle entry record are POOLED across emit / die cycles.
 *
 * Pre-pool behaviour (before the 2026-05-28 follow-up to capture
 * 8y3njt): every emit allocated a fresh `Graphics` via
 * `factories.makeParticle(tint)` AND a fresh `{gfx, vx, vy, lifeS,
 * initialLifeS}` object literal at `EngineEmitter.ts:188`. At
 * 60 Hz (thrust) + 90 Hz (boost) per ship, this dominated the
 * client allocation rate on mobile (heap climbed ~2.2 MB/s under
 * continuous thrust; capture 8y3njt's ~40 s smoke session ended in a
 * disconnect after a 4-event raf_gap cluster).
 *
 * The fix: tint-keyed Graphics free-pool + entry record pool. Once
 * the system has "warmed up" (enough emit cycles to populate the
 * pool), further emit / die cycles must allocate nothing.
 *
 * Workload: register a thrust emitter + a boost emitter, tick for
 * thousands of cycles. Pose function returns the same pose every
 * time (no per-frame anchor alloc). Stub Graphics factory counts its
 * calls; post-warmup the call rate should be ~0.
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect, vi } from 'vitest';
import { EngineEmitter, type EngineFactories, type EnginePoseFn } from './EngineEmitter';

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

const POSE: EnginePoseFn = () => ({ x: 0, y: 0, angle: 0 });

describe('EngineEmitter heap-delta — particles pooled across emit/die cycles (capture 8y3njt)', () => {
  it('factory.makeParticle stops being called after pool fills', () => {
    const makeParticle = vi.fn(() => makeStubGfx() as never);
    const factories: EngineFactories = { makeParticle };
    const e = new EngineEmitter(makeParent() as never, () => 'high', factories);
    e.setActive('ship-1', 'thrust', true);

    // Warmup: long enough at 60 Hz × dt=1/60 to spawn AND let particles
    // die (thrust lifetime is 0.35 s = ~21 ticks). 200 ticks ⇒ pool
    // saturated, particles cycle through.
    for (let i = 0; i < 200; i++) e.tick(1 / 60, POSE);
    const callsAfterWarmup = makeParticle.mock.calls.length;
    // Sanity: warmup actually spawned particles.
    expect(callsAfterWarmup).toBeGreaterThan(0);

    // Steady state: 2000 more ticks should reuse pooled Graphics. With
    // the pool in place we expect ZERO new makeParticle calls — once
    // the pool reaches the steady-state size, every emit pops a free
    // Graphics and every death pushes one back.
    for (let i = 0; i < 2000; i++) e.tick(1 / 60, POSE);
    const callsAfterSteady = makeParticle.mock.calls.length;
    const newAllocsInSteadyState = callsAfterSteady - callsAfterWarmup;

    // Allow a few "topup" allocations during the transition into
    // steady-state, but nothing close to the ~120 particles/sec the
    // unpooled path would allocate over 33 s of simulated ticks.
    expect(newAllocsInSteadyState).toBeLessThan(5);
  });

  it('heap growth is bounded under 3000 emit cycles post-warmup', () => {
    const factories: EngineFactories = { makeParticle: () => makeStubGfx() as never };
    const e = new EngineEmitter(makeParent() as never, () => 'high', factories);
    e.setActive('ship-1', 'thrust', true);
    e.setActive('ship-1', 'boost', true);

    // Warmup: prime pools + JIT.
    for (let i = 0; i < 500; i++) e.tick(1 / 60, POSE);

    const before = postGcHeap();
    for (let i = 0; i < 3000; i++) e.tick(1 / 60, POSE);
    const after = postGcHeap();

    const growthBytes = after - before;
    // 100 KB tolerance across 3000 cycles = ~33 bytes/cycle. The
    // unpooled path allocates a Graphics + an entry object every cycle
    // — even with stub Graphics, the per-cycle entry literal alone is
    // ~80 bytes × 3000 = 240 KB, well over the budget.
    expect(growthBytes).toBeLessThan(100_000);
  });
});
