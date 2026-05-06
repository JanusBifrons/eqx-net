import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from './World.js';
import { SHIP_KINDS } from '../../shared-types/shipKinds.js';

/**
 * Integration test for the per-kind physics tuning. Spawns one ship of each
 * kind into its own world, runs a deterministic input pattern, and asserts the
 * three kinds order correctly along their character axes:
 *
 *   - top speed:  scout < fighter < heavy
 *   - turn rate:  scout > fighter > heavy
 *
 * If a future tune swaps the relationships (e.g. Heavy gets a lower top
 * speed), this test fails before merge — protecting the catalogue's
 * "Scout / Fighter / Heavy" archetype contract from quiet drift.
 */

let world: PhysicsWorld;

beforeAll(async () => {
  world = await PhysicsWorld.create();
});

function runHoldThrust(world: PhysicsWorld, id: string, ticks: number, withBoost = true): number {
  for (let t = 0; t < ticks; t++) {
    world.applyInput(id, { thrust: true, turnLeft: false, turnRight: false, boost: withBoost });
    world.tick(1 / 60);
  }
  const s = world.getShipState(id)!;
  return Math.hypot(s.vx, s.vy);
}

function runHoldTurnLeft(world: PhysicsWorld, id: string, ticks: number): number {
  // Hold turnLeft for `ticks` and return the achieved angle (radians).
  for (let t = 0; t < ticks; t++) {
    world.applyInput(id, { thrust: false, turnLeft: true, turnRight: false });
    world.tick(1 / 60);
  }
  const s = world.getShipState(id)!;
  return s.angle;
}

describe('ship-kind physics ordering (catalogue archetype contract)', () => {
  it('top speed under boost: heavy > fighter > scout', async () => {
    // 25 seconds — Heavy's `linearDamping = 0.2` gives a 5 s time constant,
    // so 5 e-folds (≈ 99.3% of terminal) takes ~25 s of simulation.
    const TICKS = 1500;
    // Each ship gets its own world so collider density / damping settings
    // don't bleed across — World.spawnShip stores per-body kind already, but
    // separate worlds keep the test maximally independent.
    const w1 = await PhysicsWorld.create();
    const w2 = await PhysicsWorld.create();
    const w3 = await PhysicsWorld.create();
    w1.spawnShip('s', 0, 0, 'scout');
    w2.spawnShip('f', 0, 0, 'fighter');
    w3.spawnShip('h', 0, 0, 'heavy');
    const scoutSpeed   = runHoldThrust(w1, 's', TICKS);
    const fighterSpeed = runHoldThrust(w2, 'f', TICKS);
    const heavySpeed   = runHoldThrust(w3, 'h', TICKS);
    expect(heavySpeed).toBeGreaterThan(fighterSpeed);
    expect(fighterSpeed).toBeGreaterThan(scoutSpeed);
    // Sanity: each speed lands close to the analytical boosted terminal
    // (within 5%) so a typo in the catalogue is caught even when ordering
    // happens to survive.
    for (const [id, w, kindKey] of [
      ['s', w1, 'scout'],
      ['f', w2, 'fighter'],
      ['h', w3, 'heavy'],
    ] as const) {
      const k = SHIP_KINDS[kindKey];
      const expected = (k.thrustImpulse * k.boostMultiplier) / (1 - Math.exp(-k.linearDamping / 60));
      const actual = Math.hypot(w.getShipState(id)!.vx, w.getShipState(id)!.vy);
      expect(Math.abs(actual - expected) / expected).toBeLessThan(0.05);
    }
    w1.dispose(); w2.dispose(); w3.dispose();
  });

  it('turn rate while holding A: scout > fighter > heavy', async () => {
    const TICKS = 60; // 1 second — long enough to see the difference
    const w1 = await PhysicsWorld.create();
    const w2 = await PhysicsWorld.create();
    const w3 = await PhysicsWorld.create();
    w1.spawnShip('s', 0, 0, 'scout');
    w2.spawnShip('f', 0, 0, 'fighter');
    w3.spawnShip('h', 0, 0, 'heavy');
    const scoutAngle   = runHoldTurnLeft(w1, 's', TICKS);
    const fighterAngle = runHoldTurnLeft(w2, 'f', TICKS);
    const heavyAngle   = runHoldTurnLeft(w3, 'h', TICKS);
    expect(scoutAngle).toBeGreaterThan(fighterAngle);
    expect(fighterAngle).toBeGreaterThan(heavyAngle);
    // Each angle ≈ maxAngvel * time (snap-to-target turn).
    expect(scoutAngle).toBeCloseTo(SHIP_KINDS.scout.maxAngvel * 1.0, 1);
  });

  it('default `spawnShip(id, x, y)` reproduces the legacy fighter behaviour', () => {
    // Back-compat guard: callers that didn't pass a kindId before this
    // refactor must continue to get the catalogue default (Fighter).
    world.spawnShip('legacy-fighter', 0, 0);
    world.applyInput('legacy-fighter', { thrust: true, turnLeft: false, turnRight: false });
    world.tick(1 / 60);
    const s = world.getShipState('legacy-fighter')!;
    expect(s.vy).toBeGreaterThan(0); // forward at angle=0 is +y
    world.despawnShip('legacy-fighter');
  });

  it('reverse impulse pushes opposite to facing at the kind-specific factor', () => {
    const w = world; // any kind works; we use Fighter via default spawn.
    w.spawnShip('rev', 0, 0, 'fighter');
    // Hold reverse for 1 tick. With angle=0, forward is +y, so reverse is -y.
    w.applyInput('rev', { thrust: false, turnLeft: false, turnRight: false, reverse: true });
    w.tick(1 / 60);
    const s = w.getShipState('rev')!;
    expect(s.vy).toBeLessThan(0);
    expect(Math.abs(s.vx)).toBeLessThan(0.001);
    w.despawnShip('rev');
  });

  it('lateral-grip filter bleeds sideways velocity over time', () => {
    const w = world;
    w.spawnShip('drift', 0, 0, 'fighter');
    // Set a purely lateral velocity (sideways relative to angle=0 facing).
    // Forward at angle=0 is (0, 1); lateral is (1, 0).
    w.setShipState('drift', { x: 0, y: 0, vx: 100, vy: 0, angle: 0 });
    // Tick the world a bunch of times with no input — applyInput's lateral
    // grip filter should cancel the sideways component over many ticks.
    // Run applyInput each tick so the filter actually runs (it's part of
    // the input application, not the world step).
    for (let i = 0; i < 60; i++) {
      w.applyInput('drift', { thrust: false, turnLeft: false, turnRight: false });
      w.tick(1 / 60);
    }
    const s = w.getShipState('drift')!;
    // Lateral component should have decayed below the initial value (Fighter
    // grip = 0.025 → half-life ≈ 460 ms, so after 1 s it's ~22% retained).
    expect(Math.abs(s.vx)).toBeLessThan(40);
    w.despawnShip('drift');
  });
});
