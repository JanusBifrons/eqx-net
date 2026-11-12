/**
 * Bolts and missiles move by the WORKER ticks that passed, not by room updates
 * (owner decision 2026-11-12, "game fix, small").
 *
 * Found by the quarantined `missile-frigate-homing` E2E (2026-11-12): on a
 * loaded host the E2E server's room loop fell to ~25 Hz while the physics
 * worker kept 60 Hz, so heat-seekers flew ~150-180 u/s instead of 400 and
 * never reached a target 1,000 u away in time. Each room `update()` moved a
 * missile or bolt ONE 1/60 s step however many worker ticks had passed, so
 * under load they slowed down relative to the ships. Naval shells already
 * follow the worker tick (shells as events, slice 1).
 *
 * Rule: a record steps `max(1, ticks since its last step)` per update (capped
 * at a hard stall), so a slow room catches up and a room that keeps pace with
 * the worker behaves exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { ProjectilePipeline, type ProjectileRecord } from './ProjectilePipeline.js';
import { MissileSimulation } from './MissileSimulation.js';
import { Bus } from '../../core/events/Bus.js';
import { getWeapon, type MissileWeaponDef, type WeaponId } from '../../core/combat/WeaponCatalogue.js';

const STEP = 600 / 60; // a 600 u/s bolt moves 10 u per worker tick

function pipeline(clock: { tick: number }): ProjectilePipeline {
  return new ProjectilePipeline({
    sabF32: new Float32Array(8192),
    serverTick: () => clock.tick,
    playerToSlot: [],
    getActiveShip: () => undefined,
    shipPoseCache: new Map(),
    playerSweep: () => null,
    swarmRegistry: { all: () => [] },
    lingeringSlots: new Map(),
    applyDamage: () => {},
  });
}

const only = (p: ProjectilePipeline): ProjectileRecord => p.liveProjectiles.values().next().value!;

describe('ProjectilePipeline — a bolt moves by elapsed worker ticks', () => {
  it('catches up after a slow room update, and keeps one step per update otherwise', () => {
    const clock = { tick: 500 };
    const p = pipeline(clock);
    p.spawn('gun', 0, 0, 600, 0, 10, 2, 600, 'laser' as WeaponId);
    p.advance(); // tick 500: the first step
    expect(only(p).x).toBeCloseTo(STEP, 6);
    clock.tick = 503; // the room missed two worker ticks
    p.advance();
    expect(only(p).x, 'three worker ticks passed: three steps').toBeCloseTo(4 * STEP, 6);
    p.advance(); // same worker tick again: one step, as before
    expect(only(p).x).toBeCloseTo(5 * STEP, 6);
  });
});

describe('MissileSimulation — a missile moves by elapsed worker ticks', () => {
  it('catches up after a slow room update', () => {
    const clock = { tick: 100 };
    const sim = new MissileSimulation({
      sabF32: new Float32Array(1024),
      serverTick: () => clock.tick,
      playerToSlot: [],
      getActiveShip: () => undefined,
      shipPoseCache: new Map(),
      lingeringSlots: new Map(),
      lingeringPoseCache: new Map(),
      swarmRegistry: { get: () => null, all: function* () { /* empty */ } },
      applyDamage: () => {},
      broadcastFired: () => {},
      broadcastDetonated: () => {},
      bus: new Bus(),
    });
    const def = getWeapon('heat-seeker') as MissileWeaponDef;
    sim.spawn('player-a', 0, 0, 0, 1, def, () => false);
    const y = (): number => {
      for (const m of sim.live()) return m.y;
      throw new Error('no missile');
    };
    const y0 = y();
    sim.advance(); // tick 100
    const step = y() - y0;
    expect(step).toBeCloseTo(def.speed / 60, 6);
    clock.tick = 103;
    sim.advance();
    expect(y() - y0, 'three worker ticks passed: three steps').toBeCloseTo(4 * step, 6);
  });
});
