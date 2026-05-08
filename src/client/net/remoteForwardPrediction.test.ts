/**
 * Stage 3 of the network-feel roadmap. Property tests for remote-entity
 * forward-prediction: given a remote ship's last-known input vector, the
 * client should be able to forward-step its predWorld and arrive at the
 * same pose the server arrives at after the same number of ticks.
 *
 * Pre-Stage-3 the client only applies LOCAL input during reconciliation
 * replay and tickPhysics — remote ships sit at their last server-tick
 * pose and integrate forward only via Rapier's damping (no thrust, no
 * turn). Stage 3 wires the snapshot's per-ship `lastInput` into the
 * replay loop so remote ships forward-predict with the same impulse
 * model the server uses. The test below is the property: applying the
 * same input vector to two parallel PhysicsWorld instances produces
 * identical poses to floating-point tolerance.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld, type ShipInput } from '../../core/physics/World.js';

beforeAll(async () => {
  await RAPIER.init();
});

const REMOTE_ID = 'remote-ship';

async function spawnAt(x: number, y: number): Promise<PhysicsWorld> {
  const w = await PhysicsWorld.create();
  w.spawnShip(REMOTE_ID, x, y);
  return w;
}

/** Run `ticks` of the same input on a world. Mirrors what the upcoming
 *  forward-prediction loop in tickPhysics + Reconciler.reconcile will do. */
function runWithInput(world: PhysicsWorld, input: ShipInput, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    world.applyInput(REMOTE_ID, input);
    world.tick(1 / 60);
  }
}

describe('remote forward-prediction property', () => {
  it('Cycle 1: idle remote — predicted pose matches server pose across 60 ticks', async () => {
    // The trivial baseline: with no input applied, both worlds integrate
    // identically (zero linear/angular velocity → zero motion). Confirms
    // the test fixture works.
    const server = await spawnAt(100, 50);
    const client = await spawnAt(100, 50);

    const idle: ShipInput = { thrust: false, turnLeft: false, turnRight: false };
    runWithInput(server, idle, 60);
    runWithInput(client, idle, 60);

    const s = server.getShipState(REMOTE_ID)!;
    const c = client.getShipState(REMOTE_ID)!;
    expect(c.x).toBeCloseTo(s.x, 5);
    expect(c.y).toBeCloseTo(s.y, 5);
    expect(c.vx).toBeCloseTo(s.vx, 5);
    expect(c.vy).toBeCloseTo(s.vy, 5);

    server.dispose();
    client.dispose();
  });

  it('Cycle 2: thrusting remote — predicted pose within 0.1 u of server pose after 8 ticks', async () => {
    // The actual Stage 3 property: when both worlds receive the same
    // thrust input each tick, they reach the same pose. This is what
    // the server will broadcast (lastInput in snapshot) and what the
    // client will apply during forward-prediction.
    //
    // The model is deterministic at the FIXED 60 Hz step (PhysicsWorld
    // uses an accumulator, but each tick(1/60) call produces exactly
    // one step), so the two worlds advance in lockstep.
    const server = await spawnAt(0, 0);
    const client = await spawnAt(0, 0);

    const thrust: ShipInput = { thrust: true, turnLeft: false, turnRight: false };
    runWithInput(server, thrust, 8);
    runWithInput(client, thrust, 8);

    const s = server.getShipState(REMOTE_ID)!;
    const c = client.getShipState(REMOTE_ID)!;
    const drift = Math.hypot(s.x - c.x, s.y - c.y);
    expect(drift).toBeLessThan(0.1);
    // Thrust must have actually moved the ship — guards against the
    // degenerate "both worlds ignored input" failure mode.
    expect(Math.hypot(s.x, s.y)).toBeGreaterThan(0.1);

    server.dispose();
    client.dispose();
  });

  it('Cycle 2: thrusting + turn — predicted pose tracks across 30 ticks', async () => {
    // Sustained thrust + turn-right (tighter test of the snappy-turn
    // model). After half a second of input the ship has both translated
    // and rotated significantly; lockstep simulation should still match.
    const server = await spawnAt(0, 0);
    const client = await spawnAt(0, 0);

    const drive: ShipInput = { thrust: true, turnLeft: false, turnRight: true };
    runWithInput(server, drive, 30);
    runWithInput(client, drive, 30);

    const s = server.getShipState(REMOTE_ID)!;
    const c = client.getShipState(REMOTE_ID)!;
    const drift = Math.hypot(s.x - c.x, s.y - c.y);
    expect(drift).toBeLessThan(0.1);
    expect(Math.abs(s.angle - c.angle)).toBeLessThan(0.001);

    server.dispose();
    client.dispose();
  });

  it('Cycle 2: forward-predict from a non-zero starting state', async () => {
    // The realistic case: client receives a snapshot mid-flight (ship
    // already moving), applies the snapshot pose, then forward-predicts
    // N ticks with the snapshot's lastInput. End state should match
    // what the server would compute from the same starting pose.
    const server = await spawnAt(50, -20);
    const client = await spawnAt(50, -20);

    const initial = { x: 50, y: -20, angle: 0.5, vx: 30, vy: -10 };
    server.setShipState(REMOTE_ID, initial);
    client.setShipState(REMOTE_ID, initial);

    const thrust: ShipInput = { thrust: true, turnLeft: true, turnRight: false };
    runWithInput(server, thrust, 12);
    runWithInput(client, thrust, 12);

    const s = server.getShipState(REMOTE_ID)!;
    const c = client.getShipState(REMOTE_ID)!;
    expect(Math.hypot(s.x - c.x, s.y - c.y)).toBeLessThan(0.1);

    server.dispose();
    client.dispose();
  });
});
