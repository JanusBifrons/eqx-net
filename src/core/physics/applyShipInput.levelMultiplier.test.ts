import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from './World.js';
import { deriveStatMultipliers } from '../leveling/shipStats.js';

/**
 * Phase 4 WS-B2 — the canonical risk-#1 lock: per-instance stat multipliers
 * (`topSpeed` / `turnRate`) must scale movement IDENTICALLY on the server sim
 * and the client prediction, so reconciliation stays clean (invariants #4/#12).
 *
 * The test drives TWO independent `PhysicsWorld`s — one standing in for the
 * server worker, one for the client predWorld — with the SAME stat allocation
 * applied via the SAME `setStatMultipliers` seam and the SAME per-tick input.
 * If the two diverge by even a float, prediction would drift every snapshot.
 *
 * It ALSO proves the upgrade is REAL (an upgraded ship reaches a higher speed /
 * turns faster than a baseline one) and that an empty allocation is byte-for-
 * byte identical to the legacy no-`mul` path (back-compat).
 */

let server: PhysicsWorld;
let client: PhysicsWorld;

beforeAll(async () => {
  server = await PhysicsWorld.create();
  client = await PhysicsWorld.create();
});

/** Drive `id` through N ticks of full forward thrust and return its speed. */
function thrustToSpeed(world: PhysicsWorld, id: string, ticks: number): number {
  for (let i = 0; i < ticks; i++) {
    world.applyInput(id, { thrust: true, turnLeft: false, turnRight: false });
    world.tick(1 / 60);
  }
  const s = world.getShipState(id)!;
  return Math.hypot(s.vx, s.vy);
}

/** Drive `id` through one tick of full left turn and return its angular vel. */
function turnAngvel(world: PhysicsWorld, id: string): number {
  world.applyInput(id, { thrust: false, turnLeft: true, turnRight: false });
  world.tick(1 / 60);
  const s = world.getShipState(id)!;
  return s.angvel ?? 0;
}

describe('applyShipInput — per-instance stat multipliers (server==client)', () => {
  it('topSpeed multiplier scales the same on server + client (no drift)', () => {
    // +5 points on topSpeed ⇒ ×1.25 (STAT_POINT_FRAC 0.05).
    const mul = deriveStatMultipliers({ topSpeed: 5 });

    server.spawnShip('sc-server', 0, 0);
    client.spawnShip('sc-server', 0, 0); // same id is fine — different worlds
    server.setStatMultipliers('sc-server', mul);
    client.setStatMultipliers('sc-server', mul);

    const sSpeed = thrustToSpeed(server, 'sc-server', 600);
    const cSpeed = thrustToSpeed(client, 'sc-server', 600);

    // Byte-identical (same deterministic Rapier steps, same multipliers).
    expect(cSpeed).toBeCloseTo(sSpeed, 6);
  });

  it('turnRate multiplier scales angvel the same on server + client', () => {
    const mul = deriveStatMultipliers({ turnRate: 4 }); // ×1.20

    server.spawnShip('tr-server', 0, 0);
    client.spawnShip('tr-server', 0, 0);
    server.setStatMultipliers('tr-server', mul);
    client.setStatMultipliers('tr-server', mul);

    const sW = turnAngvel(server, 'tr-server');
    const cW = turnAngvel(client, 'tr-server');
    expect(cW).toBeCloseTo(sW, 6);
    expect(Math.abs(sW)).toBeGreaterThan(0);
  });

  it('an upgraded ship genuinely reaches a HIGHER top speed than a baseline one', () => {
    // Spawn FAR apart so the two bodies never collide (they fly along +Y from
    // distinct X lanes).
    server.spawnShip('base-ship', -50_000, 0); // no mul
    server.spawnShip('fast-ship', 50_000, 0);
    server.setStatMultipliers('fast-ship', deriveStatMultipliers({ topSpeed: 8 })); // ×1.40

    const baseSpeed = thrustToSpeed(server, 'base-ship', 800);
    const fastSpeed = thrustToSpeed(server, 'fast-ship', 800);

    expect(fastSpeed).toBeGreaterThan(baseSpeed * 1.2);
  });

  it('an upgraded ship turns FASTER than a baseline one', () => {
    server.spawnShip('base-turn', -60_000, 0);
    server.spawnShip('fast-turn', 60_000, 0);
    server.setStatMultipliers('fast-turn', deriveStatMultipliers({ turnRate: 10 })); // ×1.50

    const baseW = Math.abs(turnAngvel(server, 'base-turn'));
    const fastW = Math.abs(turnAngvel(server, 'fast-turn'));
    expect(fastW).toBeGreaterThan(baseW * 1.3);
  });

  it('an EMPTY allocation is byte-identical to the legacy no-multiplier path', () => {
    server.spawnShip('empty-mul', -70_000, 0);
    server.spawnShip('no-mul', 70_000, 0);
    server.setStatMultipliers('empty-mul', deriveStatMultipliers({})); // all factors 1
    // 'no-mul' gets nothing — the legacy path.

    const a = thrustToSpeed(server, 'empty-mul', 300);
    const b = thrustToSpeed(server, 'no-mul', 300);
    expect(a).toBeCloseTo(b, 9);
  });
});
