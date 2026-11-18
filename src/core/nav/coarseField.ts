/**
 * The free-space map's coarse layer (navigation plan, Stage E slice 4).
 *
 * Covers a whole cut asteroid field with ~2 km cells, from the field's own
 * layout maths (`fieldLayout.ts`: `slicedFieldLanes`, `fieldStreet`, the open
 * core, `FieldClearing`), so it needs no rock geometry at all and agrees with
 * the cut on both sides (#15).
 *
 * Each cell stores its best point (the most open spot inside it) and the room
 * there: the biggest hull clearance that fits at that point. A cell centre
 * would be wrong here: a lane is only ~560 u wider than a battleship needs, so
 * a cell that the lane's centre line crosses must be judged on that line, not
 * at its centre.
 *
 * Room at a point is the best of:
 * - outside the field: distance past its rim, less the warp pad;
 * - the open core: distance to its edge, less the warp pad and one piece;
 * - a clearing: distance to its edge (clearings are exact);
 * - a lane: distance to its nearer wall, less the warp pad (walls bend ≤ ~1.1 km);
 * - inside the field: half the street at that distance from the centre.
 *
 * The fine layer (rock geometry near ships, slice 5) refines this; the coarse
 * layer only decides which way round the field a route goes.
 */
import {
  SLICED, cutFieldPad, fieldStreet, slicedFieldLanes,
  type ChunkOpts, type FieldClearing, type FieldLane,
} from '../terrain/fieldLayout.js';
import type { SearchGraph } from './search.js';

/** Coarse cell side (world u): the far-zoom piece size (`FIELD_COARSE_MIN_SIZE`). */
export const COARSE_NAV_CELL = 2048;

/** 8 neighbours: dx, dy. Straight moves first so ties prefer them. */
const NDX = [1, -1, 0, 0, 1, 1, -1, -1];
const NDY = [0, 0, 1, -1, 1, -1, 1, -1];

export class CoarseFieldMap implements SearchGraph {
  originX = 0;
  originY = 0;
  cell = COARSE_NAV_CELL;
  cols = 0;
  rows = 0;
  /** Per cell: best point and the room (max hull clearance) there. */
  bestX = new Float32Array(0);
  bestY = new Float32Array(0);
  room = new Float32Array(0);
  /** Hull clearance the graph view admits (set before a search). */
  clearance = 0;

  private R: number = SLICED.radius;
  private F = 0;
  private pad = cutFieldPad();
  private coreR = 0;
  private lanes: FieldLane[] = [];
  private clearings: readonly FieldClearing[] = [];

  /** Builds the map over the field plus `margin` of open space round it (by
   *  default room for any hull to go round the outside).
   *  Generation-time (once per sector), never per tick. */
  build(o: ChunkOpts, margin = cutFieldPad() + COARSE_NAV_CELL * 4): void {
    this.R = o.radius ?? SLICED.radius;
    this.F = o.fighterLength;
    this.lanes = slicedFieldLanes({ seed: o.seed, battleshipLength: o.battleshipLength, radius: this.R });
    this.clearings = o.clearings ?? [];
    // The core drops pieces whose centroid is inside it, so its edge is
    // ragged by up to a piece: the largest piece that stops uncut.
    this.coreR = SLICED.holeShare * this.R - SLICED.smallMaxF * this.F;
    const half = this.R + margin, cell = this.cell;
    const n = Math.ceil((2 * half) / cell);
    this.cols = n; this.rows = n;
    this.originX = -n * cell / 2; this.originY = -n * cell / 2;
    const cells = n * n;
    if (this.room.length < cells) {
      this.bestX = new Float32Array(cells); this.bestY = new Float32Array(cells); this.room = new Float32Array(cells);
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) this.buildCell(y * n + x, this.originX + x * cell, this.originY + y * cell);
    }
  }

  /** Room (max hull clearance) at world (x, y): the analytic layout. */
  roomAt(x: number, y: number): number {
    const R = this.R, pad = this.pad, r = Math.sqrt(x * x + y * y);
    let best = r - R - pad; // outside the rim
    if (r <= R + pad) best = Math.max(best, fieldStreet(Math.min(1, r / R), this.F) / 2);
    best = Math.max(best, this.coreR - r - pad);
    for (let i = 0; i < this.clearings.length; i++) {
      const k = this.clearings[i]!, dx = x - k.x, dy = y - k.y;
      best = Math.max(best, k.r - Math.sqrt(dx * dx + dy * dy));
    }
    for (let i = 0; i < this.lanes.length; i++) {
      const ln = this.lanes[i]!, off = (x - ln.o.x) * ln.n.x + (y - ln.o.y) * ln.n.y;
      best = Math.max(best, ln.half - Math.abs(off) - pad);
    }
    return best;
  }

  /** Cell index holding world (x, y), or -1 off the map. */
  cellAt(x: number, y: number): number {
    const cx = Math.floor((x - this.originX) / this.cell), cy = Math.floor((y - this.originY) / this.cell);
    return cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows ? -1 : cy * this.cols + cx;
  }

  // ---- SearchGraph over cells, admitting cells with room >= `clearance` ----
  get nodeCount(): number { return this.cols * this.rows; }
  edgeCount(): number { return 8; }
  /** A blocked or off-map neighbour points back at `i` (closed, so skipped). */
  edgeTo(i: number, k: number): number {
    const x = i % this.cols + NDX[k]!, y = ((i / this.cols) | 0) + NDY[k]!;
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return i;
    const j = y * this.cols + x;
    return this.room[j]! >= this.clearance ? j : i;
  }
  /** Straight distance between the two cells' best points. */
  edgeCost(i: number, k: number): number {
    const j = this.edgeTo(i, k);
    if (j === i) return Infinity;
    const dx = this.bestX[j]! - this.bestX[i]!, dy = this.bestY[j]! - this.bestY[i]!;
    return Math.max(1, Math.sqrt(dx * dx + dy * dy));
  }

  /** Best point of the cell with lower-left (x0, y0): tries the centre, the
   *  point nearest each lane's centre line, each clearing's centre and the
   *  field's centre, each clamped into the cell, and keeps the roomiest. */
  private buildCell(i: number, x0: number, y0: number): void {
    const c = this.cell, x1 = x0 + c, y1 = y0 + c, mx = x0 + c / 2, my = y0 + c / 2;
    let bx = mx, by = my, br = this.roomAt(mx, my);
    const tryPt = (px: number, py: number): void => {
      px = px < x0 ? x0 : px > x1 ? x1 : px;
      py = py < y0 ? y0 : py > y1 ? y1 : py;
      const r = this.roomAt(px, py);
      if (r > br) { br = r; bx = px; by = py; }
    };
    for (let k = 0; k < this.lanes.length; k++) {
      const ln = this.lanes[k]!, off = (mx - ln.o.x) * ln.n.x + (my - ln.o.y) * ln.n.y;
      tryPt(mx - off * ln.n.x, my - off * ln.n.y);
    }
    for (let k = 0; k < this.clearings.length; k++) tryPt(this.clearings[k]!.x, this.clearings[k]!.y);
    tryPt(0, 0);
    this.bestX[i] = bx; this.bestY[i] = by; this.room[i] = br;
  }
}

/** Each of the 8 neighbour steps as a turn index round the compass (0..7, 45° apart). */
const STEP_DIR = [0, 4, 2, 6, 1, 7, 3, 5];
/** A step's cost per 45° it turns from the way the ship arrived, in turning radii. */
export const NAV_TURN_STEP_COST = 0.25;
/** Entering a lane (no room to turn round) from open space costs this many
 *  turning radii on top: once in, the ship is committed to its far end. */
export const NAV_LANE_ENTRY_COST = 1;

/**
 * The coarse cells with the way the ship came in (navigation slice 11, capital
 * commitment). A cell with less room than the clearance plus the hull's
 * turning radius (a lane, to a capital) is one node per compass step the ship
 * arrived by (cell × 8 + step), and its next step may turn at most 45°:
 * forward only, no U-turn planned inside it; each such turn costs
 * `NAV_TURN_STEP_COST` turning radii per 45°. A cell with room to turn is one
 * node (cell × 8), free to leave any way, so open space searches as cheaply as
 * the plain graph. Entering a lane from open space costs
 * `NAV_LANE_ENTRY_COST` turning radii: once in, the ship is committed to its
 * far end. A view over the one `CoarseFieldMap`, its rooms and best points.
 */
export class HeadingCoarseGraph implements SearchGraph {
  map: CoarseFieldMap | null = null;
  turnRadius = 0;
  get nodeCount(): number { return this.map!.nodeCount * 8; }
  edgeCount(): number { return 8; }
  /** The compass step (0..7) nearest a heading (ship angle: 0 faces +y). */
  static stepOf(heading: number): number {
    const a = Math.atan2(Math.cos(heading), -Math.sin(heading)); // travel direction's angle from +x
    return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  }
  /** No room to turn round in this cell. */
  tight(cell: number): boolean {
    const m = this.map!;
    return m.room[cell]! < m.clearance + this.turnRadius;
  }
  /** The search's start node: in `cell`, pointing along `heading`. */
  startNode(cell: number, heading: number): number {
    return cell * 8 + (this.tight(cell) ? HeadingCoarseGraph.stepOf(heading) : 0);
  }
  /** 45° steps turned from the way in, for a step out of a lane cell; 0 out of open space. */
  private turnSteps(node: number, k: number): number {
    if (!this.tight(node >> 3)) return 0;
    const d = Math.abs(STEP_DIR[k]! - (node & 7));
    return d > 4 ? 8 - d : d;
  }
  edgeTo(node: number, k: number): number {
    const cell = node >> 3, j = this.map!.edgeTo(cell, k);
    if (j === cell || this.turnSteps(node, k) > 1) return node;
    return j * 8 + (this.tight(j) ? STEP_DIR[k]! : 0);
  }
  edgeCost(node: number, k: number): number {
    const to = this.edgeTo(node, k);
    if (to === node) return Infinity;
    const cell = node >> 3;
    const entry = this.tight(to >> 3) && !this.tight(cell) ? NAV_LANE_ENTRY_COST : 0;
    return this.map!.edgeCost(cell, k) + (this.turnSteps(node, k) * NAV_TURN_STEP_COST + entry) * this.turnRadius;
  }
}
