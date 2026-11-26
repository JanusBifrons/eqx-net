/**
 * A grid node's footprint box for the connection rules (edge distance, line
 * of sight, cable routing). The node keeps the NEAREST-QUARTER box
 * (`halfW`/`halfH`, `structureHalfExtents`); at a 30° deck step the rules
 * turn it back into the real box (`structureTurnedBoxInto`) by the node's
 * `rot`. A quarter turn takes the old axis-aligned path, byte-identical.
 * Shared by the server grid and the client preview (#15). Allocation-free.
 */
import type { GridNode } from './Grid.js';
import { orientedBoxBoundsInto, orientedBoxesDistance, structureTurnedBoxInto } from '../../shared-types/structureKinds/geometry.js';

/** A box turned by (`cos`, `sin`) with LOCAL half extents (`hw`, `hh`). */
export interface TurnedBox { hw: number; hh: number; cos: number; sin: number }

const RAD_TO_DEG = 180 / Math.PI;

/** `n`'s real footprint box into `out`: true at a 30° step (LOCAL extents
 *  and the real turn), false otherwise (the stored axis box, `cos` 1,
 *  `sin` 0; a node without `halfW`/`halfH` is a square of `radius`). */
export function gridNodeTurnedBoxInto(n: GridNode, out: TurnedBox): boolean {
  if (n.halfW === undefined || n.halfH === undefined || !Number.isFinite(n.rot)) {
    out.hw = n.halfW ?? n.radius; out.hh = n.halfH ?? n.radius; out.cos = 1; out.sin = 0;
    return false;
  }
  return structureTurnedBoxInto(n.halfW, n.halfH, n.rot * RAD_TO_DEG, out);
}

/** Segment (x0,y0)-(x1,y1) vs AABB [minX,minY]-[maxX,maxY] (Liang–Barsky slab
 *  clip). */
export function segmentIntersectsAabb(
  x0: number, y0: number, x1: number, y1: number,
  minX: number, minY: number, maxX: number, maxY: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0; // parallel: inside iff q >= 0
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (!clip(-dx, x0 - minX)) return false;
  if (!clip(dx, maxX - x0)) return false;
  if (!clip(-dy, y0 - minY)) return false;
  if (!clip(dy, maxY - y0)) return false;
  return t0 <= t1;
}

/** Segment vs the box centred (`cx`, `cy`) with LOCAL half extents (`hw`,
 *  `hh`) turned by (`cos`, `sin`): the segment taken into the box's frame.
 *  An axis box (`cos` 1, `sin` 0) is exactly `segmentIntersectsAabb`. */
export function segmentIntersectsOrientedBox(
  x0: number, y0: number, x1: number, y1: number,
  cx: number, cy: number, hw: number, hh: number, cos: number, sin: number,
): boolean {
  if (sin === 0 && cos === 1) return segmentIntersectsAabb(x0, y0, x1, y1, cx - hw, cy - hh, cx + hw, cy + hh);
  const ax = x0 - cx, ay = y0 - cy, bx = x1 - cx, by = y1 - cy;
  return segmentIntersectsAabb(
    ax * cos + ay * sin, -ax * sin + ay * cos,
    bx * cos + by * sin, -bx * sin + by * cos,
    -hw, -hh, hw, hh,
  );
}

const ta: TurnedBox = { hw: 0, hh: 0, cos: 1, sin: 0 };
const tb: TurnedBox = { hw: 0, hh: 0, cos: 1, sin: 0 };

/** Edge-to-edge distance between two nodes' footprint boxes. Returns 0 when
 *  the boxes overlap or touch — eqx-peri's `edgeDistance`. Both at a quarter
 *  turn: the axis-aligned rule, byte-identical; either at a 30° step: the
 *  real turned boxes (`orientedBoxesDistance`). */
export function edgeDistance(a: GridNode, b: GridNode): number {
  const aTurned = gridNodeTurnedBoxInto(a, ta);
  const bTurned = gridNodeTurnedBoxInto(b, tb);
  if (aTurned || bTurned) {
    return orientedBoxesDistance(a.x, a.y, ta.hw, ta.hh, ta.cos, ta.sin, b.x, b.y, tb.hw, tb.hh, tb.cos, tb.sin);
  }
  const dx = Math.max(0, Math.abs(a.x - b.x) - ((a.halfW ?? a.radius) + (b.halfW ?? b.radius)));
  const dy = Math.max(0, Math.abs(a.y - b.y) - ((a.halfH ?? a.radius) + (b.halfH ?? b.radius)));
  return Math.hypot(dx, dy);
}

/** Does segment (x0,y0)-(x1,y1) cross node `n`'s footprint box (turned at a
 *  30° step)? */
export function segmentHitsGridNodeBox(x0: number, y0: number, x1: number, y1: number, n: GridNode): boolean {
  gridNodeTurnedBoxInto(n, ta);
  return segmentIntersectsOrientedBox(x0, y0, x1, y1, n.x, n.y, ta.hw, ta.hh, ta.cos, ta.sin);
}

/** `cablePolylineTurnedBoxHit` results. */
export const TURNED_BROAD_MISS = 0;
export const TURNED_NARROW_MISS = 1;
export const TURNED_HIT = 2;

const bound = { hw: 0, hh: 0 };

/** A flattened cable (`segments` segments, from `flattenCableCurve`, with its
 *  bounding `box`) vs a turned box (centre, LOCAL half extents, turn): the
 *  box's world bound is the broad phase, then each segment in the box's
 *  frame. `TURNED_BROAD_MISS` when the bounds miss (no narrow-phase work),
 *  else `TURNED_NARROW_MISS` / `TURNED_HIT`. Allocation-free. */
export function cablePolylineTurnedBoxHit(
  poly: Float64Array, segments: number, box: { x0: number; y0: number; x1: number; y1: number },
  cx: number, cy: number, hw: number, hh: number, cos: number, sin: number,
): number {
  orientedBoxBoundsInto(hw, hh, cos, sin, bound);
  if (cx + bound.hw < box.x0 || cx - bound.hw > box.x1 || cy + bound.hh < box.y0 || cy - bound.hh > box.y1) return TURNED_BROAD_MISS;
  for (let i = 0; i < segments; i++) {
    const j = i * 2;
    if (segmentIntersectsOrientedBox(poly[j]!, poly[j + 1]!, poly[j + 2]!, poly[j + 3]!, cx, cy, hw, hh, cos, sin)) return TURNED_HIT;
  }
  return TURNED_NARROW_MISS;
}
