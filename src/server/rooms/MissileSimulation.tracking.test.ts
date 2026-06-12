/**
 * Missile tracking — closest-bias lock + mid-flight re-acquisition (playtest
 * 2026-06-10 Issue 10: "missiles should bias tracking the closest enemy a lot
 * more"). Pure (no SectorRoom/Rapier/Colyseus): a mutable swarm registry + a
 * SAB pose buffer, observing locks via the `serverLogEvent` diag hook.
 *
 * Before the fix a heat-seeker locked ONCE at launch and, if that target died,
 * flew straight forever. The fix re-runs the closest-hostile selection from the
 * missile's current position every MISSILE_REACQUIRE_INTERVAL_TICKS while it has
 * no lock — so it chases the nearest remaining enemy.
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

interface DroneRec { id: string; slot: number; radius: number; kind: number }

function makeSim() {
  const drones = new Map<string, DroneRec>();
  const sabF32 = new Float32Array(4096);
  const events: Array<{ tag: string; data: Record<string, unknown> }> = [];

  function addDrone(id: string, slot: number, x: number, y: number): void {
    drones.set(id, { id, slot, radius: 8, kind: 1 });
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

  return { sim, drones, addDrone, events };
}

describe('MissileSimulation — closest-bias lock at launch', () => {
  it('locks the NEAREST hostile, not a farther one', () => {
    const { sim, addDrone, events } = makeSim();
    addDrone('swarm-far', 0, 800, 0);
    addDrone('swarm-near', 1, 200, 0);
    sim.spawn('player-a', 0, 0, 0, 1, HEAT_SEEKER, () => true);
    const spawned = events.find((e) => e.tag === 'missile_spawned');
    expect(spawned?.data['lockedTargetId']).toBe('swarm-near');
  });
});

describe('MissileSimulation — mid-flight re-acquisition (Issue 10)', () => {
  it('re-locks the nearest remaining hostile when its target dies', () => {
    const { sim, drones, addDrone, events } = makeSim();
    addDrone('swarm-a', 0, 250, 0); // nearest → launch lock
    addDrone('swarm-b', 1, 600, 0); // farther → re-acq target after A dies
    sim.spawn('player-a', 0, 0, 0, 1, HEAT_SEEKER, () => true);
    expect(events.find((e) => e.tag === 'missile_spawned')?.data['lockedTargetId']).toBe('swarm-a');

    // Target A dies before the first advance → lock can't resolve → re-acquire
    // (ageTicks 0 % interval === 0 fires immediately) onto the remaining B.
    drones.delete('swarm-a');
    sim.advance();

    const reacq = events.find((e) => e.tag === 'missile_reacquired');
    expect(reacq, 'missile should re-acquire after its target died').toBeDefined();
    expect(reacq!.data['targetId']).toBe('swarm-b');
  });

  it('a missile with NO remaining hostile flies on (no spurious re-lock)', () => {
    const { sim, drones, addDrone, events } = makeSim();
    addDrone('swarm-a', 0, 250, 0);
    sim.spawn('player-a', 0, 0, 0, 1, HEAT_SEEKER, () => true);
    drones.delete('swarm-a'); // no hostiles left at all
    for (let i = 0; i < 25; i++) sim.advance();
    expect(events.some((e) => e.tag === 'missile_reacquired')).toBe(false);
  });
});
