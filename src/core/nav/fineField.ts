/**
 * The free-space map's fine layer (navigation plan, Stage E slice 5).
 *
 * One `ClearanceGrid` of 64 u cells per loaded field chunk, built from the
 * chunk's real rocks: the worker re-cuts them with the same pure
 * `rocksInChunk` + `fieldRockBody` the room and the client use (#15), so no
 * rock geometry crosses a thread. The room tells it which chunks are loaded
 * and which rocks changed (broken up, or left somewhere else); only chunks a
 * changed rock reaches are rebuilt.
 *
 * Each chunk's grid reaches `FINE_NAV_REACH` past the chunk on every side, so
 * a rock just over the border still counts. Clearance reads are capped at
 * that reach: past it the fine layer cannot tell, and the coarse layer
 * decides (capitals only fit in lanes, the core, clearings and outside, all of
 * which the coarse layer knows exactly).
 *
 * Live awake rocks drifting between rests are not tracked here: ships dodge
 * moving bodies with local avoidance (slice 8). Generation-time work only:
 * never called from a tick.
 */
import { CHUNK_SIZE, rocksInChunk, unpackRockKey, type ChunkOpts } from '../terrain/fieldLayout.js';
import { fieldRockBody } from '../terrain/chunkStreamer.js';
import { rockObstacleParts, type GridObstacle } from '../structures/Grid.js';
import { ClearanceGrid } from './clearance.js';
import { pointToShipPolygonDistance } from '../combat/Weapons.js';

/** Fine cell side (world u). */
export const FINE_NAV_CELL = 64;
/** How far past its chunk a fine grid reaches, and the most clearance it
 *  reports (world u). */
export const FINE_NAV_REACH = 1024;
/** Rocks grow by half a cell diagonal before stamping, so none slips between
 *  cell centres; a cell's value − {@link FINE_NAV_DIAG} is then a true lower
 *  bound on the clearance anywhere in it (`ClearanceGrid`). */
export const FINE_NAV_PAD = (FINE_NAV_CELL * Math.SQRT2) / 2;
export const FINE_NAV_DIAG = FINE_NAV_CELL * Math.SQRT2;
/** Cells on a side of one chunk's grid. */
export const FINE_NAV_SIDE = (CHUNK_SIZE + 2 * FINE_NAV_REACH) / FINE_NAV_CELL;

/** Bucket side of a chunk's rock index for exact distances (world u). */
const IDX_CELL = 256;
/** Buckets on a side of one chunk's index (it covers the grid's area). */
const IDX_SIDE = (CHUNK_SIZE + 2 * FINE_NAV_REACH) / IDX_CELL;

/** A chunk's rocks bucketed for {@link FineFieldLayer.exactAt}: bucket `b`
 *  holds `items[start[b] .. start[b + 1])`, indices into `obs`. */
interface RockIndex { obs: GridObstacle[]; start: Int32Array; items: Int32Array }

/** A rock as the fine layer sees it: its obstacle record plus its key. */
interface NavRock extends GridObstacle { key: number; angle: number; restX: number; restY: number }

/** A rock left somewhere other than its cut pose (deep sleep, C2). */
export interface NavRockPose { key: number; x: number; y: number; angle: number }

const ck = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

export class FineFieldLayer {
  /** Loaded chunks: their clearance (row-major, `FINE_NAV_SIDE`²). */
  private readonly live = new Map<number, Float32Array>();
  /** Cut rocks per chunk, kept while the chunk or a neighbour is loaded. */
  private readonly cut = new Map<number, NavRock[]>();
  private readonly gone = new Set<number>();
  private readonly moved = new Map<number, NavRockPose>();
  private readonly builder = new ClearanceGrid();
  private readonly obs: GridObstacle[] = [];
  private readonly spare: Float32Array[] = [];
  /** Per loaded chunk: its rocks bucketed for exact distance (slice A of the fine rebuild). */
  private readonly index = new Map<number, RockIndex>();

  /** Exact point-to-rock distances worked out so far (the count gate's work counter). */
  exactQueries = 0;

  /** Grid cells rebuilt so far (the count gate's work counter). */
  cellsRebuilt = 0;
  /** Chunks cut so far (rocks generated from the layout). */
  chunksCut = 0;

  constructor(private readonly opts: ChunkOpts, gone: readonly number[] = [], moved: readonly NavRockPose[] = []) {
    for (const k of gone) this.gone.add(k);
    for (const p of moved) this.moved.set(p.key, p);
  }

  get liveCount(): number { return this.live.size; }
  get cutCount(): number { return this.cut.size; }

  /** A chunk was loaded: build its grid. */
  chunkLoaded(cx: number, cy: number): void {
    const key = ck(cx, cy);
    if (this.live.has(key)) return;
    this.live.set(key, this.spare.pop() ?? new Float32Array(FINE_NAV_SIDE * FINE_NAV_SIDE));
    this.rebuild(cx, cy);
  }

  /** A chunk was dropped: free its grid and any rocks nothing needs now. */
  chunkUnloaded(cx: number, cy: number): void {
    const key = ck(cx, cy), grid = this.live.get(key);
    if (!grid) return;
    this.live.delete(key);
    this.index.delete(key);
    this.spare.push(grid);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!this.neededForCut(cx + dx, cy + dy)) this.cut.delete(ck(cx + dx, cy + dy));
    }
  }

  /** A rock was broken up: it is gone for good. */
  rockGone(key: number): void {
    if (this.gone.has(key)) return;
    const r = this.findRock(key);
    this.gone.add(key);
    if (r) this.dirtyAround(r.x, r.y, r.radius);
  }

  /** Rock `key` now rests at `pose` (deep sleep, C2); null: back at its cut pose. */
  rockMoved(key: number, pose: { x: number; y: number; angle: number } | null): void {
    if (pose) this.moved.set(key, { key, x: pose.x, y: pose.y, angle: pose.angle });
    else this.moved.delete(key);
    const r = this.findRock(key);
    if (!r) return;
    const ox = r.x, oy = r.y;
    r.x = pose?.x ?? r.restX; r.y = pose?.y ?? r.restY; r.angle = pose?.angle ?? 0;
    if (!this.gone.has(key)) this.dirtyAround(ox, oy, r.radius, r.x, r.y);
  }

  /** Clearance at world (x, y), capped at `FINE_NAV_REACH`; -1 when its
   *  chunk is not loaded (the fine layer does not know). */
  clearanceAt(x: number, y: number): number {
    const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
    const grid = this.live.get(ck(cx, cy));
    if (!grid) return -1;
    const gx = Math.floor((x - cx * CHUNK_SIZE + FINE_NAV_REACH) / FINE_NAV_CELL);
    const gy = Math.floor((y - cy * CHUNK_SIZE + FINE_NAV_REACH) / FINE_NAV_CELL);
    const d = grid[gy * FINE_NAV_SIDE + gx]!;
    return d < FINE_NAV_REACH ? d : FINE_NAV_REACH;
  }

  /** The exact distance from (x, y) to the nearest rock outline (the rocks'
   *  own convex parts, at their pose), capped at `cap` (≤ `FINE_NAV_REACH`);
   *  -1 when the chunk is not loaded. For where a cell's bound is too rough
   *  to tell whether a hull fits (a tight street): never on a tick. */
  exactAt(x: number, y: number, cap: number): number {
    const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
    const idx = this.index.get(ck(cx, cy));
    if (!idx) return -1;
    this.exactQueries++;
    const x0 = cx * CHUNK_SIZE - FINE_NAV_REACH, y0 = cy * CHUNK_SIZE - FINE_NAV_REACH;
    const bx0 = Math.max(0, Math.floor((x - cap - x0) / IDX_CELL)), bx1 = Math.min(IDX_SIDE - 1, Math.floor((x + cap - x0) / IDX_CELL));
    const by0 = Math.max(0, Math.floor((y - cap - y0) / IDX_CELL)), by1 = Math.min(IDX_SIDE - 1, Math.floor((y + cap - y0) / IDX_CELL));
    let best = cap;
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      const b = by * IDX_SIDE + bx;
      for (let k = idx.start[b]!, end = idx.start[b + 1]!; k < end; k++) {
        const o = idx.obs[idx.items[k]!]!;
        const dx = x - o.x, dy = y - o.y, far = best + o.radius;
        if (dx * dx + dy * dy >= far * far) continue;
        const d = o.parts ? pointToShipPolygonDistance(x, y, o.x, o.y, o.angle ?? 0, o.parts) : Math.max(0, Math.sqrt(dx * dx + dy * dy) - o.radius);
        if (d < best) { best = d; if (best === 0) return 0; }
      }
    }
    return best;
  }

  /** Rebuilds every loaded chunk whose grid a circle at (x, y) of `radius`
   *  (and, optionally, the same circle at (x2, y2)) reaches. */
  private dirtyAround(x: number, y: number, radius: number, x2 = x, y2 = y): void {
    for (const [key, ] of this.live) {
      const cx = Math.floor(key / 65536) - 32768, cy = (key % 65536) - 32768;
      if (this.reaches(cx, cy, x, y, radius) || this.reaches(cx, cy, x2, y2, radius)) this.rebuild(cx, cy);
    }
  }

  /** Does a circle reach chunk (cx, cy)'s grid area? */
  private reaches(cx: number, cy: number, x: number, y: number, radius: number): boolean {
    const x0 = cx * CHUNK_SIZE - FINE_NAV_REACH, y0 = cy * CHUNK_SIZE - FINE_NAV_REACH, s = CHUNK_SIZE + 2 * FINE_NAV_REACH;
    const dx = Math.max(x0 - x, 0, x - (x0 + s)), dy = Math.max(y0 - y, 0, y - (y0 + s));
    return dx * dx + dy * dy <= radius * radius;
  }

  private rebuild(cx: number, cy: number): void {
    const obs = this.obs;
    obs.length = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const r of this.rocksOf(cx + dx, cy + dy)) {
        if (!this.gone.has(r.key) && this.reaches(cx, cy, r.x, r.y, r.radius)) obs.push(r);
      }
    }
    const b = this.builder;
    b.build(cx * CHUNK_SIZE - FINE_NAV_REACH, cy * CHUNK_SIZE - FINE_NAV_REACH, FINE_NAV_SIDE, FINE_NAV_SIDE, FINE_NAV_CELL, obs, FINE_NAV_PAD);
    this.live.get(ck(cx, cy))!.set(b.dist);
    this.index.set(ck(cx, cy), indexRocks(cx, cy, obs));
    this.cellsRebuilt += FINE_NAV_SIDE * FINE_NAV_SIDE;
  }

  /** A chunk's rocks, cut once and kept while it or a neighbour is loaded. */
  private rocksOf(cx: number, cy: number): NavRock[] {
    const key = ck(cx, cy);
    let rocks = this.cut.get(key);
    if (rocks) return rocks;
    rocks = [];
    for (const rock of rocksInChunk(this.opts, cx, cy)) {
      const b = fieldRockBody(rock), at = this.moved.get(rock.key);
      rocks.push({
        key: rock.key, x: at?.x ?? b.x, y: at?.y ?? b.y, radius: b.radius, angle: at?.angle ?? 0, restX: b.x, restY: b.y,
        parts: rockObstacleParts(b.verts, b.parts, true),
      });
    }
    this.chunksCut++;
    this.cut.set(key, rocks);
    return rocks;
  }

  private findRock(key: number): NavRock | undefined {
    const { cx, cy } = unpackRockKey(key);
    const rocks = this.cut.get(ck(cx, cy));
    if (!rocks) return undefined;
    for (const r of rocks) if (r.key === key) return r;
    return undefined;
  }

  private neededForCut(cx: number, cy: number): boolean {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (this.live.has(ck(cx + dx, cy + dy))) return true;
    return false;
  }
}

/** Buckets `obs` (copied) by the index cells each rock's circle covers. */
function indexRocks(cx: number, cy: number, obs: readonly GridObstacle[]): RockIndex {
  const x0 = cx * CHUNK_SIZE - FINE_NAV_REACH, y0 = cy * CHUNK_SIZE - FINE_NAV_REACH, n = IDX_SIDE * IDX_SIDE;
  const start = new Int32Array(n + 1);
  const span = (o: GridObstacle, visit: (b: number) => void): void => {
    const bx0 = Math.max(0, Math.floor((o.x - o.radius - x0) / IDX_CELL)), bx1 = Math.min(IDX_SIDE - 1, Math.floor((o.x + o.radius - x0) / IDX_CELL));
    const by0 = Math.max(0, Math.floor((o.y - o.radius - y0) / IDX_CELL)), by1 = Math.min(IDX_SIDE - 1, Math.floor((o.y + o.radius - y0) / IDX_CELL));
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) visit(by * IDX_SIDE + bx);
  };
  for (const o of obs) span(o, (b) => { start[b + 1] = start[b + 1]! + 1; });
  for (let b = 0; b < n; b++) start[b + 1] = start[b + 1]! + start[b]!;
  const fill = start.slice(0, n), items = new Int32Array(start[n]!);
  obs.forEach((o, i) => span(o, (b) => { items[fill[b]!] = i; fill[b] = fill[b]! + 1; }));
  return { obs: obs.slice(), start, items };
}
