/**
 * Base platforms slice 12 — the deck cable path (plan
 * `.resume/base-platforms-plan.md`, owner: "Cables stay visible: connector ->
 * a corner of the middle hex -> along hex seams; never across a hex").
 *
 * A deck link's cable runs from its start end's centre to the corner of that
 * end's hex nearest the other end, then along hex edges (seams) to the corner
 * of the other end's hex nearest that first corner, then into the other end.
 * The seam walk is greedy on the honeycomb of deck hex corners: each corner
 * has three edges 120° apart, so one always closes on the target corner (a
 * corner one edge away is the only one that close), and the walk ends.
 *
 * The path is direction-free: it is always walked from the end with the lower
 * (x, then y) and reversed when asked the other way, so both sides and both
 * link orders draw the same cable (invariant 15). Allocation-free: writes into
 * caller scratch and module scratch (invariant 14).
 */
import { hexCornerInto, pixelToAxialInto, axialToPixelInto, type AxialHex, type HexPoint } from '../hex/hex.js';
import { DECK_HEX_SIZE } from '../hex/plates.js';

/** Corner-match tolerance (world units): float noise in the seam walk. */
const EPS = 1e-6;
/** The edge directions out of a corner, by corner parity: corner `i` of a hex
 *  (at 30° + 60°·i) has edges along 30°+60°·i and ±120° from it, so even
 *  corners point 30/150/270°, odd ones 90/210/330°. Each step flips it. */
const DIR_X = [
  [Math.cos(Math.PI / 6), Math.cos((5 * Math.PI) / 6), Math.cos((3 * Math.PI) / 2)],
  [Math.cos(Math.PI / 2), Math.cos((7 * Math.PI) / 6), Math.cos((11 * Math.PI) / 6)],
] as const;
const DIR_Y = [
  [Math.sin(Math.PI / 6), Math.sin((5 * Math.PI) / 6), Math.sin((3 * Math.PI) / 2)],
  [Math.sin(Math.PI / 2), Math.sin((7 * Math.PI) / 6), Math.sin((11 * Math.PI) / 6)],
] as const;

const HEX: AxialHex = { q: 0, r: 0 };
const CEN: HexPoint = { x: 0, y: 0 };
const COR: HexPoint = { x: 0, y: 0 };

/** Corner of the deck hex holding (px, py) nearest (tx, ty), into `out`;
 *  returns its index (0..5; ties: the lower index). */
function nearestCornerInto(px: number, py: number, tx: number, ty: number, out: HexPoint): number {
  pixelToAxialInto(px, py, DECK_HEX_SIZE, HEX);
  axialToPixelInto(HEX.q, HEX.r, DECK_HEX_SIZE, CEN);
  let best = Infinity, bi = 0;
  for (let i = 0; i < 6; i++) {
    hexCornerInto(CEN.x, CEN.y, DECK_HEX_SIZE, i, COR);
    const d = Math.hypot(COR.x - tx, COR.y - ty);
    if (d < best - EPS) { best = d; bi = i; out.x = COR.x; out.y = COR.y; }
  }
  return bi;
}

const S: HexPoint = { x: 0, y: 0 };
const E: HexPoint = { x: 0, y: 0 };

/** Append (x, y) as point `n` of `out` unless it repeats point `n - 1`;
 *  returns the new count. */
function push(out: Float64Array, n: number, x: number, y: number): number {
  if (n > 0 && Math.abs(out[n * 2 - 2]! - x) < EPS && Math.abs(out[n * 2 - 1]! - y) < EPS) return n;
  out[n * 2] = x;
  out[n * 2 + 1] = y;
  return n + 1;
}

/**
 * The raw deck seam path from (ax, ay) to (bx, by) into `out` (x0, y0, x1,
 * y1, …): the start, its hex's corner nearest the end, the seam walk, the end
 * hex's corner nearest that first corner, the end. Returns the point count,
 * or 0 when it needs more than `maxPoints` (the caller falls back). Repeated
 * points are dropped. Allocation-free.
 */
export function deckSeamPathInto(ax: number, ay: number, bx: number, by: number, out: Float64Array, maxPoints: number): number {
  // Walk from the lower (x, y) end; reverse after if asked the other way.
  const flip = bx < ax || (bx === ax && by < ay);
  const px = flip ? bx : ax, py = flip ? by : ay, qx = flip ? ax : bx, qy = flip ? ay : by;
  let parity = nearestCornerInto(px, py, qx, qy, S) & 1;
  nearestCornerInto(qx, qy, S.x, S.y, E);
  let n = push(out, 0, px, py);
  n = push(out, n, S.x, S.y);
  let cx = S.x, cy = S.y;
  while (Math.hypot(E.x - cx, E.y - cy) > EPS) {
    if (n + 2 > maxPoints) return 0; // this step and the end still to come
    let best = Infinity, bk = 0;
    for (let k = 0; k < 3; k++) {
      const d = Math.hypot(cx + DIR_X[parity]![k]! * DECK_HEX_SIZE - E.x, cy + DIR_Y[parity]![k]! * DECK_HEX_SIZE - E.y);
      if (d < best - EPS) { best = d; bk = k; }
    }
    cx += DIR_X[parity]![bk]! * DECK_HEX_SIZE;
    cy += DIR_Y[parity]![bk]! * DECK_HEX_SIZE;
    parity ^= 1;
    if (Math.hypot(E.x - cx, E.y - cy) <= EPS) { cx = E.x; cy = E.y; } // snap the float drift
    n = push(out, n, cx, cy);
  }
  if (n + 1 > maxPoints) return 0;
  n = push(out, n, qx, qy);
  if (flip) {
    for (let i = 0, j = n - 1; i < j; i++, j--) {
      const tx = out[i * 2]!, ty = out[i * 2 + 1]!;
      out[i * 2] = out[j * 2]!; out[i * 2 + 1] = out[j * 2 + 1]!;
      out[j * 2] = tx; out[j * 2 + 1] = ty;
    }
  }
  return n;
}

/** A writable box (structurally `CableBox`). */
interface Box { x0: number; y0: number; x1: number; y1: number }

const RAW_CAP = 64;
const raw = new Float64Array(RAW_CAP * 2);
const pieces = new Int32Array(RAW_CAP);
const lens = new Float64Array(RAW_CAP);

/**
 * The deck seam cable from (ax, ay) to (bx, by) as exactly `segments + 1`
 * points in `out` (the fixed polyline every cable consumer reads): the raw
 * path ({@link deckSeamPathInto}) with each leg split into equal pieces, the
 * spare pieces going to the longest legs, so every raw corner is kept and
 * every point lies on the path. Writes the box. Returns false (nothing
 * written) when the path needs more than `segments + 1` points.
 * Allocation-free.
 */
export function flattenDeckSeamCable(
  ax: number, ay: number, bx: number, by: number, out: Float64Array, box: Box, segments: number,
): boolean {
  const n = deckSeamPathInto(ax, ay, bx, by, raw, Math.min(segments + 1, RAW_CAP));
  if (n === 0) return false;
  const legs = n - 1;
  if (legs <= 0) {
    for (let i = 0; i <= segments; i++) { out[i * 2] = ax; out[i * 2 + 1] = ay; }
    box.x0 = box.x1 = ax; box.y0 = box.y1 = ay;
    return true;
  }
  for (let i = 0; i < legs; i++) {
    pieces[i] = 1;
    lens[i] = Math.hypot(raw[i * 2 + 2]! - raw[i * 2]!, raw[i * 2 + 3]! - raw[i * 2 + 1]!);
  }
  for (let spare = segments - legs; spare > 0; spare--) {
    let bi = 0, bl = -1;
    for (let i = 0; i < legs; i++) {
      const l = lens[i]! / pieces[i]!;
      if (l > bl + EPS) { bl = l; bi = i; }
    }
    pieces[bi]!++;
  }
  let k = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < legs; i++) {
    const sx = raw[i * 2]!, sy = raw[i * 2 + 1]!, dx = raw[i * 2 + 2]! - sx, dy = raw[i * 2 + 3]! - sy;
    const m = pieces[i]!;
    for (let t = 0; t < m; t++) {
      const x = sx + (dx * t) / m, y = sy + (dy * t) / m;
      out[k * 2] = x; out[k * 2 + 1] = y; k++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const lx = raw[legs * 2]!, ly = raw[legs * 2 + 1]!;
  out[k * 2] = lx; out[k * 2 + 1] = ly;
  if (lx < x0) x0 = lx; if (lx > x1) x1 = lx;
  if (ly < y0) y0 = ly; if (ly > y1) y1 = ly;
  box.x0 = x0; box.y0 = y0; box.x1 = x1; box.y1 = y1;
  return true;
}
