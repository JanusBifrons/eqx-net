/**
 * `EngineEmitter` unit tests — plan M5 deliverable.
 *
 * Locks:
 *  - setActive is re-entrant
 *  - tier dial gates thrust rate + boost-enabled flag
 *  - getPose null → no particles spawn
 *  - sector-handoff reset wipes emitters + particles
 *  - particle pool eviction at PARTICLE_POOL_CAP
 */

import { describe, expect, it, vi } from 'vitest';
import { EngineEmitter, type EngineFactories, type EnginePoseFn } from './EngineEmitter';

function makeStubGfx(): Record<string, unknown> {
  return { x: 0, y: 0, alpha: 1, scale: { set: vi.fn() }, destroy: vi.fn() };
}

function makeFactories(): EngineFactories {
  return { makeParticle: vi.fn(() => makeStubGfx() as never) };
}

function makeParent(): { addChild: ReturnType<typeof vi.fn>; removeChild: ReturnType<typeof vi.fn> } {
  const children: unknown[] = [];
  return {
    addChild: vi.fn((c: unknown) => { children.push(c); return c; }),
    removeChild: vi.fn((c: unknown) => { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return c; }),
  };
}

const POSE_AT_ORIGIN: EnginePoseFn = () => ({ x: 0, y: 0, angle: 0 });

describe('EngineEmitter — setActive re-entrancy', () => {
  it('register / unregister tracked by activeCount.emitters', () => {
    const e = new EngineEmitter(makeParent() as never, () => 'high', makeFactories());
    expect(e.activeCount().emitters).toBe(0);
    e.setActive('ship-1', 'thrust', true);
    expect(e.activeCount().emitters).toBe(1);
    e.setActive('ship-1', 'thrust', true); // re-entrant
    expect(e.activeCount().emitters).toBe(1);
    e.setActive('ship-1', 'thrust', false);
    expect(e.activeCount().emitters).toBe(0);
  });

  it('thrust and boost are independent keys for the same entity', () => {
    const e = new EngineEmitter(makeParent() as never, () => 'high', makeFactories());
    e.setActive('ship-1', 'thrust', true);
    e.setActive('ship-1', 'boost', true);
    expect(e.activeCount().emitters).toBe(2);
  });

  it("ignores 'shield' kind (handled by ShieldAura in M8)", () => {
    const e = new EngineEmitter(makeParent() as never, () => 'high', makeFactories());
    e.setActive('ship-1', 'shield', true);
    expect(e.activeCount().emitters).toBe(0);
  });
});

describe('EngineEmitter — tier dial', () => {
  it('emits particles at "high" for both thrust and boost', () => {
    const e = new EngineEmitter(makeParent() as never, () => 'high', makeFactories());
    e.setActive('s', 'thrust', true);
    e.setActive('s', 'boost', true);
    // 16 ms × ~10 ticks at 60 Hz emit rate ≈ ~10 particles per emitter.
    for (let i = 0; i < 10; i++) e.tick(0.016, POSE_AT_ORIGIN);
    expect(e.activeCount().particles).toBeGreaterThan(0);
  });

  it('drops boost emitter at "medium" (thrust still emits)', () => {
    const e = new EngineEmitter(makeParent() as never, () => 'medium', makeFactories());
    e.setActive('s', 'boost', true);
    for (let i = 0; i < 30; i++) e.tick(0.016, POSE_AT_ORIGIN);
    expect(e.activeCount().particles).toBe(0);
  });

  it('emits at half rate at "low"', () => {
    const high = new EngineEmitter(makeParent() as never, () => 'high', makeFactories());
    const low = new EngineEmitter(makeParent() as never, () => 'low', makeFactories());
    high.setActive('s', 'thrust', true);
    low.setActive('s', 'thrust', true);
    for (let i = 0; i < 30; i++) {
      high.tick(0.016, POSE_AT_ORIGIN);
      low.tick(0.016, POSE_AT_ORIGIN);
    }
    expect(low.activeCount().particles).toBeLessThan(high.activeCount().particles);
  });

  it('emits zero particles at "minimal" (legacy Graphics flames are the only visual)', () => {
    const e = new EngineEmitter(makeParent() as never, () => 'minimal', makeFactories());
    e.setActive('s', 'thrust', true);
    for (let i = 0; i < 30; i++) e.tick(0.016, POSE_AT_ORIGIN);
    expect(e.activeCount().particles).toBe(0);
  });
});

describe('EngineEmitter — spawn side (paired math lock for the mirror fix)', () => {
  it('spawns the particle ASTERN on the correct side for a diagonal heading', () => {
    // PAIRED with entityPoseFromSprite.test.ts (Invariant #13): the seam test
    // proves the renderer now hands a GAME-SPACE angle; this proves the
    // emitter places the particle astern (un-mirrored) GIVEN a game-space
    // angle. Together they cover the X-mirror smoke bug.
    const created: Record<string, unknown>[] = [];
    const factories: EngineFactories = {
      makeParticle: vi.fn(() => {
        const g = makeStubGfx();
        created.push(g);
        return g as never;
      }),
    };
    const e = new EngineEmitter(makeParent() as never, () => 'high', factories);
    e.setActive('s', 'thrust', true);
    // Game-space heading +π/4. Forward = (-sin, cos); astern = (sin, -cos),
    // i.e. +X and -Y in game space. With the pre-fix NEGATED angle this would
    // have spawned at -X (the mirror).
    const pose: EnginePoseFn = () => ({ x: 0, y: 0, angle: Math.PI / 4 });
    e.tick(0.05, pose);
    expect(created.length).toBeGreaterThan(0);
    const g = created[0]!;
    // gfx is Pixi-space: gfx.x = gameX, gfx.y = -gameY.
    const gameX = g.x as number;
    const gameY = -(g.y as number);
    expect(gameX).toBeGreaterThan(0); // astern is +X for +π/4 (NOT mirrored to -X)
    expect(gameY).toBeLessThan(0); // astern is -Y for +π/4
  });
});

describe('EngineEmitter — per-kind nozzle profile', () => {
  function collectFactories(into: Record<string, unknown>[]): EngineFactories {
    return {
      makeParticle: vi.fn(() => {
        const g = makeStubGfx();
        into.push(g);
        return g as never;
      }),
    };
  }

  it('spawns at the supplied per-kind sternOffset (not the legacy 25u)', () => {
    const created: Record<string, unknown>[] = [];
    const e = new EngineEmitter(makeParent() as never, () => 'high', collectFactories(created));
    // angle 0 → astern is straight "down" (gfx.y = +sternOffset). One frame of
    // post-emit drift (≤ |v|/60 ≈ 1.7 u, always astern → increases y) is the
    // only deviation, so gfx.y lands in [10, ~12) — unambiguously the ~10u
    // rear extent, NOT the legacy 25u (which would put it at ≥ 25).
    e.setActive('s', 'thrust', true, { sternOffset: 10, plumeScale: 1 });
    e.tick(1 / 60, () => ({ x: 0, y: 0, angle: 0 }));
    expect(created.length).toBeGreaterThan(0);
    const y = created[0]!.y as number;
    expect(y).toBeGreaterThanOrEqual(9.99);
    expect(y).toBeLessThan(13);
  });

  it('plumeScale widens the nozzle mouth proportionally', () => {
    // random=1 → perp = +nozzleWidth/2, and identical velocity for both runs
    // (velocity is plume-scale-independent), so the constant post-emit x-drift
    // cancels in the SUBTRACTION x2 - x1 = perpΔ = 0.5·thrustNozzleWidth·(2-1).
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      const spawnX = (plumeScale: number): number => {
        const created: Record<string, unknown>[] = [];
        const e = new EngineEmitter(makeParent() as never, () => 'high', collectFactories(created));
        e.setActive('s', 'thrust', true, { sternOffset: 10, plumeScale });
        e.tick(0.02, () => ({ x: 0, y: 0, angle: 0 }));
        return created[0]!.x as number;
      };
      const x1 = spawnX(1);
      const x2 = spawnX(2);
      expect(Math.abs(x2)).toBeGreaterThan(Math.abs(x1));
      expect(Math.abs(x2) - Math.abs(x1)).toBeCloseTo(5, 5); // 0.5 * thrustNozzleWidth(10)
    } finally {
      rnd.mockRestore();
    }
  });
});

describe('EngineEmitter — getPose null', () => {
  it('skips emission when getPose returns null (entity not in mirror)', () => {
    const e = new EngineEmitter(makeParent() as never, () => 'high', makeFactories());
    e.setActive('absent', 'thrust', true);
    for (let i = 0; i < 30; i++) e.tick(0.016, () => null);
    expect(e.activeCount().particles).toBe(0);
  });
});

describe('EngineEmitter — particles fade and pool-cap', () => {
  it('particles get removed after their lifetime expires', () => {
    const e = new EngineEmitter(makeParent() as never, () => 'high', makeFactories());
    e.setActive('s', 'thrust', true);
    for (let i = 0; i < 10; i++) e.tick(0.016, POSE_AT_ORIGIN);
    const before = e.activeCount().particles;
    expect(before).toBeGreaterThan(0);
    // Stop emitting + advance well past 350 ms lifetime.
    e.setActive('s', 'thrust', false);
    for (let i = 0; i < 100; i++) e.tick(0.016, POSE_AT_ORIGIN);
    expect(e.activeCount().particles).toBe(0);
  });

  it('respects PARTICLE_POOL_CAP (300) under sustained emission', () => {
    const e = new EngineEmitter(makeParent() as never, () => 'high', makeFactories());
    // Spawn 10 emitters all at 60 Hz with 0.5 s lifetime → steady ~300 in flight.
    for (let i = 0; i < 10; i++) e.setActive(`s${i}`, 'thrust', true);
    for (let i = 0; i < 200; i++) e.tick(0.016, POSE_AT_ORIGIN);
    expect(e.activeCount().particles).toBeLessThanOrEqual(300);
  });
});

describe('EngineEmitter — resetForSectorHandoff', () => {
  it('wipes all emitters + particles', () => {
    const e = new EngineEmitter(makeParent() as never, () => 'high', makeFactories());
    e.setActive('a', 'thrust', true);
    e.setActive('b', 'boost', true);
    for (let i = 0; i < 10; i++) e.tick(0.016, POSE_AT_ORIGIN);
    expect(e.activeCount().emitters).toBe(2);
    expect(e.activeCount().particles).toBeGreaterThan(0);
    e.resetForSectorHandoff();
    expect(e.activeCount().emitters).toBe(0);
    expect(e.activeCount().particles).toBe(0);
  });
});
