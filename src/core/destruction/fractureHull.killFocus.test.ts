/**
 * Kill-point focus (capital-destruction.md, "Kill point and drift fixes").
 * Hostile review of a filmed heavy-cruiser death (a 16" salvo, 5,600 damage
 * on a 4,018-hull ship): shells hit mid-hull, yet the cracks spread over
 * ~60 % of the hull's length, a long sliver ran down the bow and the bow tip
 * split lengthwise into a "tuning fork". Owner: "The impact location of the
 * last hit should play a huge role in where it splits": the shatter must be
 * densest at the kill point, and cuts must run across the hull, not along it.
 */
import { describe, expect, it } from 'vitest';
import { fractureHull, fracturePlan, FRACTURE_MAX_PIECES, type FracturePiece } from './fractureHull.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipHullOutline } from '../geometry/shipHullOutline.js';

type V = { x: number; y: number };

const hull = shipHullOutline(getShipKind('heavy-cruiser'));
const pts = hull.map(([x, y]) => ({ x, y }));
let minY = Infinity;
let maxY = -Infinity;
for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
const L = maxY - minY;

/** A point on the port edge `frac` of the length aft of the bow. */
function sidePoint(frac: number): V {
  const y = minY + frac * L;
  let x = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) {
      const xi = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (xi < x) x = xi;
    }
  }
  return { x, y };
}

/** Hull beam (both edges) at station y. */
function widthAt(y: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) {
      const xi = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
      lo = Math.min(lo, xi);
      hi = Math.max(hi, xi);
    }
  }
  return hi > lo ? hi - lo : 0;
}

/** Hull area between stations y0 and y1 (midpoint rule). */
function bandArea(y0: number, y1: number): number {
  const n = 64;
  let s = 0;
  for (let i = 0; i < n; i++) s += widthAt(y0 + ((i + 0.5) * (y1 - y0)) / n);
  return (s * (y1 - y0)) / n;
}

function area(poly: ReadonlyArray<V>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** The filmed death (5,600 on 4,018 hull after a 4,200 hit) down to a grind. */
const LEVELS: ReadonlyArray<readonly [string, number, number]> = [
  ['filmed salvo', 1.39, 2.4],
  ['heavy', 0.5, 0.9],
  ['medium', 0.15, 0.35],
  ['light', 0.05, 0.1],
];
const SEEDS = 30;

function shatter(seed: number, frac: number, kb: number, rr: number): { pieces: FracturePiece[]; kill: V } {
  const input = { hull, seed, killPoint: sidePoint(frac), maxPieces: FRACTURE_MAX_PIECES, killBlowDamage: kb, recentDamageRate: rr, snapChance: 0 };
  return { pieces: fractureHull(input), kill: fracturePlan(input).killPoint };
}

interface Stats { near: number; along: number; sliver: number; pieces: number }

/** Over a seed sweep of mid-hull side hits: the share of new cut length
 *  within 20 % of the length of the kill point, the share of cut length
 *  running along the keel, the worst long sliver (share of the beam it misses over its span) and
 *  the mean piece count. */
function stats(kb: number, rr: number): Stats {
  let near = 0;
  let along = 0;
  let all = 0;
  let sliver = 0;
  let pieces = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const frac = 0.35 + (0.3 * ((seed * 7) % 10)) / 10;
    const { pieces: ps, kill } = shatter(seed, frac, kb, rr);
    pieces += ps.length;
    for (const p of ps) {
      const o = p.outline;
      for (let i = 0; i < o.length; i++) {
        if (!p.cutEdges[i]) continue;
        const a = o[i]!;
        const b = o[(i + 1) % o.length]!;
        const dx = Math.abs(b.x - a.x);
        const dy = Math.abs(b.y - a.y);
        const len = Math.hypot(dx, dy);
        all += len;
        if (dy > 2 * dx) along += len;
        if (Math.abs((a.y + b.y) / 2 - kill.y) <= 0.2 * L) near += len;
      }
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const v of o) { y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
      const len = y1 - y0;
      // A sliver: long, and covering little of the hull's own beam over its
      // span (a full-width end piece covers ~all of it).
      if (len > 0.15 * L) sliver = Math.max(sliver, 1 - area(o) / bandArea(y0, y1));
    }
  }
  return { near: near / all, along: along / all, sliver, pieces: pieces / SEEDS };
}

describe('fracture: the shatter is focused on the kill point', () => {
  it('the hull is long and thin (the case the review filmed)', () => {
    expect(L).toBeGreaterThan(5 * (Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x))));
  });

  it.each(LEVELS)('%s: cracks cluster at the kill point and run across the hull', (_name, kb, rr) => {
    const s = stats(kb, rr);
    console.log(`[kill focus] ${_name}: ${s.pieces.toFixed(1)} pieces, cut length within 20 % L ${(100 * s.near).toFixed(0)} %, lengthwise ${(100 * s.along).toFixed(0)} %, worst long piece misses ${(100 * s.sliver).toFixed(0)} % of its beam`);
    expect(s.near, 'share of new cut length within 20 % of the length of the kill point').toBeGreaterThan(0.82);
    expect(s.along, 'share of new cut length running along the keel').toBeLessThan(0.1);
    expect(s.sliver, 'no long piece is a lengthwise sliver (covers little of the beam over its span)').toBeLessThan(0.35);
  });
});
