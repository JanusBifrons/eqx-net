/**
 * Ring geometry and piece output for fractureHull.ts: the output grid
 * (`FRACTURE_QUANTUM`), the edge kinds, quantising, the ring predicates
 * (simplicity, spikes, bounding box) and the `FracturePiece` builder with its
 * convex decomposition. Pure and deterministic under the rules in
 * fractureHull.ts (arithmetic + sqrt/round only, exact on the 1/64 grid).
 */
import decomp from 'poly-decomp';
import type { Vec2 } from '../swarm/asteroidShape.js';
import type { FracturePiece } from './fractureTypes.js';
import { dedupe, ringArea, type P } from './fractureSplit.js';

/** Output grid: every vertex is a multiple of this. */
export const FRACTURE_QUANTUM = 1 / 64;

/** Edge kinds: what made each outline edge (`FracturePiece.cutEdges`).
 *  `EDGE_HULL` (0) is the original hull outline; every other kind is a new
 *  cut, so a kind's truthiness reads as "is a cut". */
export const EDGE_HULL = 0;
export const EDGE_VORONOI = 1;
export const EDGE_SECTION = 2;
export const EDGE_PRIMARY = 3;
/** v6: a crack of the fan or a far crack (jagged like a Voronoi cut). */
export const EDGE_CRACK = 4;
/** v9: a weapon's kill cut (`FractureInput.cut`): the slice line or a
 *  channel wall. Dead straight, like a section cut. */
export const EDGE_CUT = 5;
/** One of the `EDGE_*` kinds above (declared in fractureTypes.ts). */
export type { FractureEdgeKind } from './fractureTypes.js';

// ───────────────────────────── quantise ─────────────────────────────

export function q(v: number): number {
  return Math.round(v / FRACTURE_QUANTUM) * FRACTURE_QUANTUM;
}

export function quantiseRings(rings: P[][], minArea: number): P[][] {
  const out: P[][] = [];
  for (const r of rings) {
    const qr = dedupe(r.map((p) => ({ x: q(p.x), y: q(p.y), k: p.k })));
    const clean = stripSpikes(qr);
    if (clean.length >= 3 && ringArea(clean) > minArea) out.push(clean);
  }
  return out;
}

// ───────────────────────────── piece output ─────────────────────────────

export function toPiece(r: P[]): FracturePiece {
  const outline = r.map((p) => ({ x: p.x, y: p.y }));
  const cutEdges = r.map((p) => p.k);
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i]!;
    const n = outline[(i + 1) % outline.length]!;
    const cr = p.x * n.y - n.x * p.y;
    a2 += cr;
    cx += (p.x + n.x) * cr;
    cy += (p.y + n.y) * cr;
  }
  const area = a2 / 2;
  return {
    outline,
    cutEdges,
    convexParts: convexDecompose(outline, area),
    area,
    centroid: { x: cx / (3 * a2), y: cy / (3 * a2) },
  };
}

function convexDecompose(outline: Vec2[], area: number): Vec2[][] {
  // Strip exactly-collinear vertices (exact on the 1/64 grid).
  const pts: [number, number][] = [];
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const a = outline[(i - 1 + n) % n]!;
    const b = outline[i]!;
    const c = outline[(i + 1) % n]!;
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) !== 0) pts.push([b.x, b.y]);
  }
  if (pts.length >= 3) {
    decomp.makeCCW(pts);
    const parts = decomp.quickDecomp(pts);
    let sum = 0;
    let convex = parts.length > 0;
    for (const part of parts) {
      sum += tupleArea(part);
      if (!isConvexTuples(part)) convex = false;
    }
    if (convex && Math.abs(sum - area) <= Math.abs(area) * 1e-9 + 1e-9) {
      return parts.map((part) => part.map(([x, y]) => ({ x, y })));
    }
  }
  return earClip(outline);
}

/** Fallback: ear clipping (triangles are convex). Exact on the 1/64 grid. */
function earClip(outline: Vec2[]): Vec2[][] {
  const idx: number[] = [];
  for (let i = 0; i < outline.length; i++) idx.push(i);
  const tris: Vec2[][] = [];
  let guard = outline.length * outline.length + 8;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = outline[idx[(i - 1 + idx.length) % idx.length]!]!;
      const b = outline[idx[i]!]!;
      const c = outline[idx[(i + 1) % idx.length]!]!;
      if (orient(a, b, c) <= 0) continue;
      let blocked = false;
      for (let j = 0; j < idx.length && !blocked; j++) {
        const p = outline[idx[j]!]!;
        if (p === a || p === b || p === c) continue;
        if (orient(a, b, p) >= 0 && orient(b, c, p) >= 0 && orient(c, a, p) >= 0) blocked = true;
      }
      if (blocked) continue;
      tris.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: c.x, y: c.y }]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) {
    const [a, b, c] = [outline[idx[0]!]!, outline[idx[1]!]!, outline[idx[2]!]!];
    if (orient(a, b, c) > 0) tris.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: c.x, y: c.y }]);
  }
  return tris;
}

// ───────────────────────────── geometry helpers ─────────────────────────────

export function normaliseHull(hull: ReadonlyArray<readonly [number, number]>): P[] {
  let ring = dedupe(hull.map(([x, y]) => ({ x, y, k: EDGE_HULL })));
  if (ringArea(ring) < 0) ring = ring.reverse();
  return ring;
}

/** Remove zero-width spikes (b where a→b→c folds straight back). */
export function stripSpikes(r: P[]): P[] {
  const pts = r.slice();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const n = pts.length;
      const a = pts[(i - 1 + n) % n]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % n]!;
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
      if (cr === 0 && dot < 0) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
    const d = dedupe(pts);
    if (d.length !== pts.length) {
      pts.length = 0;
      for (const p of d) pts.push(p);
      changed = true;
    }
  }
  return pts;
}

/** v11: every ring holds at least `min` area. */
export function allAtLeast(rings: ReadonlyArray<P[]>, min: number): boolean {
  for (const r of rings) if (ringArea(r) < min) return false;
  return true;
}

function tupleArea(r: ReadonlyArray<readonly [number, number]>): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function isConvexTuples(r: ReadonlyArray<readonly [number, number]>): boolean {
  if (r.length < 3) return false;
  let span = 0;
  for (const p of r) span = Math.max(span, Math.abs(p[0]), Math.abs(p[1]));
  const eps = 1e-9 * span * span;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    const c = r[(i + 2) % r.length]!;
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < -eps) return false;
  }
  return tupleArea(r) > 0;
}

export function ringBox(r: P[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of r) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return [x0, y0, x1, y1];
}

function orient(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segTouch(a: P, b: P, c: P, d: P): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const on = (p: P, s: P, e: P): boolean =>
    Math.min(s.x, e.x) <= p.x && p.x <= Math.max(s.x, e.x) && Math.min(s.y, e.y) <= p.y && p.y <= Math.max(s.y, e.y);
  return (o1 === 0 && on(c, a, b)) || (o2 === 0 && on(d, a, b)) || (o3 === 0 && on(a, c, d)) || (o4 === 0 && on(b, c, d));
}

/** Exact (on the 1/64 grid) simplicity test: no repeated vertex, no
 *  touching non-adjacent edges, positive area. O(n²); n is small. */
export function isSimpleRing(r: P[]): boolean {
  const n = r.length;
  if (n < 3 || ringArea(r) <= 0) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (r[i]!.x === r[j]!.x && r[i]!.y === r[j]!.y) return false;
  }
  for (let i = 0; i < n; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segTouch(a, b, r[j]!, r[(j + 1) % n]!)) return false;
    }
  }
  return true;
}
