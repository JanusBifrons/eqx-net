/**
 * Warp route check, core (warp slice W1): where does a straight in-sector
 * warp line stop?
 *
 * A warp may not pass through an obstacle. The asteroid field's rock body
 * (`CoarseFieldMap.solidAt`) and every structure's footprint block the line;
 * wrecks, nebulae and ships do not. The line stops `margin` short of the first
 * blocked point.
 *
 * Two callers: the warp menu offers the stop point as the destination, and the
 * server checks that the line to a requested point is clear
 * (`warpLineClear`). Feeding a stop point back in gives a clear line: the
 * field is sampled on the same grid (from where the line enters the field's
 * disc, so it does not depend on the line's length) and a line that only
 * touches a structure's footprint at its end is not blocked.
 *
 * Pure and allocation-free (invariant #14): module scratch only.
 */
import { rayHitsBox } from '../combat/Weapons.js';
import { COARSE_NAV_CELL, type CoarseFieldMap } from './coarseField.js';

/** Field march step (world u): an eighth of a coarse nav cell. A blocked
 *  sample is then refined by bisection to `WARP_FIELD_TOLERANCE`. */
export const WARP_FIELD_STEP = COARSE_NAV_CELL / 8;
/** How close (world u) the field's stop is found to the rock body's edge. */
export const WARP_FIELD_TOLERANCE = 1;

/** One structure's footprint in world space: the same shape every hit test
 *  uses (`rayHitsBox`). Rotations are quarter turns, so the box is axis
 *  aligned: fill `halfW`/`halfH` from `structureHalfExtents(kind, rotation)`.
 *  `boxes`: a gate's parts (flat `[offX, offY, halfW, halfH, ...]` from the
 *  centre, as on its swarm record), else undefined. */
export interface WarpStructureFootprint {
  x: number;
  y: number;
  halfW: number;
  halfH: number;
  boxes: Float32Array | undefined;
}

/** The sector's structures, injected by the caller (core reads no server or
 *  client registry). Every structure blocks: player and NPC bases, alien
 *  gates, any kind. */
export interface WarpStructureSource {
  /** Number of structures. */
  readonly count: number;
  /** Writes structure `i`'s footprint into `out`. */
  footprint(i: number, out: WarpStructureFootprint): void;
}

/** Result of `warpLineStop`: where the warp ends. */
export interface WarpLineStop {
  x: number;
  y: number;
  /** Something is on the line, so (x, y) is short of the target. */
  blocked: boolean;
  /** Distance (world u) from (x, y) to the target; 0 when clear. */
  shortBy: number;
}

export function newWarpLineStop(): WarpLineStop {
  return { x: 0, y: 0, blocked: false, shortBy: 0 };
}

const fp: WarpStructureFootprint = { x: 0, y: 0, halfW: 0, halfH: 0, boxes: undefined };
const clearScratch = newWarpLineStop();

/**
 * Where a warp from (fromX, fromY) to (toX, toY) stops: `margin` (the hull's
 * radius) short of the first point inside the field's rock body or a
 * structure's footprint, never behind the start; the target when the line is
 * clear. `field` null: the sector has no field. `structures` null: none.
 * Writes and returns `out`.
 */
export function warpLineStop(
  field: CoarseFieldMap | null,
  structures: WarpStructureSource | null,
  fromX: number, fromY: number,
  toX: number, toY: number,
  margin: number,
  out: WarpLineStop,
): WarpLineStop {
  const dx = toX - fromX, dy = toY - fromY, len = Math.sqrt(dx * dx + dy * dy);
  out.x = toX; out.y = toY; out.blocked = false; out.shortBy = 0;
  if (len <= 0) return out;
  const ux = dx / len, uy = dy / len;
  let hit = len; // distance to the first blocked point; len ⇒ clear
  if (field) hit = fieldHit(field, fromX, fromY, ux, uy, len);
  if (structures) hit = structureHit(structures, fromX, fromY, ux, uy, hit);
  if (hit >= len) return out;
  const stop = Math.max(0, hit - margin);
  out.x = fromX + ux * stop; out.y = fromY + uy * stop;
  out.blocked = true; out.shortBy = len - stop;
  return out;
}

/** Is the warp line from (fromX, fromY) to (toX, toY) clear of the field's
 *  rock body and every structure? The server's check on a requested point;
 *  the same test as `warpLineStop`. */
export function warpLineClear(
  field: CoarseFieldMap | null,
  structures: WarpStructureSource | null,
  fromX: number, fromY: number,
  toX: number, toY: number,
): boolean {
  return !warpLineStop(field, structures, fromX, fromY, toX, toY, 0, clearScratch).blocked;
}

/** Distance along the unit ray to the last clear point before the field's
 *  rock body (within `WARP_FIELD_TOLERANCE`), or `len` when the segment never
 *  enters it. 0 when the start is in the body. Only the part of the segment
 *  inside the field's disc is marched, on a grid that starts where the ray
 *  enters it. */
function fieldHit(
  field: CoarseFieldMap, fx: number, fy: number, ux: number, uy: number, len: number,
): number {
  const S = field.solidRadius;
  const b = fx * ux + fy * uy, c = fx * fx + fy * fy - S * S, disc = b * b - c;
  if (disc <= 0) return len;
  const root = Math.sqrt(disc), tIn = -b - root, tOut = -b + root;
  if (tOut <= 0 || tIn >= len) return len;
  const a = tIn > 0 ? tIn : 0, e = tOut < len ? tOut : len;
  if (field.solidAt(fx + ux * a, fy + uy * a)) return a;
  let prev = a;
  for (let t = a + WARP_FIELD_STEP; ; t += WARP_FIELD_STEP) {
    const s = t < e ? t : e;
    if (field.solidAt(fx + ux * s, fy + uy * s)) {
      // Bisect: `lo` stays clear, `hi` stays in the body.
      let lo = prev, hi = s;
      while (hi - lo > WARP_FIELD_TOLERANCE) {
        const m = (lo + hi) / 2;
        if (field.solidAt(fx + ux * m, fy + uy * m)) hi = m; else lo = m;
      }
      return lo;
    }
    if (s >= e) return len;
    prev = s;
  }
}

/** Nearest structure footprint hit along the ray before `best`, else `best`.
 *  A line that only touches a footprint at its far end is not blocked (so a
 *  stop point fed back in, with margin 0, reads clear). */
function structureHit(
  src: WarpStructureSource, fx: number, fy: number, ux: number, uy: number, best: number,
): number {
  for (let i = 0, n = src.count; i < n; i++) {
    src.footprint(i, fp);
    // A structure whose footprint holds the start is ignored: a ship parked
    // inside its own base (or in a gate's passage) can warp out of it.
    if (Math.abs(fx - fp.x) <= fp.halfW && Math.abs(fy - fp.y) <= fp.halfH) continue;
    const t = rayHitsBox(fx, fy, ux, uy, best, fp.x, fp.y, fp.halfW, fp.halfH, fp.boxes);
    if (t !== null && t < best) best = t;
  }
  return best;
}
