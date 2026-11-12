/**
 * Capitals collide solidly; fighters are untouched (owner decision 2026-11-12,
 * verbatim: "They absolutely should collide by design.").
 *
 * Measured on main before the fix (this file's history):
 *  - Two heavy cruisers posed 350 u deep stayed 349 u deep for 6 s: Rapier's
 *    contact between two multi-thousand-unit convex hulls vanishes at depth
 *    (the narrow phase reports `numContacts() === 0` from the second step on,
 *    while a 100× smaller copy of the same hull resolves), so nothing pushed.
 *  - Where a contact survives, Rapier's position correction is capped at
 *    `normalized max corrective velocity × lengthUnit` ≈ 10 u/s per contact,
 *    and the bodies fall asleep partway (a 350 u box overlap: 2 s → 332 u).
 *
 * The fighter half pins Rapier's GLOBAL parameters and a fighter ram's exact
 * trajectory, so the capital fix can't have been a global solver change.
 */
import { describe, it, expect } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from './World.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { massOf } from '../../shared-types/shipScale/tuning.js';
import { shipCollisionParts } from '../geometry/shipHullDecomp.js';

type V = { x: number; y: number };
type Pose = { x: number; y: number; angle: number };

function worldParts(kind: string, p: Pose): V[][] {
  const c = Math.cos(p.angle), s = Math.sin(p.angle);
  return shipCollisionParts(kind).map((part) => part.map((v) => ({ x: p.x + v.x * c - v.y * s, y: p.y + v.x * s + v.y * c })));
}

/** SAT penetration depth of two convex polygons (0 when separated). */
function penetration(a: V[], b: V[]): number {
  let min = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
      let nx = -(q.y - p.y), ny = q.x - p.x;
      const len = Math.hypot(nx, ny);
      if (len === 0) continue;
      nx /= len; ny /= len;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const v of a) { const d = v.x * nx + v.y * ny; aMin = Math.min(aMin, d); aMax = Math.max(aMax, d); }
      for (const v of b) { const d = v.x * nx + v.y * ny; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d); }
      const o = Math.min(aMax, bMax) - Math.max(aMin, bMin);
      if (o <= 0) return 0;
      min = Math.min(min, o);
    }
  }
  return min;
}

function hullPen(pw: PhysicsWorld, a: string, ka: string, b: string, kb: string): number {
  const sa = pw.getShipState(a)!, sb = pw.getShipState(b)!;
  let worst = 0;
  for (const pa of worldParts(ka, sa)) for (const pb of worldParts(kb, sb)) worst = Math.max(worst, penetration(pa, pb));
  return worst;
}

function spawnNpcCapital(pw: PhysicsWorld, id: string, kindId: string, x: number, y: number, angle: number): void {
  const k = getShipKind(kindId);
  pw.spawnObstacle(id, x, y, k.radius, massOf(k, 1), undefined, k.linearDamping, undefined, undefined, k);
  pw.setShipState(id, { x, y, angle, vx: 0, vy: 0, angvel: 0 });
}

const SLOP = 30;
const THRUST = { thrust: true, boost: true, turnLeft: false, turnRight: false };

describe('capitals collide solidly', () => {
  it('two capitals posed 350 u deep separate within 2 s (shields up)', async () => {
    const pw = await PhysicsWorld.create();
    pw.spawnShip('a', 0, 0, 'heavy-cruiser');
    pw.spawnShip('b', 0, -2500, 'heavy-cruiser');
    const start = hullPen(pw, 'a', 'heavy-cruiser', 'b', 'heavy-cruiser');
    expect(start).toBeGreaterThan(300);
    for (let t = 0; t < 120; t++) pw.tick(1 / 60);
    const end = hullPen(pw, 'a', 'heavy-cruiser', 'b', 'heavy-cruiser');
    expect(end, `${start.toFixed(0)} u → ${end.toFixed(0)} u`).toBeLessThan(SLOP);
  });

  it('two capitals posed deep separate within 2 s (shields down, hull triangles)', async () => {
    const pw = await PhysicsWorld.create();
    const k = getShipKind('heavy-cruiser');
    pw.spawnShip('a', 0, 0, 'heavy-cruiser');
    pw.spawnShip('b', 0, -2500, 'heavy-cruiser');
    pw.setHullExposed('a', true, k);
    pw.setHullExposed('b', true, k);
    for (let t = 0; t < 120; t++) pw.tick(1 / 60);
    expect(hullPen(pw, 'a', 'heavy-cruiser', 'b', 'heavy-cruiser')).toBeLessThan(SLOP);
  });

  it('a pilot cruiser and an NPC battleship rammed bow to bow: thrust cannot hold it in, it is pushed out', async () => {
    const pw = await PhysicsWorld.create();
    spawnNpcCapital(pw, 'bs', 'battleship', 0, 0, Math.PI);
    pw.spawnShip('hc', 0, -3930, 'heavy-cruiser');
    const start = hullPen(pw, 'hc', 'heavy-cruiser', 'bs', 'battleship');
    expect(start).toBeGreaterThan(150);
    let worst = 0;
    for (let t = 0; t < 180; t++) {
      pw.applyInput('hc', THRUST);
      pw.tick(1 / 60);
      worst = Math.max(worst, hullPen(pw, 'hc', 'heavy-cruiser', 'bs', 'battleship'));
    }
    const end = hullPen(pw, 'hc', 'heavy-cruiser', 'bs', 'battleship');
    expect(worst).toBeLessThanOrEqual(start + 1);
    expect(end, `${start.toFixed(0)} u → ${end.toFixed(0)} u under thrust`).toBeLessThan(SLOP);
  });

  it('a capital under full thrust into a parked capital stops at contact (no overlap ever)', async () => {
    const pw = await PhysicsWorld.create();
    spawnNpcCapital(pw, 'bs', 'battleship', 0, 0, 0);
    pw.spawnShip('hc', 0, -5600, 'heavy-cruiser');
    pw.setShipState('hc', { x: 0, y: -5600, angle: 0, vx: 0, vy: 160, angvel: 0 });
    let worst = 0;
    for (let t = 0; t < 600; t++) {
      pw.applyInput('hc', THRUST);
      pw.tick(1 / 60);
      worst = Math.max(worst, hullPen(pw, 'hc', 'heavy-cruiser', 'bs', 'battleship'));
    }
    expect(pw.getShipState('bs')!.y, 'the ram really reached the battleship').toBeGreaterThan(10);
    expect(worst).toBeLessThan(SLOP);
  });
});

describe('fighters are unchanged by the capital fix', () => {
  it('Rapier global solver parameters stay at their defaults', async () => {
    const pw = await PhysicsWorld.create();
    const ip = (pw as unknown as { world: RAPIER.World }).world.integrationParameters;
    expect(ip.dt).toBeCloseTo(1 / 60, 6);
    expect(ip.lengthUnit).toBe(1);
    expect(ip.normalizedAllowedLinearError).toBeCloseTo(0.001, 9);
    expect(ip.normalizedPredictionDistance).toBeCloseTo(0.002, 9);
    expect(ip.numSolverIterations).toBe(4);
  });

  it('a fighter ramming an asteroid and a fighter follows the exact pre-fix trajectory', async () => {
    const pw = await PhysicsWorld.create();
    pw.spawnShip('f1', 0, 0, 'fighter');
    pw.spawnShip('f2', 0, 260, 'fighter');
    pw.spawnObstacle('rock', 30, 520, 40, 30);
    // A capital far away: its presence must not change the fighters at all.
    spawnNpcCapital(pw, 'far', 'battleship', 50_000, 0, 0);
    for (let t = 0; t < 360; t++) {
      pw.applyInput('f1', THRUST);
      pw.tick(1 / 60);
    }
    const f1 = pw.getShipState('f1')!, f2 = pw.getShipState('f2')!, rock = pw.getShipState('rock')!;
    const got = [f1.x, f1.y, f1.vx, f1.vy, f1.angle, f2.x, f2.y, f2.vx, f2.vy, rock.x, rock.y, rock.vx, rock.vy].map((v) => Number(v.toFixed(4)));
    expect(got).toEqual(FIGHTER_GOLDEN);
  });
});

/** Recorded on origin/main 4acf52bc (before the capital fix). */
const FIGHTER_GOLDEN = [-20.1346, 717.9221, -6.0342, 212.2417, 0, -144.1048, 605.6046, -41.3006, 48.4329, 91.3277, 662.3862, 30.1318, 62.6111];
