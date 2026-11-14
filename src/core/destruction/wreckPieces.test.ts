/**
 * Capital destruction S2a: the pure death → wreck-piece builder.
 * Pieces tile the live hull collider in world space, carry mass ∝ area at the
 * ship's density, inherit the hull's rigid-body velocity plus an outward push
 * from the kill point, and the kill point used is on the hull outline.
 */
import { describe, expect, it } from 'vitest';
import {
  buildWreckPieces, hullLocalKillPoint, wreckPieceGeometry,
  WRECK_SPIN_MIN_RADIUS_FRAC, WRECK_SPIN_RIM_FAR, WRECK_SPIN_RIM_NEAR, type WreckBuildInput,
} from './wreckPieces.js';
import { shipShapeToPolygon } from '../geometry/shipHullDecomp.js';
import { shipHullOutline } from '../geometry/shipHullOutline.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { massOf, shipTuning } from '../../shared-types/shipScale/tuning.js';
import { FRACTURE_QUANTUM } from './fractureHull.js';

type V = { x: number; y: number };

function signedArea(poly: ReadonlyArray<V>): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function pointIn(poly: ReadonlyArray<V>, p: V): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToOutline(poly: ReadonlyArray<V>, p: V): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y));
  }
  return best;
}

const pose = { x: 5000, y: -3000, vx: 12, vy: -4, angle: 0.7, angvel: 0.05 };

function input(extra: Partial<WreckBuildInput> = {}): WreckBuildInput {
  return {
    kindId: 'battleship', pose, killWorld: null, attackerWorld: { x: 9000, y: -3000 },
    seed: 77, killBlowDamage: 1, recentDamageRate: 1, ...extra,
  };
}

/** The live collider polygon in world space (math-up local → rotate → move). */
function worldHull(kindId: 'battleship' | 'heavy-cruiser'): V[] {
  const c = Math.cos(pose.angle);
  const s = Math.sin(pose.angle);
  return shipShapeToPolygon(getShipKind(kindId)).map((v) => ({ x: pose.x + v.x * c - v.y * s, y: pose.y + v.x * s + v.y * c }));
}

function toWorld(px: { x: number; y: number; angle: number }, v: V): V {
  const c = Math.cos(px.angle);
  const s = Math.sin(px.angle);
  return { x: px.x + v.x * c - v.y * s, y: px.y + v.x * s + v.y * c };
}

describe('buildWreckPieces', () => {
  it('pieces tile the hull: N ≥ 2, total area = hull area, every part CCW and inside the world hull', () => {
    for (const kindId of ['battleship', 'heavy-cruiser'] as const) {
      const { pieces } = buildWreckPieces(input({ kindId }));
      expect(pieces.length).toBeGreaterThanOrEqual(2);
      const hull = worldHull(kindId);
      const want = Math.abs(signedArea(hull));
      let sum = 0;
      for (const p of pieces) {
        sum += p.area;
        let partArea = 0;
        for (const part of p.parts) {
          expect(signedArea(part)).toBeGreaterThan(0); // CCW in math-up
          partArea += signedArea(part);
          // The part's centre (in world) lies inside the live hull polygon.
          let cx = 0;
          let cy = 0;
          for (const v of part) { cx += v.x; cy += v.y; }
          const w = toWorld(p, { x: cx / part.length, y: cy / part.length });
          expect(pointIn(hull, w) || distToOutline(hull, w) < 1).toBe(true);
          for (const v of part) expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(p.radius + 1e-9);
        }
        expect(Math.abs(partArea - p.area) / p.area).toBeLessThan(1e-6);
      }
      expect(Math.abs(sum - want) / want).toBeLessThan(0.005);
    }
  });

  it('mass ∝ area at the ship density; the total is the ship mass', () => {
    const { pieces } = buildWreckPieces(input());
    const kind = getShipKind('battleship');
    let m = 0;
    for (const p of pieces) m += p.mass;
    expect(Math.abs(m - massOf(kind, 1)) / massOf(kind, 1)).toBeLessThan(0.01);
    const d0 = pieces[0]!.mass / pieces[0]!.area;
    for (const p of pieces) expect(p.mass / p.area).toBeCloseTo(d0, 9);
  });

  it('spawn velocity is the hull rigid motion (v + ω × r, ω): the hull holds together until the crack delay', () => {
    const b = buildWreckPieces(input({ killWorld: { x: pose.x + 200, y: pose.y + 100 } }));
    for (const p of b.pieces) {
      const rx = p.x - pose.x;
      const ry = p.y - pose.y;
      expect(p.vx).toBeCloseTo(pose.vx - pose.angvel * ry, 9);
      expect(p.vy).toBeCloseTo(pose.vy + pose.angvel * rx, 9);
      expect(p.angvel).toBe(pose.angvel);
      expect(p.angle).toBe(pose.angle);
    }
  });

  it('the kick is slow and heavy: away from the kill point on the whole, size-scaled push and slow spin', () => {
    for (const kindId of ['battleship', 'heavy-cruiser'] as const) {
      const kind = getShipKind(kindId);
      const t = shipTuning(kind);
      const b = buildWreckPieces(input({ kindId, killWorld: { x: pose.x + 200, y: pose.y + 100 } }));
      let outward = 0;
      for (const p of b.pieces) {
        const ox = p.x - b.killWorldOnHull.x;
        const oy = p.y - b.killWorldOnHull.y;
        if ((p.kickVx * ox + p.kickVy * oy) > 0) outward++;
        // Bounded: the push plus the seam-parting corrections stay slow.
        expect(Math.hypot(p.kickVx, p.kickVy)).toBeLessThan(2 * (t.wreckPushMax * 1.25) + 4 * t.wreckSeparate);
        // Rim speed at most WRECK_SPIN_RIM_NEAR × wreckSeparate.
        const r = Math.max(p.radius, WRECK_SPIN_MIN_RADIUS_FRAC * kind.radius);
        expect(Math.abs(p.kickAngvel) * r).toBeLessThanOrEqual(WRECK_SPIN_RIM_NEAR * t.wreckSeparate + 1e-9);
        expect(Math.abs(p.kickAngvel) * r).toBeGreaterThanOrEqual(0.55 * WRECK_SPIN_RIM_FAR * t.wreckSeparate - 1e-9);
      }
      expect(outward / b.pieces.length).toBeGreaterThan(0.8);
    }
  });

  it('every pair of neighbours parts along its shared cut at both ends (no slide-over, no hinge)', () => {
    for (const seed of [1, 7, 77, 123, 999]) {
      for (const kindId of ['battleship', 'heavy-cruiser'] as const) {
        const t = shipTuning(getShipKind(kindId));
        const { pieces, fracture } = buildWreckPieces(input({ kindId, seed, killBlowDamage: 1.5, recentDamageRate: 1.5 }));
        const geom = wreckPieceGeometry(fracture);
        const c = Math.cos(pose.angle);
        const s = Math.sin(pose.angle);
        let seams = 0;
        for (let i = 0; i < geom.length; i++) {
          for (let j = i + 1; j < geom.length; j++) {
            const gi = geom[i]!, gj = geom[j]!;
            for (let a = 0; a < gi.outline.length; a++) {
              if (!gi.cutEdges[a]) continue;
              const p0 = { x: gi.outline[a]!.x + gi.cx, y: gi.outline[a]!.y + gi.cy };
              const p1n = gi.outline[(a + 1) % gi.outline.length]!;
              const p1 = { x: p1n.x + gi.cx, y: p1n.y + gi.cy };
              const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
              if (len < 1) continue;
              const nx = (p1.y - p0.y) / len, ny = -(p1.x - p0.x) / len;
              const ux = (p1.x - p0.x) / len, uy = (p1.y - p0.y) / len;
              // Cut edges of j on this edge's line: the shared stretch.
              for (let bI = 0; bI < gj.outline.length; bI++) {
                if (!gj.cutEdges[bI]) continue;
                const q0 = gj.outline[bI]!, q1 = gj.outline[(bI + 1) % gj.outline.length]!;
                const ax = q0.x + gj.cx - p0.x, ay = q0.y + gj.cy - p0.y;
                const bx = q1.x + gj.cx - p0.x, by = q1.y + gj.cy - p0.y;
                if (Math.abs(ax * nx + ay * ny) > 0.05 || Math.abs(bx * nx + by * ny) > 0.05) continue;
                const s0 = Math.max(0, Math.min(ax * ux + ay * uy, bx * ux + by * uy));
                const s1 = Math.min(len, Math.max(ax * ux + ay * uy, bx * ux + by * uy));
                if (s1 - s0 < 1) continue;
                seams++;
                const pi = pieces[i]!, pj = pieces[j]!;
                // Ship-frame kick of each piece (undo the world turn).
                const kv = (p: typeof pi): V => ({ x: p.kickVx * c + p.kickVy * s, y: -p.kickVx * s + p.kickVy * c });
                const vi = kv(pi), vj = kv(pj);
                for (const sAt of [s0, s1]) {
                  const p = { x: p0.x + ux * sAt, y: p0.y + uy * sAt };
                  const rvx = (vj.x - pj.kickAngvel * (p.y - gj.cy)) - (vi.x - pi.kickAngvel * (p.y - gi.cy));
                  const rvy = (vj.y + pj.kickAngvel * (p.x - gj.cx)) - (vi.y + pi.kickAngvel * (p.x - gi.cx));
                  // Opens at wreckSeparate or more at each end of the shared stretch.
                  expect(rvx * nx + rvy * ny, `${kindId} seed ${seed} pieces ${i}/${j}`).toBeGreaterThan(0.99 * t.wreckSeparate);
                }
              }
            }
          }
        }
        expect(seams).toBeGreaterThan(0);
      }
    }
  });

  it('collider parts are the drawn parts shrunk by wreckColliderInset', () => {
    const kind = getShipKind('heavy-cruiser');
    const inset = shipTuning(kind).wreckColliderInset;
    const { pieces } = buildWreckPieces(input({ kindId: 'heavy-cruiser' }));
    for (const p of pieces) {
      expect(p.colliderParts.length).toBe(p.parts.length);
      for (let k = 0; k < p.parts.length; k++) {
        const a = p.parts[k]!, b = p.colliderParts[k]!;
        expect(b.length).toBe(a.length);
        for (let v = 0; v < a.length; v++) expect(Math.hypot(a[v]!.x - b[v]!.x, a[v]!.y - b[v]!.y)).toBeLessThanOrEqual(inset + 1e-9);
      }
    }
  });

  it('the kill point is on the hull outline, nearest the hit / attacker', () => {
    const outline = shipHullOutline(getShipKind('battleship')).map(([x, y]) => ({ x, y }));
    for (const killWorld of [{ x: pose.x, y: pose.y }, { x: pose.x + 3000, y: pose.y }, null]) {
      const b = buildWreckPieces(input({ killWorld }));
      expect(distToOutline(outline, b.killLocal)).toBeLessThanOrEqual(FRACTURE_QUANTUM);
      expect(distToOutline(worldHull('battleship'), b.killWorldOnHull)).toBeLessThan(0.1);
    }
    // A world point ON the hull edge maps back to itself.
    const edge = worldHull('battleship')[5]!;
    const k = hullLocalKillPoint('battleship', pose, edge);
    const b = buildWreckPieces(input({ killWorld: edge }));
    expect(Math.hypot(b.killWorldOnHull.x - edge.x, b.killWorldOnHull.y - edge.y)).toBeLessThan(0.1);
    expect(b.killLocal).toEqual(k);
  });

  it('a heavier final hit breaks into more pieces than a slow grind (same seed)', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const grind = buildWreckPieces(input({ seed, killBlowDamage: 0.001, recentDamageRate: 0.002 })).pieces.length;
      const heavy = buildWreckPieces(input({ seed, killBlowDamage: 2, recentDamageRate: 2 })).pieces.length;
      expect(heavy).toBeGreaterThanOrEqual(grind);
    }
  });

  it('is deterministic', () => {
    expect(buildWreckPieces(input())).toEqual(buildWreckPieces(input()));
  });
});
