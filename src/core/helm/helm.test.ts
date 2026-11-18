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
import { helmStep, makeHelmOutput, helmArriveRadius, helmPassRadius, type HelmOrder, type HelmRoute, type HelmSpeed } from './helm.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';

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

  // A tap beside a capital on a phone is inside the circle it sweeps at full
  // speed (battleship ~8 km): thrusting through the turn only orbited the
  // point and never arrived (showcase player-capital-sector 2026-11-17).
  it.each([[3000, 0], [-3000, 0], [1500, 1500]])('a battleship reaches a near point off its beam (%i, %i) instead of orbiting it', async (tx, ty) => {
    const r = await fly('battleship', tx, ty, 3, 240);
    expect(r.arrivedAt).toBeGreaterThan(0);
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

  it('the arrival radius is a quarter hull, at least the ship hit radius, never a fixed number (#18)', () => {
    for (const id of ['fighter', 'destroyer', 'battleship'] as const) {
      const k = getShipKind(id);
      expect(helmArriveRadius(k)).toBe(Math.max(shipTuning(k).hitRadius, k.radius * 0.25));
    }
  });
});

/** Fly `kindId` from the origin along `pts` (packed x, y; the last is the goal). */
async function flyRoute(kindId: ShipKindId, pts: number[], maxSeconds: number) {
  const world = await PhysicsWorld.create();
  world.spawnShip('s', 0, 0, kindId);
  const kind = getShipKind(kindId);
  const route: HelmRoute = { pts: Float64Array.from(pts), n: pts.length / 2, idx: 0 };
  const order: HelmOrder = { active: true, tx: pts[pts.length - 2]!, ty: pts[pts.length - 1]!, speed: 3, route };
  const out = makeHelmOutput();
  const nearest = new Array<number>(route.n).fill(Infinity);
  const speedNear = new Array<number>(route.n).fill(0);
  let arrivedAt = -1;
  for (let t = 0; t < maxSeconds * 60 && arrivedAt < 0; t++) {
    const s = world.getShipState('s')!;
    helmStep(order, { ...s, angvel: s.angvel ?? 0 }, kind, out);
    if (out.arrived) arrivedAt = t / 60;
    world.applyInput('s', { thrust: out.thrust, turnLeft: out.turnLeft, turnRight: out.turnRight });
    world.tick(1 / 60);
    const n = world.getShipState('s')!;
    for (let i = 0; i < route.n; i++) {
      const d = Math.hypot(pts[2 * i]! - n.x, pts[2 * i + 1]! - n.y);
      if (d < nearest[i]!) { nearest[i] = d; speedNear[i] = Math.hypot(n.vx, n.vy); }
    }
  }
  return { kind, route, arrivedAt, nearest, speedNear };
}

describe('helm on a route (autopilot, navigation slice 13)', () => {
  it('a fighter flies an L round a corner: passes the corner at speed and stops at the end', async () => {
    const r = await flyRoute('fighter', [0, 1500, 1500, 1500], 40);
    expect(r.arrivedAt).toBeGreaterThan(0);
    expect(r.route.idx).toBe(1);
    // Through the corner, not stopped at it.
    expect(r.speedNear[0]).toBeGreaterThan(r.kind.maxSpeed * 0.3);
    expect(r.nearest[0]).toBeLessThanOrEqual(helmPassRadius(r.kind, r.kind.maxSpeed) * 1.5);
    expect(r.nearest[1]).toBeLessThanOrEqual(helmArriveRadius(r.kind) * 1.5);
  }, 30_000);

  it('a battleship follows a 45° bend and settles on the last point', async () => {
    const r = await flyRoute('battleship', [0, 12000, 8000, 20000], 600);
    expect(r.arrivedAt).toBeGreaterThan(0);
    expect(r.speedNear[0]).toBeGreaterThan(r.kind.maxSpeed * 0.3);
    expect(r.nearest[0]).toBeLessThanOrEqual(helmPassRadius(r.kind, r.kind.maxSpeed) * 1.5);
    expect(r.nearest[1]).toBeLessThanOrEqual(helmArriveRadius(r.kind) * 1.2);
  }, 60_000);

  it('a route with only the goal flies straight, as an order without one', () => {
    const k = getShipKind('fighter');
    const pose = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0 };
    const a = makeHelmOutput(), b = makeHelmOutput();
    helmStep({ active: true, tx: 300, ty: 400, speed: 3 }, pose, k, a);
    helmStep({ active: true, tx: 300, ty: 400, speed: 3, route: { pts: Float64Array.of(300, 400), n: 1, idx: 0 } }, pose, k, b);
    expect(b).toEqual(a);
  });
});
