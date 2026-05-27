/**
 * `DestructionFx` unit tests — plan M4 deliverable.
 *
 * Locks:
 *  - tier dial dispatches to the right code path
 *  - minimal tier falls back to buildExplosionGfx (the floor)
 *  - particle pool eviction at PARTICLE_POOL_CAP
 *  - shockwave filter attaches + detaches cleanly
 *  - resetForSectorHandoff wipes everything
 *
 * Uses minimal Pixi stubs — DestructionFx only touches Container.addChild/
 * removeChild and Application.stage.filters.
 */

import { describe, expect, it, vi } from 'vitest';
import { DestructionFx, type DestructionFactories } from './DestructionFx';

function makeStubGfx(): Record<string, unknown> {
  return {
    x: 0,
    y: 0,
    alpha: 1,
    rotation: 0,
    scale: { set: vi.fn() },
    destroy: vi.fn(),
  };
}

function makeStubFilter(): Record<string, unknown> {
  return { time: 0, amplitude: 0, center: { x: 0, y: 0 } };
}

function makeFactories(): DestructionFactories {
  return {
    makeParticleGfx: vi.fn(() => makeStubGfx() as never),
    makeFallbackGfx: vi.fn(() => makeStubGfx() as never),
    makeShockFilter: vi.fn(() => makeStubFilter() as never),
  };
}

function makeFakes(): {
  parent: { addChild: ReturnType<typeof vi.fn>; removeChild: ReturnType<typeof vi.fn>; children: unknown[] };
  app: { stage: { filters: unknown[] | null } };
} {
  const children: unknown[] = [];
  const parent = {
    addChild: vi.fn((c: unknown) => { children.push(c); return c; }),
    removeChild: vi.fn((c: unknown) => { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return c; }),
    children,
  };
  const app = { stage: { filters: [] as unknown[] | null } };
  return { parent, app };
}

describe('DestructionFx — tier dial', () => {
  it('at "high" spawns 40 particles + a shockwave filter', () => {
    const { parent, app } = makeFakes();
    const fx = new DestructionFx(parent as never, app as never, () => 'high', makeFactories());
    fx.spawnBurst(0, 0);
    const stats = fx.activeCount();
    expect(stats.bursts).toBe(40);
    expect(stats.filters).toBe(1);
    expect((app.stage.filters as unknown[]).length).toBe(1);
  });

  it('at "medium" spawns 20 particles + a shockwave filter', () => {
    const { parent, app } = makeFakes();
    const fx = new DestructionFx(parent as never, app as never, () => 'medium', makeFactories());
    fx.spawnBurst(100, 100);
    const stats = fx.activeCount();
    expect(stats.bursts).toBe(20);
    expect(stats.filters).toBe(1);
  });

  it('at "low" spawns 10 particles + NO shockwave filter', () => {
    const { parent, app } = makeFakes();
    const fx = new DestructionFx(parent as never, app as never, () => 'low', makeFactories());
    fx.spawnBurst(0, 0);
    const stats = fx.activeCount();
    expect(stats.bursts).toBe(10);
    expect(stats.filters).toBe(0);
  });

  it('at "minimal" falls back to buildExplosionGfx (1 fallback sprite, no filter)', () => {
    const { parent, app } = makeFakes();
    const fx = new DestructionFx(parent as never, app as never, () => 'minimal', makeFactories());
    fx.spawnBurst(0, 0);
    const stats = fx.activeCount();
    expect(stats.bursts).toBe(1);
    expect(stats.filters).toBe(0);
    expect((app.stage.filters as unknown[]).length).toBe(0);
  });
});

describe('DestructionFx — lifecycle + tick', () => {
  it('particles fade and are removed after lifetime expires', () => {
    const { parent, app } = makeFakes();
    const fx = new DestructionFx(parent as never, app as never, () => 'low', makeFactories()); // 10 particles, 0.7 s
    fx.spawnBurst(0, 0);
    expect(fx.activeCount().bursts).toBe(10);
    // Advance well past lifetime (0.7 s = 700 ms).
    for (let i = 0; i < 80; i++) fx.tick(0.016);
    expect(fx.activeCount().bursts).toBe(0);
  });

  it('shockwave filter detaches from app.stage.filters after its lifetime', () => {
    const { parent, app } = makeFakes();
    const fx = new DestructionFx(parent as never, app as never, () => 'high', makeFactories()); // shock 250 ms
    fx.spawnBurst(0, 0);
    expect((app.stage.filters as unknown[]).length).toBe(1);
    for (let i = 0; i < 30; i++) fx.tick(0.016); // ~480 ms
    expect((app.stage.filters as unknown[]).length).toBe(0);
    expect(fx.activeCount().filters).toBe(0);
  });

  it('fallback sprite (minimal tier) ticks via framesLeft and removes after 30 frames', () => {
    const { parent, app } = makeFakes();
    const fx = new DestructionFx(parent as never, app as never, () => 'minimal', makeFactories());
    fx.spawnBurst(0, 0);
    expect(fx.activeCount().bursts).toBe(1);
    for (let i = 0; i < 40; i++) fx.tick(0.016); // dtSec is ignored by the fallback (frame-counted)
    expect(fx.activeCount().bursts).toBe(0);
  });
});

describe('DestructionFx — pool cap eviction', () => {
  it('evicts oldest particles when active count exceeds PARTICLE_POOL_CAP (200)', () => {
    const { parent, app } = makeFakes();
    const fx = new DestructionFx(parent as never, app as never, () => 'high', makeFactories()); // 40 per burst
    // 6 bursts × 40 = 240 particles requested; cap = 200.
    for (let i = 0; i < 6; i++) fx.spawnBurst(i * 10, 0);
    expect(fx.activeCount().bursts).toBeLessThanOrEqual(200);
  });
});

describe('DestructionFx — resetForSectorHandoff', () => {
  it('wipes all active particles + shocks + fallbacks immediately', () => {
    const { parent, app } = makeFakes();
    const fx = new DestructionFx(parent as never, app as never, () => 'high', makeFactories());
    fx.spawnBurst(0, 0);
    fx.spawnBurst(100, 0);
    expect(fx.activeCount().bursts).toBeGreaterThan(0);
    expect(fx.activeCount().filters).toBeGreaterThan(0);
    fx.resetForSectorHandoff();
    expect(fx.activeCount().bursts).toBe(0);
    expect(fx.activeCount().filters).toBe(0);
    expect((app.stage.filters as unknown[]).length).toBe(0);
  });
});

describe('DestructionFx — intensity scaling', () => {
  it('intensity 0.5 halves the particle count', () => {
    const { parent, app } = makeFakes();
    const fx = new DestructionFx(parent as never, app as never, () => 'high', makeFactories()); // 40 default
    fx.spawnBurst(0, 0, { intensity: 0.5 });
    expect(fx.activeCount().bursts).toBe(20);
  });
});
