/**
 * Layout validators — "generate, then curate"
 * (docs/architecture/procedural-bases-research.md §2, §6).
 *
 * A layout is rejected (and the generator re-seeds deterministically) unless:
 *  - budgets hold (pieces per base, pieces per chunk, layout bytes);
 *  - every SOLID piece is at least MIN_WALL_THICKNESS on its thin side —
 *    except where a chunk split cut it (a sliver at a chunk line is still
 *    part of a thicker parent, so only the UNSPLIT thin side is checked);
 *  - every piece lies inside the footprint box and the sector bounds;
 *  - FLY-THROUGH: on a coarse occupancy grid, every free cell with enough
 *    clearance for the largest flyable ship is reachable from outside the
 *    base. (No sealed pockets a ship could see but never enter.)
 *
 * The coarse occupancy grid + clearance (distance transform) built here is
 * also the seed of the obstacle field roaming AI will use (plan PR-N).
 */
import { basePieceKindAt } from '../../shared-types/basePieceKinds.js';
import {
  MAX_LAYOUT_BYTES_PER_BASE,
  MAX_PIECES_PER_BASE,
  MAX_PIECES_PER_CHUNK,
  MIN_WALL_THICKNESS,
} from '../../shared-types/baseBudgets.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';
import { BASE_CHUNK_SIZE } from '../../shared-types/baseBudgets.js';
import type { BaseLayout } from './baseLayout.js';
import { layoutBytes } from './baseLayout.js';
import { MAX_FLYABLE_RADIUS } from './corridor.js';

/** Occupancy grid resolution (u). */
export const OCCUPANCY_CELL = 32;

export interface OccupancyGrid {
  /** Cells per side; the grid covers the footprint box plus a 2-cell rim. */
  readonly n: number;
  /** World-local coordinate of cell (0,0)'s min corner. */
  readonly origin: number;
  /** 1 = solid. */
  readonly solid: Uint8Array;
  /** Chamfer distance to the nearest solid cell, in cell units × 3 (3-4 metric). */
  readonly clearance: Uint16Array;
}

export function buildOccupancy(l: BaseLayout): OccupancyGrid {
  const rim = 2;
  const n = Math.ceil((2 * l.half) / OCCUPANCY_CELL) + 2 * rim;
  const origin = -l.half - rim * OCCUPANCY_CELL;
  const solid = new Uint8Array(n * n);
  for (let i = 0; i < l.count; i++) {
    if (!basePieceKindAt(l.kind[i]!).solid) continue;
    // Mark every cell the rectangle touches (conservative for clearance).
    const cx0 = Math.floor((l.x[i]! - origin) / OCCUPANCY_CELL);
    const cy0 = Math.floor((l.y[i]! - origin) / OCCUPANCY_CELL);
    const cx1 = Math.floor((l.x[i]! + l.w[i]! - 1 - origin) / OCCUPANCY_CELL);
    const cy1 = Math.floor((l.y[i]! + l.h[i]! - 1 - origin) / OCCUPANCY_CELL);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) solid[cy * n + cx] = 1;
  }
  // Two-pass 3-4 chamfer distance transform (integer; deterministic).
  const BIG = 0xffff;
  const d = new Uint16Array(n * n);
  for (let i = 0; i < d.length; i++) d[i] = solid[i] ? 0 : BIG;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      let v = d[i]!;
      if (x > 0) v = Math.min(v, d[i - 1]! + 3);
      if (y > 0) {
        v = Math.min(v, d[i - n]! + 3);
        if (x > 0) v = Math.min(v, d[i - n - 1]! + 4);
        if (x < n - 1) v = Math.min(v, d[i - n + 1]! + 4);
      }
      d[i] = Math.min(v, BIG);
    }
  }
  for (let y = n - 1; y >= 0; y--) {
    for (let x = n - 1; x >= 0; x--) {
      const i = y * n + x;
      let v = d[i]!;
      if (x < n - 1) v = Math.min(v, d[i + 1]! + 3);
      if (y < n - 1) {
        v = Math.min(v, d[i + n]! + 3);
        if (x < n - 1) v = Math.min(v, d[i + n + 1]! + 4);
        if (x > 0) v = Math.min(v, d[i + n - 1]! + 4);
      }
      d[i] = Math.min(v, BIG);
    }
  }
  return { n, origin, solid, clearance: d };
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly reasons: string[];
  /** Flyable interior cells not reachable from outside (0 when ok). */
  readonly sealedCells: number;
  readonly reachableCells: number;
}

/** Clearance (chamfer units, ×3) a cell needs for the largest flyable ship. */
export function requiredClearance(): number {
  // Ship radius + half a cell of conservatism, in cells, ×3 for the metric.
  return Math.ceil((MAX_FLYABLE_RADIUS + OCCUPANCY_CELL / 2) / OCCUPANCY_CELL) * 3;
}

export function validateLayout(l: BaseLayout): ValidationResult {
  const reasons: string[] = [];

  if (l.count > MAX_PIECES_PER_BASE) reasons.push(`pieces ${l.count} > ${MAX_PIECES_PER_BASE}`);
  if (layoutBytes(l) > MAX_LAYOUT_BYTES_PER_BASE) reasons.push(`bytes ${layoutBytes(l)} > ${MAX_LAYOUT_BYTES_PER_BASE}`);

  const perChunk = new Map<number, number>();
  for (let i = 0; i < l.count; i++) perChunk.set(l.chunk[i]!, (perChunk.get(l.chunk[i]!) ?? 0) + 1);
  for (const [c, k] of perChunk) if (k > MAX_PIECES_PER_CHUNK) reasons.push(`chunk ${c} has ${k} > ${MAX_PIECES_PER_CHUNK} pieces`);

  const origin = -l.half;
  for (let i = 0; i < l.count; i++) {
    const x0 = l.x[i]!, y0 = l.y[i]!, x1 = x0 + l.w[i]!, y1 = y0 + l.h[i]!;
    if (x0 < -l.half || y0 < -l.half || x1 > l.half || y1 > l.half) {
      reasons.push(`piece ${i} outside footprint`);
      break;
    }
    const wx0 = l.descriptor.x + x0, wx1 = l.descriptor.x + x1;
    const wy0 = l.descriptor.y + y0, wy1 = l.descriptor.y + y1;
    const H = SECTOR_PLAYABLE_HALF_EXTENT;
    if (wx0 < -H || wy0 < -H || wx1 > H || wy1 > H) {
      reasons.push(`piece ${i} outside sector bounds`);
      break;
    }
    if (basePieceKindAt(l.kind[i]!).solid) {
      // A side that touches a chunk line may be a split sliver; only check
      // the thin side when it is NOT a chunk cut.
      const cutX = (x0 - origin) % BASE_CHUNK_SIZE === 0 || (x1 - origin) % BASE_CHUNK_SIZE === 0;
      const cutY = (y0 - origin) % BASE_CHUNK_SIZE === 0 || (y1 - origin) % BASE_CHUNK_SIZE === 0;
      const thinW = l.w[i]! < MIN_WALL_THICKNESS && !cutX;
      const thinH = l.h[i]! < MIN_WALL_THICKNESS && !cutY;
      if (thinW || thinH) {
        reasons.push(`piece ${i} thinner than ${MIN_WALL_THICKNESS}`);
        break;
      }
    }
  }

  // Fly-through reachability.
  const f = floodReachable(l);
  if (f.sealed > 0) reasons.push(`${f.sealed} flyable cells sealed off from every gate`);

  return { ok: reasons.length === 0, reasons, sealedCells: f.sealed, reachableCells: f.reachedCount };
}

export interface ReachResult {
  readonly grid: OccupancyGrid;
  /** 1 = reachable from outside the base by the largest flyable ship. */
  readonly reached: Uint8Array;
  readonly reachedCount: number;
  /** Flyable cells NOT reachable (sealed pockets). */
  readonly sealed: number;
  readonly need: number;
}

/** Flood fill from the grid rim over cells with flyable clearance. */
export function floodReachable(l: BaseLayout): ReachResult {
  const g = buildOccupancy(l);
  const need = requiredClearance();
  const reached = new Uint8Array(g.n * g.n);
  const queue = new Int32Array(g.n * g.n);
  let qh = 0, qt = 0;
  const visit = (j: number): void => {
    if (reached[j] || g.clearance[j]! < need) return;
    reached[j] = 1;
    queue[qt++] = j;
  };
  // Seed: every flyable cell on the grid rim (outside the base).
  for (let i = 0; i < g.n; i++) {
    visit(i);
    visit((g.n - 1) * g.n + i);
    visit(i * g.n);
    visit(i * g.n + g.n - 1);
  }
  while (qh < qt) {
    const idx = queue[qh++]!;
    const x = idx % g.n, y = (idx - x) / g.n;
    if (x > 0) visit(idx - 1);
    if (x < g.n - 1) visit(idx + 1);
    if (y > 0) visit(idx - g.n);
    if (y < g.n - 1) visit(idx + g.n);
  }
  let sealed = 0;
  for (let i = 0; i < reached.length; i++) if (!reached[i] && g.clearance[i]! >= need) sealed++;
  return { grid: g, reached, reachedCount: qt, sealed, need };
}
