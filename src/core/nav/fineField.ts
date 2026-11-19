/**
 * The free-space map's fine layer (navigation plan, Stage E slice 5).
 *
 * One `ClearanceGrid` of 64 u cells per loaded field chunk, built from the
 * chunk's real rocks ON DEMAND (owner, 2026-11-18: nothing ahead of time):
 * the first read of a loaded chunk builds it, into one fixed-size
 * {@link NavDetailPool} the whole nav worker shares, which drops the least
 * recently read chunk when full. The cost so follows how much the planner is
 * used, never the number of sectors or loaded chunks. The rocks are the worker re-cuts them with the same pure
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

/** The nav worker's fine-detail budget (bytes, every field together). */
export const NAV_DETAIL_POOL_BYTES = 8 * 1024 * 1024;

/** One built chunk: its clearance grid (row-major, `FINE_NAV_SIDE`²), its
 *  rocks bucketed for exact distance, and when it was last read. */
interface ChunkDetail { grid: Float32Array; index: RockIndex; used: number; bytes: number }

/** The fixed-size store every {@link FineFieldLayer} of one worker builds
 *  into. Over budget, the least recently read chunk (of any field) goes; it
 *  is rebuilt, identical, the next time it is read. */
export class NavDetailPool {
  /** Bytes held by built chunks now. */
  bytes = 0;
  /** Built chunks dropped to stay in budget so far. */
  evictions = 0;
  /** Read clock (a counter, not time). */
  clock = 0;
  private readonly layers = new Set<FineFieldLayer>();
  private readonly spare: Float32Array[] = [];
  constructor(readonly capBytes = NAV_DETAIL_POOL_BYTES) {}

  /** @internal */ join(l: FineFieldLayer): void { this.layers.add(l); }
  /** @internal */ leave(l: FineFieldLayer): void { this.layers.delete(l); }
  /** @internal A grid's worth of cells, reused when one was freed. */
  grid(): Float32Array { return this.spare.pop() ?? new Float32Array(FINE_NAV_SIDE * FINE_NAV_SIDE); }
  /** @internal */ freed(d: ChunkDetail): void { this.bytes -= d.bytes; this.spare.push(d.grid); }

  /** @internal Drops least recently read chunks until `need` more bytes fit. */
  reserve(need: number): void {
    while (this.bytes + need > this.capBytes) {
      let oldest: FineFieldLayer | null = null, key = -1, used = Infinity;
      for (const l of this.layers) {
        const k = l.oldestBuilt();
        if (k >= 0 && l.usedOf(k) < used) { oldest = l; key = k; used = l.usedOf(k); }
      }
      if (!oldest) return;
      oldest.drop(key);
      this.evictions++;
    }
  }
}

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
  /** Chunks the room has loaded (detail may be built for these only). */
  private readonly loaded = new Set<number>();
  /** Built chunks (a subset of `loaded`), in the shared pool. */
  private readonly live = new Map<number, ChunkDetail>();
  /** Cut rocks per chunk, kept while the chunk or a neighbour is built. */
  private readonly cut = new Map<number, NavRock[]>();
  private readonly gone = new Set<number>();
  private readonly moved = new Map<number, NavRockPose>();
  private readonly builder = new ClearanceGrid();
  private readonly obs: GridObstacle[] = [];
  /** Static obstacles other than the field's rocks (structures; resting
   *  wrecks later), by nav id: discrete add/remove only, never per tick. */
  private readonly extras = new Map<number, GridObstacle>();
  /** Per chunk: the ids of extras reaching its grid area. Such a chunk may
   *  be built though the field streamer has not loaded it. */
  private readonly extrasByChunk = new Map<number, Set<number>>();

  /** Exact point-to-rock distances worked out so far (the count gate's work counter). */
  exactQueries = 0;

  /** Grid cells rebuilt so far (the count gate's work counter). */
  cellsRebuilt = 0;
  /** Chunks cut so far (rocks generated from the layout). */
  chunksCut = 0;

  constructor(private readonly opts: ChunkOpts, gone: readonly number[] = [], moved: readonly NavRockPose[] = [],
    private readonly pool: NavDetailPool = new NavDetailPool()) {
    for (const k of gone) this.gone.add(k);
    for (const p of moved) this.moved.set(p.key, p);
    pool.join(this);
  }

  /** Chunks built now. */
  get liveCount(): number { return this.live.size; }
  /** Chunks the room has loaded. */
  get loadedCount(): number { return this.loaded.size; }
  get cutCount(): number { return this.cut.size; }
  /** Static obstacles other than rocks held now. */
  get extraCount(): number { return this.extras.size; }
  /** Bytes the shared pool holds now (every field). */
  get poolBytes(): number { return this.pool.bytes; }

  /** A chunk was loaded: its detail may be built when first read. */
  chunkLoaded(cx: number, cy: number): void { this.loaded.add(ck(cx, cy)); }

  /** A chunk was dropped: free its detail and any rocks nothing needs now. */
  chunkUnloaded(cx: number, cy: number): void {
    const key = ck(cx, cy);
    this.loaded.delete(key);
    this.drop(key);
  }

  /** The field is gone: hand every built chunk back to the pool. */
  dispose(): void {
    for (const key of [...this.live.keys()]) this.drop(key);
    this.pool.leave(this);
  }

  /** @internal (pool) Least recently read built chunk, or -1. */
  oldestBuilt(): number {
    let key = -1, used = Infinity;
    for (const [k, d] of this.live) if (d.used < used) { used = d.used; key = k; }
    return key;
  }
  /** @internal (pool) */ usedOf(key: number): number { return this.live.get(key)?.used ?? Infinity; }

  /** @internal (pool) Frees built chunk `key` and the rocks nothing needs now. */
  drop(key: number): void {
    const d = this.live.get(key);
    if (!d) return;
    this.live.delete(key);
    this.pool.freed(d);
    const cx = Math.floor(key / 65536) - 32768, cy = (key % 65536) - 32768;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!this.neededForCut(cx + dx, cy + dy)) this.cut.delete(ck(cx + dx, cy + dy));
    }
  }

  /** Chunk (cx, cy)'s detail, built now if it is loaded and not yet built. */
  private detail(cx: number, cy: number): ChunkDetail | undefined {
    const key = ck(cx, cy);
    let d = this.live.get(key);
    if (!d) {
      if (!this.loaded.has(key) && !this.extrasByChunk.has(key)) return undefined;
      d = this.build(cx, cy);
    }
    d.used = ++this.pool.clock;
    return d;
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

  /** A static obstacle that is not a field rock (a structure's solid box;
   *  `o.parts` convex CCW, relative to (x, y), turned by `o.angle`) is now
   *  at `o`; null: it is gone. Drops the built chunks its old and new
   *  circles reach (rebuilt when next read). */
  obstacleSet(id: number, o: GridObstacle | null): void {
    const old = this.extras.get(id);
    if (old) {
      this.extras.delete(id);
      this.markChunks(id, old, false);
      this.dirtyAround(old.x, old.y, old.radius);
    }
    if (!o) return;
    const own: GridObstacle = { x: o.x, y: o.y, radius: o.radius, angle: o.angle ?? 0, parts: o.parts };
    this.extras.set(id, own);
    this.markChunks(id, own, true);
    this.dirtyAround(own.x, own.y, own.radius);
  }

  /** Adds or removes `id` on every chunk whose grid area `o`'s circle reaches. */
  private markChunks(id: number, o: GridObstacle, on: boolean): void {
    const m = o.radius + FINE_NAV_REACH;
    const cx0 = Math.floor((o.x - m) / CHUNK_SIZE), cx1 = Math.floor((o.x + m) / CHUNK_SIZE);
    const cy0 = Math.floor((o.y - m) / CHUNK_SIZE), cy1 = Math.floor((o.y + m) / CHUNK_SIZE);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      if (!this.reaches(cx, cy, o.x, o.y, o.radius)) continue;
      const key = ck(cx, cy);
      let ids = this.extrasByChunk.get(key);
      if (on) {
        if (!ids) this.extrasByChunk.set(key, ids = new Set());
        ids.add(id);
      } else if (ids) {
        ids.delete(id);
        if (ids.size === 0) this.extrasByChunk.delete(key);
      }
    }
  }

  /** Clearance at world (x, y), capped at `FINE_NAV_REACH`; -1 when its
   *  chunk is not loaded (the fine layer does not know). */
  clearanceAt(x: number, y: number): number {
    const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
    const grid = this.detail(cx, cy)?.grid;
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
    const idx = this.detail(cx, cy)?.index;
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

  /** Drops every built chunk whose area a circle at (x, y) of `radius` (and,
   *  optionally, the same circle at (x2, y2)) reaches: the whole chunk, since
   *  a rock arriving lowers distances out to the grid's reach. It is rebuilt
   *  when next read. */
  private dirtyAround(x: number, y: number, radius: number, x2 = x, y2 = y): void {
    for (const key of [...this.live.keys()]) {
      const cx = Math.floor(key / 65536) - 32768, cy = (key % 65536) - 32768;
      if (this.reaches(cx, cy, x, y, radius) || this.reaches(cx, cy, x2, y2, radius)) this.drop(key);
    }
  }

  /** Does a circle reach chunk (cx, cy)'s grid area? */
  private reaches(cx: number, cy: number, x: number, y: number, radius: number): boolean {
    const x0 = cx * CHUNK_SIZE - FINE_NAV_REACH, y0 = cy * CHUNK_SIZE - FINE_NAV_REACH, s = CHUNK_SIZE + 2 * FINE_NAV_REACH;
    const dx = Math.max(x0 - x, 0, x - (x0 + s)), dy = Math.max(y0 - y, 0, y - (y0 + s));
    return dx * dx + dy * dy <= radius * radius;
  }

  private build(cx: number, cy: number): ChunkDetail {
    const obs = this.obs;
    obs.length = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const r of this.rocksOf(cx + dx, cy + dy)) {
        if (!this.gone.has(r.key) && this.reaches(cx, cy, r.x, r.y, r.radius)) obs.push(r);
      }
    }
    const extra = this.extrasByChunk.get(ck(cx, cy));
    if (extra) for (const id of extra) obs.push(this.extras.get(id)!);
    const b = this.builder;
    b.build(cx * CHUNK_SIZE - FINE_NAV_REACH, cy * CHUNK_SIZE - FINE_NAV_REACH, FINE_NAV_SIDE, FINE_NAV_SIDE, FINE_NAV_CELL, obs, FINE_NAV_PAD);
    const index = indexRocks(cx, cy, obs);
    const bytes = FINE_NAV_SIDE * FINE_NAV_SIDE * 4 + index.start.byteLength + index.items.byteLength;
    this.pool.reserve(bytes);
    const grid = this.pool.grid();
    grid.set(b.dist);
    const d: ChunkDetail = { grid, index, used: 0, bytes };
    this.live.set(ck(cx, cy), d);
    this.pool.bytes += bytes;
    this.cellsRebuilt += FINE_NAV_SIDE * FINE_NAV_SIDE;
    return d;
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
