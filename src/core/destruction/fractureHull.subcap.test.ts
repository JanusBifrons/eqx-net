/**
 * Sub-capital break-up, slice 1 (plan `subcapital-breakup.md`): the
 * `subcap` destruction profile's fracture on every sub-capital kind's real
 * hull outline (small polygons: a fighter is ~12 u across at 1x), and the
 * capital profile left byte-identical.
 *
 * Owner (2026-11-13): "use the same systems, just make it use less effects,
 * the glow simpler, only a few parts". So: 2-3 pieces, area conserved,
 * simple outlines, convex parts, no slivers.
 */
import { describe, expect, it } from 'vitest';
import { fractureHull, FRACTURE_QUANTUM, type FractureInput, type FracturePiece } from './fractureHull.js';
import { wreckPieceGeometry } from './wreckPieces.js';
import { SHIP_KINDS, SHIP_KINDS_LIST } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { DESTRUCTION_PROFILES, type DestructionFractureOptions } from '../../shared-types/shipScale/destruction.js';
import { shipHullOutline, shipShapeScale } from '../geometry/shipHullOutline.js';

type V = { x: number; y: number };

// ── independent oracles ──

function area(poly: ReadonlyArray<V>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function orient(a: V, b: V, c: V): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segsTouch(a: V, b: V, c: V, d: V): boolean {
  const on = (s: V, e: V, p: V): boolean =>
    Math.min(s.x, e.x) <= p.x && p.x <= Math.max(s.x, e.x) && Math.min(s.y, e.y) <= p.y && p.y <= Math.max(s.y, e.y);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}

function isSimple(poly: ReadonlyArray<V>): boolean {
  const n = poly.length;
  if (n < 3 || area(poly) <= 0) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (poly[i]!.x === poly[j]!.x && poly[i]!.y === poly[j]!.y) return false;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segsTouch(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

function isConvexCcw(poly: ReadonlyArray<V>, scale: number): boolean {
  if (poly.length < 3) return false;
  const eps = 1e-9 * scale * scale;
  for (let i = 0; i < poly.length; i++) {
    if (orient(poly[i]!, poly[(i + 1) % poly.length]!, poly[(i + 2) % poly.length]!) < -eps) return false;
  }
  return area(poly) > 0;
}

/** Least width over every vertex-pair direction (brute force). */
function minWidth(poly: ReadonlyArray<V>): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    for (let j = 0; j < poly.length; j++) {
      const a = poly[i]!;
      const b = poly[j]!;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const el = Math.hypot(ex, ey);
      if (i === j || el === 0) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of poly) {
        const d = (ex * (v.y - a.y) - ey * (v.x - a.x)) / el;
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      best = Math.min(best, hi - lo);
    }
  }
  return best;
}

const SUBCAP_KINDS = SHIP_KINDS_LIST.filter((k) => shipTuning(k).destruction === 'subcap');
const SUB = DESTRUCTION_PROFILES.subcap.fracture!;
const CAP = DESTRUCTION_PROFILES.capital.fracture!;
const VIOLENCE = [0, 0.3, 1, 3] as const;
const SEEDS = 60;

function withProfile(base: FractureInput, o: DestructionFractureOptions): FractureInput {
  return {
    ...base,
    maxPieces: o.maxPieces,
    snapChance: o.snapChance,
    fanCracks: o.fanCracks,
    farCrack: o.farCrack,
    chunkyPieces: o.chunkyPieces,
    chunkyMinWidthBeams: o.chunkyMinWidthBeams,
    extraChunkChance: o.extraChunkChance,
    jag: o.jag,
  };
}

/** Kill points all round the hull: a seeded bearing, out past the hull (the
 *  fracture projects it onto the outline). */
function subcapInput(hull: ReadonlyArray<readonly [number, number]>, seed: number, violence: number): FractureInput {
  let r = 0;
  for (const [x, y] of hull) r = Math.max(r, Math.hypot(x, y));
  const ang = (seed * 2.399963) % (2 * Math.PI);
  return withProfile({
    hull,
    seed: (seed * 7919 + 13) >>> 0,
    killPoint: { x: Math.cos(ang) * r * 2, y: Math.sin(ang) * r * 2 },
    maxPieces: 0,
    hullRadius: r,
    killBlowDamage: violence,
    recentDamageRate: violence,
  }, SUB);
}

describe('sub-capital fracture (destruction profile `subcap`)', () => {
  it('covers every non-capital, non-engineering kind but the cargo pod', () => {
    expect(SUBCAP_KINDS.map((k) => k.id)).toEqual(expect.arrayContaining([
      'fighter', 'scout', 'heavy', 'interceptor', 'gunship', 'missile-frigate', 'patrol-fighter', 'trader-hauler',
      'robot-square', 'robot-circle', 'robot-hexagon', 'robot-nexus', 'robot-harvester',
    ]));
    expect(SUBCAP_KINDS.length).toBeGreaterThanOrEqual(13);
  });

  for (const kind of SUBCAP_KINDS) {
    it(`${kind.id}: 2-3 chunky pieces, area conserved, simple outlines, convex parts, no slivers`, () => {
      const hull = shipHullOutline(kind);
      const hp = hull.map(([x, y]) => ({ x, y }));
      const hullArea = Math.abs(area(hp));
      const hullWidth = minWidth(hp);
      const scale = Math.sqrt(hullArea);
      const counts = new Map<number, number>();
      for (let seed = 0; seed < SEEDS; seed++) {
        for (const v of VIOLENCE) {
          const pieces: FracturePiece[] = fractureHull(subcapInput(hull, seed, v));
          const tag = `${kind.id} seed ${seed} violence ${v}`;
          counts.set(pieces.length, (counts.get(pieces.length) ?? 0) + 1);
          expect(pieces.length, `${tag}: piece count`).toBeGreaterThanOrEqual(2);
          expect(pieces.length, `${tag}: piece count`).toBeLessThanOrEqual(3);
          let sum = 0;
          for (const p of pieces) {
            sum += p.area;
            expect(isSimple(p.outline), `${tag}: simple outline`).toBe(true);
            // On the quantum grid.
            for (const q of p.outline) {
              expect(Math.round(q.x / FRACTURE_QUANTUM) * FRACTURE_QUANTUM).toBe(q.x);
              expect(Math.round(q.y / FRACTURE_QUANTUM) * FRACTURE_QUANTUM).toBe(q.y);
            }
            // Convex parts tile the piece, a handful each (cheap colliders).
            let partSum = 0;
            for (const part of p.convexParts) {
              expect(isConvexCcw(part, scale), `${tag}: convex part`).toBe(true);
              partSum += area(part);
            }
            expect(Math.abs(partSum - p.area), `${tag}: parts tile the piece`).toBeLessThan(1e-6 * hullArea + 1e-9);
            expect(p.convexParts.length, `${tag}: convex parts`).toBeLessThanOrEqual(8);
            // No slivers: a real share of the hull, and not thin.
            expect(p.area / hullArea, `${tag}: piece share`).toBeGreaterThanOrEqual(0.08);
            // 0.3 since the review (2026-11-13: "some pieces are thin strips").
            expect(minWidth(p.outline) / hullWidth, `${tag}: piece width`).toBeGreaterThanOrEqual(0.3);
          }
          // Area conserved, to the 1/64 grid the hull itself snaps to.
          expect(Math.abs(sum - hullArea) / hullArea, `${tag}: area`).toBeLessThan(5e-3);
        }
      }
      // Deterministic: same input, same pieces.
      expect(fractureHull(subcapInput(hull, 7, 1))).toEqual(fractureHull(subcapInput(hull, 7, 1)));
      // Mostly a clean break in two; never more than three.
      expect(counts.get(2) ?? 0).toBeGreaterThan(SEEDS * VIOLENCE.length * 0.5);
    });
  }

  /**
   * Hostile review 2026-11-13 (30-v-30 fleet fight): "the drone pieces have
   * saw-toothed outlines". A clean break in two is a near-straight cut: at
   * most one shallow kink (≤ 2 vertices inside the hull per piece), none
   * further than 5 % of the cut's length off its chord.
   */
  it('a clean break is a near-straight cut, not a saw-tooth (jag roughness)', () => {
    const distToSeg = (p: V, a: V, b: V): number => {
      const ex = b.x - a.x, ey = b.y - a.y;
      const l2 = ex * ex + ey * ey;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2)) : 0;
      return Math.hypot(p.x - a.x - t * ex, p.y - a.y - t * ey);
    };
    let checked = 0;
    for (const kind of SUBCAP_KINDS) {
      const hull = shipHullOutline(kind).map(([x, y]) => ({ x, y }));
      const onHull = (p: V): boolean => {
        for (let i = 0; i < hull.length; i++) if (distToSeg(p, hull[i]!, hull[(i + 1) % hull.length]!) <= 2 * FRACTURE_QUANTUM) return true;
        return false;
      };
      for (let seed = 0; seed < SEEDS; seed++) {
        for (const v of VIOLENCE) {
          const pieces = fractureHull(subcapInput(shipHullOutline(kind), seed, v));
          if (pieces.length !== 2) continue;
          for (const p of pieces) {
            const o = p.outline;
            const inner: number[] = [];
            for (let i = 0; i < o.length; i++) if (!onHull(o[i]!)) inner.push(i);
            const tag = `${kind.id} seed ${seed} violence ${v}`;
            expect(inner.length, `${tag}: vertices inside the hull (jag points)`).toBeLessThanOrEqual(2);
            if (inner.length === 0) continue;
            // The cut's chord: the hull vertices either side of the inner run.
            const n = o.length;
            const a = o[(inner[0]! - 1 + n) % n]!;
            const b = o[(inner[inner.length - 1]! + 1) % n]!;
            const chord = Math.hypot(b.x - a.x, b.y - a.y);
            for (const i of inner) {
              expect(distToSeg(o[i]!, a, b) / chord, `${tag}: jag depth off the chord`).toBeLessThanOrEqual(0.05);
            }
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('sometimes leaves a third chunk on the bigger sub-capitals', () => {
    for (const id of ['trader-hauler', 'missile-frigate', 'gunship', 'fighter'] as const) {
      const hull = shipHullOutline(SHIP_KINDS[id]);
      let three = 0;
      for (let seed = 0; seed < SEEDS; seed++) for (const v of VIOLENCE) if (fractureHull(subcapInput(hull, seed, v)).length === 3) three++;
      expect(three, id).toBeGreaterThan(0);
    }
  });

  it('a fighter wreck at the shipping scale: sane pieces through wreckPieceGeometry', () => {
    for (const kind of SUBCAP_KINDS) {
      const s = shipShapeScale(kind);
      const hull = shipHullOutline(kind);
      const hullAreaWorld = Math.abs(area(hull.map(([x, y]) => ({ x, y })))) * s * s;
      for (let seed = 0; seed < 12; seed++) {
        const kill = { x: hull[seed % hull.length]![0], y: hull[seed % hull.length]![1] };
        const g = wreckPieceGeometry({
          kindId: kind.id, seed, killX: kill.x, killY: kill.y, killBlowDamage: 0.8, recentDamageRate: 0.5, snapChance: SUB.snapChance,
        });
        expect(g.length, kind.id).toBeGreaterThanOrEqual(2);
        expect(g.length, kind.id).toBeLessThanOrEqual(3);
        let a = 0;
        for (const p of g) {
          a += p.area;
          expect(p.mass).toBeGreaterThan(0);
          expect(p.radius).toBeGreaterThan(0);
          expect(p.radius).toBeLessThanOrEqual(2 * kind.radius);
          for (const part of p.parts) expect(isConvexCcw(part, Math.sqrt(hullAreaWorld))).toBe(true);
        }
        expect(Math.abs(a - hullAreaWorld) / hullAreaWorld).toBeLessThan(5e-3);
      }
    }
  });

  it('`none` kinds leave no wreck pieces', () => {
    for (const kind of SHIP_KINDS_LIST.filter((k) => shipTuning(k).destruction === 'none')) {
      const g = wreckPieceGeometry({ kindId: kind.id, seed: 1, killX: 0, killY: 0, killBlowDamage: 1, recentDamageRate: 1, snapChance: 0.2 });
      expect(g, kind.id).toEqual([]);
    }
  });
});

describe('capital fracture is unchanged by the profile options', () => {
  it('the capital profile gives byte-identical pieces to the bare fracture, every capital, many seeds', () => {
    const capitals = SHIP_KINDS_LIST.filter((k) => shipTuning(k).destruction === 'capital');
    expect(capitals.length).toBeGreaterThanOrEqual(15);
    for (const kind of capitals) {
      const hull = shipHullOutline(kind);
      for (let seed = 0; seed < 6; seed++) {
        const k = hull[(seed * 5) % hull.length]!;
        const bare: FractureInput = {
          hull, seed: seed * 104729 + 1, killPoint: { x: k[0], y: k[1] }, maxPieces: 64,
          killBlowDamage: seed * 0.4, recentDamageRate: seed * 0.3,
        };
        expect(fractureHull(withProfile(bare, CAP)), `${kind.id} seed ${seed}`).toEqual(fractureHull(bare));
      }
    }
  });
});
