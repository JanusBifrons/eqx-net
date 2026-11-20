/**
 * "Bundle on the curve" — the polyline walker the cable line look
 * (`connectorLineLooks.ts`) is laid along. One walker for both a straight
 * centre-to-centre edge (a 2-point path) and a socket cable's stud-to-stud
 * curve: every station and strand of the look is placed by arc length on
 * the path, square to the local tangent. On a 2-point path the arithmetic is
 * exactly the pre-curve straight drawer's (`connectorLineLooks.path.test.ts`).
 *
 * Allocation-free (invariant #14): module scratch, written per call.
 */
import type { LinePath } from './connectorLineLooks.js';

/** A polyline with its arc lengths (Pixi space): a socket cable's flattened
 *  curve (`LinkCable`), or a straight edge as 2 points. */
export interface CablePath { readonly poly: Float64Array; readonly cum: Float64Array; n: number; len: number }

const _edge: CablePath = { poly: new Float64Array(4), cum: new Float64Array(2), n: 2, len: 0 };
/** The path the cable helpers below walk (set by each cable entry point). */
let _p: CablePath = _edge;

/** The path being walked. */
export function cablePath(): CablePath { return _p; }

/** Walk `path` from now on (the cable look's entry points). */
export function setCablePath(path: CablePath): void { _p = path; }

/** The walker's outputs: the local frame (`frameAt`) — the segment holding
 *  arc length t as a virtual origin (ox, oy) (origin + u*t = the point at t),
 *  unit tangent (ux, uy) and normal (nx, ny) — and the last point (`pt`,
 *  `vertex`) at (px, py). */
export const W = { ox: 0, oy: 0, ux: 1, uy: 0, nx: 0, ny: 1, px: 0, py: 0 };

export function edgePath(ax: number, ay: number, bx: number, by: number, len: number): CablePath {
  const p = _edge.poly;
  p[0] = ax; p[1] = ay; p[2] = bx; p[3] = by;
  _edge.cum[0] = 0; _edge.cum[1] = len; _edge.len = len;
  return _edge;
}

export function frameAt(t: number): void {
  const p = _p.poly, cum = _p.cum;
  let j = 1;
  while (j < _p.n - 1 && cum[j]! < t) j++;
  const d = cum[j]! - cum[j - 1]!;
  if (!(d > 0)) return; // a zero-length segment keeps the last frame
  W.ux = (p[j * 2]! - p[j * 2 - 2]!) / d;
  W.uy = (p[j * 2 + 1]! - p[j * 2 - 1]!) / d;
  W.nx = -W.uy;
  W.ny = W.ux;
  W.ox = p[j * 2 - 2]! - W.ux * cum[j - 1]!;
  W.oy = p[j * 2 - 1]! - W.uy * cum[j - 1]!;
}

/** The point at arc length `t`, `o` along the local normal. */
export function pt(t: number, o: number): void {
  frameAt(t);
  W.px = W.ox + W.ux * t + W.nx * o;
  W.py = W.oy + W.uy * t + W.ny * o;
}

/** Interior vertex `i`, `o` along its mitred normal (so offset runs on the
 *  two segments meet there). */
export function vertex(i: number, o: number): void {
  const p = _p.poly, cum = _p.cum;
  const d0 = cum[i]! - cum[i - 1]!, d1 = cum[i + 1]! - cum[i]!;
  let mx: number, my: number;
  if (d0 > 0 && d1 > 0) {
    const n0x = -(p[i * 2 + 1]! - p[i * 2 - 1]!) / d0, n0y = (p[i * 2]! - p[i * 2 - 2]!) / d0;
    const n1x = -(p[i * 2 + 3]! - p[i * 2 + 1]!) / d1, n1y = (p[i * 2 + 2]! - p[i * 2]!) / d1;
    const s = 1 / Math.max(0.5, 1 + n0x * n1x + n0y * n1y);
    mx = (n0x + n1x) * s; my = (n0y + n1y) * s;
  } else {
    frameAt(cum[i]!);
    mx = W.nx; my = W.ny;
  }
  W.px = p[i * 2]! + mx * o;
  W.py = p[i * 2 + 1]! + my * o;
}

/** The path between arc lengths `s0` <= `s1`, `o` along the normal, shifted
 *  (`ox`, `oy`). */
export function along(g: LinePath, s0: number, s1: number, o: number, ox: number, oy: number): void {
  pt(s0, o); g.moveTo(W.px + ox, W.py + oy);
  for (let i = 1; i < _p.n - 1; i++) {
    const c = _p.cum[i]!;
    if (c <= s0) continue;
    if (c >= s1) break;
    vertex(i, o); g.lineTo(W.px + ox, W.py + oy);
  }
  pt(s1, o); g.lineTo(W.px + ox, W.py + oy);
}

/** The path's own points, unshifted. */
export function rawPath(g: LinePath): void {
  const p = _p.poly;
  g.moveTo(p[0]!, p[1]!);
  for (let i = 1; i < _p.n; i++) g.lineTo(p[i * 2]!, p[i * 2 + 1]!);
}

/** True when no path vertex lies strictly between arc lengths a < b. */
export function oneSegment(a: number, b: number): boolean {
  for (let i = 1; i < _p.n - 1; i++) {
    const c = _p.cum[i]!;
    if (c > a && c < b) return false;
  }
  return true;
}

/** Bow samples per span when a span crosses a path vertex. */
const BOW_STEPS = 4;

/** A bowed span ta -> tb across vertices: the same profile as the straight
 *  span's quadratic (o + 2s(1-s)*bow), sampled, mitred at each vertex. */
export function bowSpan(g: LinePath, ta: number, tb: number, o: number, bow: number): void {
  const span = tb - ta;
  let i = 1;
  while (i < _p.n - 1 && _p.cum[i]! <= ta) i++;
  for (let q = 1; q <= BOW_STEPS; q++) {
    const t = ta + (span * q) / BOW_STEPS;
    for (; i < _p.n - 1 && _p.cum[i]! < t; i++) {
      const s = (_p.cum[i]! - ta) / span;
      vertex(i, o + 2 * s * (1 - s) * bow); g.lineTo(W.px, W.py);
    }
    const s = q / BOW_STEPS;
    pt(t, o + 2 * s * (1 - s) * bow); g.lineTo(W.px, W.py);
  }
}

/** The point at arc length `t` on the path (`W.px`, `W.py`) with a smooth
 *  tangent (`W.ux`.. `W.ny`): the segment's direction at its middle, blended
 *  toward the neighbouring segment's so that at a vertex it is the bisector.
 *  Stations turn smoothly round a bend instead of snapping per segment.
 *  (`W.ox`, `W.oy` are left stale.) */
export function smoothAt(t: number): void {
  pt(t, 0);
  const p = _p.poly, cum = _p.cum;
  let j = 1;
  while (j < _p.n - 1 && cum[j]! < t) j++;
  const d = cum[j]! - cum[j - 1]!;
  if (!(d > 0)) return;
  const f = (t - cum[j - 1]!) / d;
  const k = f < 0.5 ? j - 1 : j + 1;
  if (k < 1 || k > _p.n - 1) return;
  const dk = cum[k]! - cum[k - 1]!;
  if (!(dk > 0)) return;
  const wt = f < 0.5 ? 0.5 - f : f - 0.5;
  const ux = W.ux * (1 - wt) + ((p[k * 2]! - p[k * 2 - 2]!) / dk) * wt;
  const uy = W.uy * (1 - wt) + ((p[k * 2 + 1]! - p[k * 2 - 1]!) / dk) * wt;
  const l = Math.hypot(ux, uy);
  if (!(l > 0)) return;
  W.ux = ux / l; W.uy = uy / l;
  W.nx = -W.uy; W.ny = W.ux;
}
