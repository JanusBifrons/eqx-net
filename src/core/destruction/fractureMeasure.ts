/**
 * Hull measures for fractureHull.ts: the kill point projected onto the
 * outline, the keel axis and beam, ring centroids, the area split of a line
 * and the v7 chunky guard (least width and aspect). Pure and deterministic
 * under the rules in fractureHull.ts (arithmetic + sqrt only, fixed order).
 */
import type { Vec2 } from '../swarm/asteroidShape.js';
import { ringArea, splitByLine, type P } from './fractureSplit.js';
import { EDGE_PRIMARY, q } from './fractureRings.js';

/** v7: a fan crack is dropped where it would leave a part narrower than
 *  this (beams) or longer than FAN_MAX_ASPECT × its width (filmed take
 *  2026-11-13: a long thin triangle along the hull's edge). */
export const FAN_MIN_WIDTH_BEAMS = 0.45;
export const FAN_MAX_ASPECT = 2.6;

/** Nearest point on the ring's edges to (x, y), snapped to the quantum. */
export function projectRing(hull: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): Vec2 {
  let bestD = Infinity;
  let bx = x;
  let by = y;
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % n]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const l2 = ex * ex + ey * ey;
    let t = l2 > 0 ? ((x - a.x) * ex + (y - a.y) * ey) / l2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = a.x + ex * t;
    const py = a.y + ey * t;
    const d = (px - x) * (px - x) + (py - y) * (py - y);
    if (d < bestD) {
      bestD = d;
      bx = px;
      by = py;
    }
  }
  return { x: q(bx), y: q(by) };
}

/** The smaller share (0..0.5) of the hull's area on either side of the line
 *  through `p` along unit (dx, dy). */
export function minSideFrac(hull: P[], p: Vec2, dx: number, dy: number): number {
  const total = ringArea(hull);
  if (total <= 0) return 0;
  const nx = -dy;
  const ny = dx;
  let a = 0;
  for (const part of splitByLine(hull, nx, ny, nx * p.x + ny * p.y, EDGE_PRIMARY)) a += ringArea(part);
  const f = a / total;
  return f < 0.5 ? f : 1 - f;
}

/** Unit direction of the hull's long axis: the major eigenvector of the
 *  vertex covariance (closed form, sqrt only). */
export function keelAxis(hull: P[]): Vec2 {
  let mx = 0;
  let my = 0;
  for (const p of hull) {
    mx += p.x;
    my += p.y;
  }
  mx /= hull.length;
  my /= hull.length;
  let a = 0;
  let b = 0;
  let c = 0;
  for (const p of hull) {
    const dx = p.x - mx;
    const dy = p.y - my;
    a += dx * dx;
    b += dx * dy;
    c += dy * dy;
  }
  const h = (a - c) / 2;
  const lam = (a + c) / 2 + Math.sqrt(h * h + b * b);
  // Two candidate eigenvectors; take the better-conditioned one.
  const v1x = b;
  const v1y = lam - a;
  const v2x = lam - c;
  const v2y = b;
  const n1 = v1x * v1x + v1y * v1y;
  const n2 = v2x * v2x + v2y * v2y;
  if (n1 === 0 && n2 === 0) return { x: 0, y: 1 };
  if (n1 >= n2) {
    const l = Math.sqrt(n1);
    return { x: v1x / l, y: v1y / l };
  }
  const l = Math.sqrt(n2);
  return { x: v2x / l, y: v2y / l };
}

export function ringCentroid(r: ReadonlyArray<{ x: number; y: number }>): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const q2 = r[(i + 1) % r.length]!;
    const w = p.x * q2.y - q2.x * p.y;
    a += w;
    cx += (p.x + q2.x) * w;
    cy += (p.y + q2.y) * w;
  }
  return a === 0 ? { x: r[0]!.x, y: r[0]!.y } : { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Full beam of the hull: its extent across the keel. */
export function hullBeam(hull: P[], keel: Vec2): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of hull) {
    const c = p.y * keel.x - p.x * keel.y;
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  return hi - lo;
}

/** A fan crack's part is chunky when its least width (rotating calipers over
 *  its convex hull's edges) is at least FAN_MIN_WIDTH_BEAMS of the beam and
 *  its length along that edge is at most FAN_MAX_ASPECT × the width.
 *  Arithmetic and sqrt only, fixed order (deterministic). */
export function isChunky(
  ring: ReadonlyArray<{ x: number; y: number }>, beam: number, minWidthBeams = FAN_MIN_WIDTH_BEAMS, maxAspect = FAN_MAX_ASPECT,
): boolean {
  const ch = convexHullOf(ring);
  if (ch.length < 3) return false;
  let bestW = Infinity;
  let bestL = 0;
  for (let i = 0; i < ch.length; i++) {
    const a = ch[i]!;
    const b = ch[(i + 1) % ch.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const el = Math.sqrt(ex * ex + ey * ey);
    if (el <= 0) continue;
    let w = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of ch) {
      const d = Math.abs(ex * (v.y - a.y) - ey * (v.x - a.x)) / el;
      if (d > w) w = d;
      const t = (ex * (v.x - a.x) + ey * (v.y - a.y)) / el;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    if (w < bestW) {
      bestW = w;
      bestL = hi - lo;
    }
  }
  return bestW >= minWidthBeams * beam && bestL <= maxAspect * bestW;
}

export function allChunky(rings: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>, beam: number, minWidthBeams: number): boolean {
  for (const r of rings) if (!isChunky(r, beam, minWidthBeams)) return false;
  return true;
}

/** Convex hull (Andrew's monotone chain), CCW, collinear points dropped. */
function convexHullOf(ring: ReadonlyArray<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const pts = ring.map((p) => ({ x: p.x, y: p.y })).sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  if (pts.length < 3) return pts;
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Array<{ x: number; y: number }> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
