/**
 * Campaign 5.1a (anti-patterns review A1 / Part D #7) — missile collision is a
 * SWEPT-SEGMENT test, not a point sample.
 *
 * `sweepCollision` used to test only the POST-integration position against
 * each target circle, so a missile whose per-tick step carries it across a
 * collider between samples sailed straight through — the "missiles pass
 * through lingering ships" report. The projectile pipeline already solved
 * this with the shared `projectileSweepCircle` (Minkowski swept circle);
 * missiles now run the same test over the full step segment BEFORE
 * integrating, detonating at the parametric entry point.
 *
 * Harness mirrors `MissileSimulation.tracking.test.ts` (pure mocked deps).
 * The tunnelling def is a fast variant of the catalogue heat-seeker — the
 * catalogue is data-driven, so the sim must be tunnel-proof at ANY speed a
 * def can carry (the same reasoning as the projectile pipeline's lock).
 */
import { describe, it, expect } from 'vitest';
import { Bus } from '../../core/events/Bus.js';
import { MissileSimulation } from './MissileSimulation.js';
import { getWeapon, type MissileWeaponDef } from '../../core/combat/WeaponCatalogue.js';
import {
  slotBase,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
} from '../../shared-types/sabLayout.js';

const HEAT_SEEKER = getWeapon('heat-seeker') as MissileWeaponDef;
/** 3600 u/s = 60 u per tick — the step leaps clean across a combined
 *  radius-12 collider placed mid-path (pre-fix: point sample misses it). */
const FAST_SEEKER: MissileWeaponDef = { ...HEAT_SEEKER, speed: 3600 };

interface DroneRec { id: string; slot: number; radius: number; kind: number }

function makeSim() {
  const drones = new Map<string, DroneRec>();
  const sabF32 = new Float32Array(4096);
  const events: Array<{ tag: string; data: Record<string, unknown> }> = [];

  function addObstacle(id: string, slot: number, x: number, y: number, radius = 8, kind = 0): void {
    drones.set(id, { id, slot, radius, kind });
    const b = slotBase(slot);
    sabF32[b + SLOT_X_OFF] = x;
    sabF32[b + SLOT_Y_OFF] = y;
    sabF32[b + SLOT_VX_OFF] = 0;
    sabF32[b + SLOT_VY_OFF] = 0;
  }

  const sim = new MissileSimulation({
    sabF32,
    serverTick: () => 0,
    playerToSlot: [],
    getActiveShip: () => undefined,
    shipPoseCache: new Map(),
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    swarmRegistry: {
      get: (id) => drones.get(id) ?? null,
      all: function* () { yield* drones.values(); },
    },
    applyDamage: () => {},
    broadcastFired: () => {},
    broadcastDetonated: () => {},
    bus: new Bus(),
    serverLogEvent: (tag, data) => { events.push({ tag, data }); },
  });

  return { sim, drones, addObstacle, events };
}

describe('MissileSimulation — swept-segment collision (campaign 5.1a)', () => {
  it('a fast missile detonates on a collider its step jumps ACROSS (failed pre-fix: sailed through)', () => {
    const { sim, addObstacle, events } = makeSim();
    // Asteroid (unlockable) dead ahead at y=30; the fast def steps 60 u/tick,
    // so the post-step point sits 30 u PAST the rock (outside combined
    // radius 4+8=12). Only a swept test sees the crossing.
    addObstacle('swarm-rock', 0, 0, 30, 8, 0);
    sim.spawn('player-a', 0, 0, 0, 1, FAST_SEEKER, () => false); // no lock — flies straight
    sim.advance();

    const det = events.find((e) => e.tag === 'missile_detonated');
    expect(det, 'missile must detonate on the crossed collider').toBeDefined();
    expect(det!.data['cause']).toBe('sweep');
    // The detonation point is the SWEPT entry (~y 18 = 30 − combined 12),
    // never the tunnelled post-step position (y 60).
    expect(det!.data['y'] as number).toBeLessThan(30);
    expect(det!.data['y'] as number).toBeGreaterThan(0);
  });

  it('the earliest collider along the step wins (two in the same step)', () => {
    const { sim, addObstacle, events } = makeSim();
    addObstacle('swarm-far', 0, 0, 45, 8, 0);
    addObstacle('swarm-near', 1, 0, 25, 8, 0);
    sim.spawn('player-a', 0, 0, 0, 1, FAST_SEEKER, () => false);
    sim.advance();

    const det = events.find((e) => e.tag === 'missile_detonated');
    expect(det).toBeDefined();
    // Splash accounting keys off the primary — it must be the NEAR one.
    expect(det!.data['primaryId'] ?? det!.data['lockedTargetId'] ?? null).not.toBe('swarm-far');
  });

  it('production-speed behaviour unchanged: contact still detonates, a clear miss still flies', () => {
    const { sim, addObstacle, events } = makeSim();
    addObstacle('swarm-rock', 0, 0, 8, 8, 0); // in contact range within one step
    sim.spawn('player-a', 0, 0, 0, 1, HEAT_SEEKER, () => false);
    sim.advance();
    expect(events.find((e) => e.tag === 'missile_detonated')).toBeDefined();

    const clear = makeSim();
    clear.addObstacle('swarm-off-path', 0, 400, 0, 8, 0); // far off the flight line
    clear.sim.spawn('player-a', 0, 0, 0, 1, HEAT_SEEKER, () => false);
    for (let i = 0; i < 30; i++) clear.sim.advance();
    expect(clear.events.find((e) => e.tag === 'missile_detonated')).toBeUndefined();
  });
});
