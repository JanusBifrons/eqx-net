/**
 * Settle-to-sleep (wreck sleep fix, 2026-11-13): `World.setSleepSettle` puts a
 * body to sleep once it has moved under its own thresholds for
 * `WRECK_SETTLE_STEPS` fixed steps, instead of drifting on to Rapier's global
 * 0.4 u/s. Sub-cap wreck pieces use it on the server worker AND the client
 * predWorld twin (`wreckBodyParams`), so it must be deterministic.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld, WRECK_SETTLE_STEPS } from './World.js';
import { wreckBodyParams } from '../destruction/wreckPieces.js';

const DT = 1 / 60;
const box = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];

/** A damped wreck-like body drifting at `v` u/s; returns the step it first
 *  sleeps on (or -1 within `max` steps). */
function stepsToSleep(world: PhysicsWorld, id: string, v: number, settle: number | null, max: number): number {
  world.spawnObstacle(id, 0, 0, 14, 4, undefined, 0.6, undefined, [box]);
  if (settle !== null) world.setSleepSettle(id, settle, 0.3);
  world.setShipState(id, { x: 0, y: 0, angle: 0, vx: v, vy: 0, angvel: 0 });
  for (let i = 1; i <= max; i++) {
    world.tick(DT);
    if (world.isSleeping(id)) return i;
  }
  return -1;
}

let world: PhysicsWorld;
beforeAll(async () => {
  world = await PhysicsWorld.create();
});

describe('PhysicsWorld.setSleepSettle', () => {
  it('a body drifting under its settle speed sleeps after WRECK_SETTLE_STEPS steps', async () => {
    const w = await PhysicsWorld.create();
    const n = stepsToSleep(w, 'settle-a', 2, 3, 600);
    expect(n).toBeGreaterThanOrEqual(WRECK_SETTLE_STEPS);
    expect(n).toBeLessThanOrEqual(WRECK_SETTLE_STEPS + 2);
    const s = w.getShipState('settle-a')!;
    expect(Math.hypot(s.vx, s.vy)).toBe(0);
  });

  it('without settle the same drift takes seconds longer (Rapier 0.4 u/s + 2 s)', async () => {
    const n = stepsToSleep(await PhysicsWorld.create(), 'settle-b', 2, null, 1200);
    expect(n === -1 || n > 3 * 60).toBe(true);
  });

  it('a body above its settle speed is not put to sleep until it slows under it', async () => {
    // 10 u/s at 0.6/s damping reaches 3 u/s after ~2 s.
    const n = stepsToSleep(await PhysicsWorld.create(), 'settle-c', 10, 3, 600);
    expect(n).toBeGreaterThan(110);
    expect(n).toBeLessThan(110 + WRECK_SETTLE_STEPS + 20);
  });

  it('is deterministic: two worlds sleep the body on the same step at the same pose', async () => {
    const w1 = await PhysicsWorld.create();
    const w2 = await PhysicsWorld.create();
    const a = stepsToSleep(w1, 'p', 7.3, 3, 600);
    const b = stepsToSleep(w2, 'p', 7.3, 3, 600);
    expect(a).toBe(b);
    expect(w1.getShipState('p')).toEqual(w2.getShipState('p'));
  });

  it('speed 0 removes it; a despawned body is forgotten', () => {
    world.spawnObstacle('settle-d', 500, 0, 14, 4, undefined, 0.6, undefined, [box]);
    world.setSleepSettle('settle-d', 3, 0.3);
    world.setSleepSettle('settle-d', 0, 0);
    world.despawnShip('settle-d');
    expect(() => world.tick(DT)).not.toThrow();
  });

  it('wreck body params: sub-cap pieces settle (per radius, #18); capital pieces do not', () => {
    const fighter = wreckBodyParams('fighter');
    expect(fighter.settleSpeed).toBeGreaterThan(0);
    expect(fighter.settleSpin).toBeGreaterThan(0);
    expect(wreckBodyParams('heavy-cruiser').settleSpeed).toBe(0);
  });
});
