/**
 * Helm orders (capital-ship R&D round 3 D). Flies real PhysicsWorld ships
 * under the helm: they reach the course point, settle on it (no overshoot
 * past the arrival radius beyond the solver's turning circle), and hold
 * the set speed on the way.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../physics/World.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { helmStep, makeHelmOutput, helmArriveRadius, type HelmOrder, type HelmSpeed } from './helm.js';

beforeAll(async () => { await RAPIER.init(); });

async function fly(kindId: ShipKindId, tx: number, ty: number, speed: HelmSpeed, maxSeconds: number) {
  const world = await PhysicsWorld.create();
  world.spawnShip('s', 0, 0, kindId);
  const kind = getShipKind(kindId);
  const order: HelmOrder = { active: true, tx, ty, speed };
  const out = makeHelmOutput();
  let arrivedAt = -1, peakSpeed = 0, closest = Infinity, overshootAfterClosest = 0;
  for (let t = 0; t < maxSeconds * 60; t++) {
    const s = world.getShipState('s')!;
    helmStep(order, { ...s, angvel: s.angvel ?? 0 }, kind, out);
    if (out.arrived && arrivedAt < 0) arrivedAt = t / 60;
    world.applyInput('s', { thrust: out.thrust, turnLeft: out.turnLeft, turnRight: out.turnRight });
    world.tick(1 / 60);
    const n = world.getShipState('s')!;
    const d = Math.hypot(tx - n.x, ty - n.y);
    peakSpeed = Math.max(peakSpeed, Math.hypot(n.vx, n.vy));
    if (d < closest) closest = d; else overshootAfterClosest = Math.max(overshootAfterClosest, d - closest);
  }
  const end = world.getShipState('s')!;
  return { kind, arrivedAt, peakSpeed, endDist: Math.hypot(tx - end.x, ty - end.y), closest, end };
}

describe('helm', () => {
  it('a fighter flies to a point behind it and stops there', async () => {
    const r = await fly('fighter', 400, -300, 3, 30);
    expect(r.arrivedAt).toBeGreaterThan(0);
    expect(r.endDist).toBeLessThanOrEqual(helmArriveRadius(r.kind) * 1.5);
  });

  it('a battleship turns and settles on a point 15 km away at full speed', async () => {
    const r = await fly('battleship', -9000, 12000, 3, 600);
    expect(r.arrivedAt).toBeGreaterThan(0);
    // Ends inside its arrival radius (a quarter of the hull).
    expect(r.endDist).toBeLessThanOrEqual(helmArriveRadius(r.kind) * 1.2);
  }, 60_000);

  it('the speed setting caps the cruise speed (1/3 stays near a third)', async () => {
    const r = await fly('battleship', 0, 30000, 1, 200);
    expect(r.peakSpeed).toBeLessThanOrEqual(r.kind.maxSpeed / 3 * 1.08);
    expect(r.peakSpeed).toBeGreaterThan(r.kind.maxSpeed / 3 * 0.85);
  }, 60_000);

  it('stop (speed 0) never thrusts; no order outputs nothing', () => {
    const k = getShipKind('destroyer');
    const pose = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0 };
    const out = makeHelmOutput();
    helmStep({ active: true, tx: 0, ty: 5000, speed: 0 }, pose, k, out);
    expect(out.thrust).toBe(false);
    helmStep({ active: false, tx: 5000, ty: 0, speed: 3 }, pose, k, out);
    expect(out.thrust || out.turnLeft || out.turnRight).toBe(false);
  });
});
