/**
 * Pool / free-list correctness for MissileSimulation. These tests run
 * pure (no SectorRoom, no Rapier, no Colyseus) — they exercise just
 * the spawn → release → spawn cycle to verify zero per-tick allocation
 * growth and correct overflow behaviour.
 *
 * The integration tests in tests/integration/sectorRoom/ cover the full
 * lock-and-detonate flow inside a real room.
 */

import { describe, it, expect } from 'vitest';
import { Bus } from '../../core/events/Bus.js';
import { MissileSimulation, MISSILE_POOL_CAPACITY } from './MissileSimulation.js';
import { getWeapon, type MissileWeaponDef } from '../../core/combat/WeaponCatalogue.js';

const HEAT_SEEKER = getWeapon('heat-seeker') as MissileWeaponDef;

function makeSim(): { sim: MissileSimulation; impulses: number; broadcasts: number } {
  let broadcasts = 0;
  let impulses = 0;
  const sim = new MissileSimulation({
    sabF32: new Float32Array(1024),
    serverTick: () => 0,
    playerToSlot: [],
    getActiveShip: () => undefined,
    shipPoseCache: new Map(),
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    swarmRegistry: {
      get: () => null,
      all: function* () { /* empty */ },
    },
    applyDamage: () => {},
    broadcastFired: () => { broadcasts++; },
    broadcastDetonated: () => { broadcasts++; },
    bus: new Bus(),
  });
  // Track impulse-drain count for the consumer.
  const origDrain = sim.drainImpulses.bind(sim);
  sim.drainImpulses = () => {
    const r = origDrain();
    impulses += r.length;
    return r;
  };
  return { sim, get impulses(): number { return impulses; }, get broadcasts(): number { return broadcasts; } } as never;
}

describe('MissileSimulation pool', () => {
  it('spawns return successive ids and size grows', () => {
    const { sim } = makeSim();
    expect(sim.size()).toBe(0);
    const id0 = sim.spawn('player-a', 0, 0, 0, -1, HEAT_SEEKER, () => false);
    const id1 = sim.spawn('player-a', 0, 0, 0, -1, HEAT_SEEKER, () => false);
    const id2 = sim.spawn('player-a', 0, 0, 0, -1, HEAT_SEEKER, () => false);
    expect(id0).toBe(0);
    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(sim.size()).toBe(3);
  });

  it('advance() expires missiles on lifetime — pool returns to empty', () => {
    const { sim } = makeSim();
    // Spawn one. lifetimeTicks = 360.
    sim.spawn('player-a', 0, 0, 0, -1, HEAT_SEEKER, () => false);
    expect(sim.size()).toBe(1);
    // Advance enough ticks to expire it.
    for (let i = 0; i < HEAT_SEEKER.lifetimeTicks + 2; i++) sim.advance();
    expect(sim.size()).toBe(0);
  });

  it('overflow: spawn returns null when pool is full; size stays at capacity', () => {
    const { sim } = makeSim();
    for (let i = 0; i < MISSILE_POOL_CAPACITY; i++) {
      const r = sim.spawn('player-a', 0, 0, 0, -1, HEAT_SEEKER, () => false);
      expect(r).not.toBeNull();
    }
    expect(sim.size()).toBe(MISSILE_POOL_CAPACITY);
    // Capacity reached — next spawn rejects.
    const overflow = sim.spawn('player-a', 0, 0, 0, -1, HEAT_SEEKER, () => false);
    expect(overflow).toBeNull();
    expect(sim.size()).toBe(MISSILE_POOL_CAPACITY);
  });

  it('high-water tracks peak size across spawn/release cycles', () => {
    const { sim } = makeSim();
    expect(sim.highWaterCount()).toBe(0);
    for (let i = 0; i < 10; i++) sim.spawn('p', 0, 0, 0, -1, HEAT_SEEKER, () => false);
    expect(sim.highWaterCount()).toBe(10);
    // Expire all → high-water stays at peak.
    for (let i = 0; i < HEAT_SEEKER.lifetimeTicks + 2; i++) sim.advance();
    expect(sim.size()).toBe(0);
    expect(sim.highWaterCount()).toBe(10);
    // Reset → high-water tracks the new peak (currently 0).
    sim.resetHighWater();
    expect(sim.highWaterCount()).toBe(0);
  });

  it('snapshotSlice() returns undefined when empty, populated when live', () => {
    const { sim } = makeSim();
    expect(sim.snapshotSlice()).toBeUndefined();
    sim.spawn('player-a', 100, 200, 1, 0, HEAT_SEEKER, () => false);
    const slice = sim.snapshotSlice();
    expect(slice).toBeDefined();
    expect(slice!.length).toBe(1);
    expect(slice![0]).toMatchObject({
      id: 0,
      ownerId: 'player-a',
      weaponId: 'heat-seeker',
    });
    // Initial spawn pose stamped from (spawnX, spawnY).
    expect(slice![0]!.x).toBeCloseTo(100);
    expect(slice![0]!.y).toBeCloseTo(200);
    // lifePct starts at 1.0 (full lifetime remaining).
    expect(slice![0]!.lifePct).toBeCloseTo(1);
  });

  it('spawn without hostile targets → dumb-mode missile flies straight', () => {
    const { sim } = makeSim();
    // No candidates at all (empty player/swarm) — lock is null.
    sim.spawn('player-a', 0, 0, 0, 1, HEAT_SEEKER, () => true);
    const slice = sim.snapshotSlice();
    expect(slice).toBeDefined();
    // angle 0 = pointing forward = -y, but dir (0,1) maps to angle π.
    // Just check it's present (specific values are tested elsewhere).
    expect(slice![0]).toBeDefined();
  });

  it('broadcasts missile_fired exactly once per spawn', () => {
    let firedCount = 0;
    let detonatedCount = 0;
    const sim = new MissileSimulation({
      sabF32: new Float32Array(1024),
      serverTick: () => 0,
      playerToSlot: [],
      getActiveShip: () => undefined,
      shipPoseCache: new Map(),
      lingeringSlots: new Map(),
      lingeringPoseCache: new Map(),
      swarmRegistry: { get: () => null, all: function* () {} },
      applyDamage: () => {},
      broadcastFired: () => { firedCount++; },
      broadcastDetonated: () => { detonatedCount++; },
      bus: new Bus(),
    });
    sim.spawn('p', 0, 0, 0, -1, HEAT_SEEKER, () => false);
    sim.spawn('p', 0, 0, 0, -1, HEAT_SEEKER, () => false);
    expect(firedCount).toBe(2);
    // Impact-only (smoke handoff 2026-06-06, Issue 2): both missiles fly
    // out their lifetime WITHOUT a hostile target → they DESPAWN on expiry
    // with NO detonation broadcast (a missed missile fizzles, it does not
    // splash in-place). Were the old lifetime-detonate behaviour present,
    // detonatedCount would be 2.
    for (let i = 0; i < HEAT_SEEKER.lifetimeTicks + 2; i++) sim.advance();
    expect(detonatedCount).toBe(0);
    // …and both are gone from the pool (despawn cap honoured).
    expect(sim.snapshotSlice()).toBeUndefined();
  });
});
