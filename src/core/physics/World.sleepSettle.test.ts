/**
 * Settle-to-sleep (wreck sleep fix, 2026-11-13): `World.setSleepSettle` puts a
 * body to sleep once it has moved under its own thresholds for
 * `WRECK_SETTLE_STEPS` fixed steps, instead of drifting on to Rapier's global
 * 0.4 u/s. Sub-cap wreck pieces use it on the server worker AND the client
 * predWorld twin (`wreckBodyParams`), so it must be deterministic.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld, WRECK_SETTLE_STEPS, BEAMED_LINEAR_DAMPING } from './World.js';
import { wreckBodyParams, WRECK_LINEAR_DAMPING } from '../destruction/wreckPieces.js';
import type { ForceField } from './forceFields.js';

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

  it('a body a live tractor beam holds never settles: a slow, heavy tow keeps its speed (rock chunks, 2026-11-17)', async () => {
    // A heavy piece towed far below its settle speed: settling zeroed its velocity every
    // WRECK_SETTLE_STEPS, so a 2,250-mass rock piece crept ~10 u a minute and never reached the hull.
    const w = await PhysicsWorld.create();
    w.spawnObstacle('tow', 0, 0, 14, 4, undefined, 0, undefined, [box]);
    w.setSleepSettle('tow', 30, 0.3);
    const tractor = (active: boolean): ForceField => ({
      kind: 'tractor', active, mx: 1000, my: 0, mvx: 0, mvy: 0, target: 'tow', emitter: 'ship',
      force: 4 * w.getBodyMass('tow')!, dRef: 2000, reach: 3000, hold: 50, lineHalfWidth: 0, lineFrac: 0,
      lineCount: 0, lineIds: [],
    });
    w.setForceField('beam', tractor(true));
    for (let i = 0; i < 4 * WRECK_SETTLE_STEPS; i++) w.tick(DT);
    expect(w.isSleeping('tow')).toBe(false);
    // 4 u/s² for 2 s: ~8 u/s and ~8 u, never reset.
    expect(w.getShipState('tow')!.vx).toBeGreaterThan(7);
    expect(w.getShipState('tow')!.x).toBeGreaterThan(7);
    // The beam off (an inactive field): the piece settles again.
    w.setForceField('beam', tractor(false));
    for (let i = 0; i < 2 * WRECK_SETTLE_STEPS; i++) w.tick(DT);
    expect(w.isSleeping('tow')).toBe(true);
  });

  it('a beamed piece has plain debris drag, not its 10× rock drag; released, its own drag returns (owner 2026-11-17)', async () => {
    // A rock piece coasting at 100 u/s with damping 0.6/s; the beam pulls with force 0, so only drag acts.
    expect(BEAMED_LINEAR_DAMPING).toBe(WRECK_LINEAR_DAMPING);
    const w = await PhysicsWorld.create();
    w.spawnObstacle('rock', 0, 0, 14, 4, undefined, 0.6, undefined, [box]);
    w.setSleepSettle('rock', 1, 0.3);
    const beam = (active: boolean): ForceField => ({
      kind: 'tractor', active, mx: 1000, my: 0, mvx: 0, mvy: 0, target: 'rock', emitter: 'ship',
      force: 0, dRef: 2000, reach: 3000, hold: 50, lineHalfWidth: 0, lineFrac: 0, lineCount: 0, lineIds: [],
    });
    w.setForceField('beam', beam(true));
    w.setShipState('rock', { x: 0, y: 0, angle: 0, vx: 100, vy: 0, angvel: 0 });
    for (let i = 0; i < 60; i++) w.tick(DT);
    const held = w.getShipState('rock')!.vx;
    expect(held).toBeGreaterThan(92); // ~100·e^-0.06 = 94; rock drag would leave ~55
    w.setForceField('beam', beam(false));
    for (let i = 0; i < 60; i++) w.tick(DT);
    expect(w.getShipState('rock')!.vx).toBeLessThan(held * 0.6); // e^-0.6 ≈ 0.55
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
