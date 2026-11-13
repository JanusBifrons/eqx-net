/**
 * Per-tick AI neighbour grid (AI steering plan, slice 2a).
 *
 * A uniform hashed grid over this tick's kind-1 combat drones (every
 * allegiance) and engageable pilot hulls, rebuilt ONCE per tick by
 * `runAiTick` before the AI controller ticks, and handed to every behaviour as
 * `AiWorldView.neighbours`. It answers "the K nearest combatants within r of
 * me" in O(entries in the covered cells) instead of a scan of every list.
 *
 * Layout follows `ProjectileBroadphase`: flat typed arrays by dense index, a
 * fixed hashed bucket table (`head`) with an intrusive `next` chain. Each entry
 * is a point and lives in exactly one cell; it also stores its cell coords, so
 * a walk that meets a hash-colliding cell's entry skips it exactly (no
 * de-dup stamps needed).
 *
 * Allocation-free in steady state (invariant #14): `begin`/`add`/
 * `queryNeighbours` allocate nothing; the arrays double only when a build
 * passes the high-water mark.
 *
 * Cell size: `NEIGHBOUR_CELL_SEPARATIONS` × the default fighter's
 * `flockSeparation` (shipTuning, #18 — 150 u at 1×, so 600 u cells). Combat
 * separation queries (r ≈ one separation) then touch 1–4 cells; wider
 * queries (fire lanes, local force counts) a few more.
 */
import type { IAiNeighbourQuery } from '../../core/contracts/IAiBehaviour.js';
import { NPC_ALLEGIANCE_IDS, PLAYERS_SIDE } from '../../shared-types/allegiances.js';
import { GLOBAL_SHIP_TUNING } from '../../shared-types/shipScale/lookup.js';

/** Cell edge in fighter separations (see header). */
export const NEIGHBOUR_CELL_SEPARATIONS = 4;
/** A query wider than this many cells on an axis scans every entry instead. */
const MAX_QUERY_CELLS = 16;
/** Guard band on the cell window: a squared distance can round down to r²
 *  for an entry just past r (or past a cell edge), so the window reaches
 *  1 u further; the distance test still decides. */
const GUARD = 1;
const TABLE_BITS = 12;
const TABLE_SIZE = 1 << TABLE_BITS;
const TABLE_MASK = TABLE_SIZE - 1;

/** Side codes: 0 = pilots, 1 + i = `NPC_ALLEGIANCE_IDS[i]`. */
const SIDES: readonly string[] = [PLAYERS_SIDE, ...NPC_ALLEGIANCE_IDS];

function bucketOf(cx: number, cy: number): number {
  return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & TABLE_MASK;
}

export class AiNeighbourGrid implements IAiNeighbourQuery {
  readonly cell: number;
  private readonly inv: number;
  count = 0;
  /** Queries since the last `begin` (this tick so far). */
  queriesThisTick = 0;
  /** Queries in the previous complete build window. */
  lastTickQueries = 0;
  /** Running total of every query (perf scene counters read deltas). */
  queriesTotal = 0;

  private readonly ids: string[] = [];
  private xs = new Float64Array(64);
  private ys = new Float64Array(64);
  private vxs = new Float64Array(64);
  private vys = new Float64Array(64);
  private radii = new Float64Array(64);
  private side = new Uint8Array(64);
  private cellX = new Int32Array(64);
  private cellY = new Int32Array(64);
  private next = new Int32Array(64);
  private readonly head = new Int32Array(TABLE_SIZE).fill(-1);
  /** Query scratch: squared distances of the current best K. */
  private bestD2 = new Float64Array(16);

  constructor(cell: number = NEIGHBOUR_CELL_SEPARATIONS * GLOBAL_SHIP_TUNING.flockSeparation) {
    this.cell = cell;
    this.inv = 1 / cell;
  }

  /** Entry capacity (grows by doubling; never shrinks). */
  get capacity(): number {
    return this.xs.length;
  }

  /** Start a rebuild. */
  begin(): void {
    this.head.fill(-1);
    this.count = 0;
    this.lastTickQueries = this.queriesThisTick;
    this.queriesThisTick = 0;
  }

  /** Add a pilot hull. */
  addPilot(id: string, x: number, y: number, vx: number, vy: number, radius: number): void {
    this.add(id, x, y, vx, vy, radius, 0);
  }

  /** Add a combat drone of `allegiance` (an `NpcAllegianceId`). */
  addDrone(id: string, x: number, y: number, vx: number, vy: number, radius: number, allegiance: string): void {
    const a = NPC_ALLEGIANCE_IDS.indexOf(allegiance as (typeof NPC_ALLEGIANCE_IDS)[number]);
    this.add(id, x, y, vx, vy, radius, a < 0 ? 1 : a + 1);
  }

  /** Finish a rebuild: drop id refs past the new count. */
  end(): void {
    const ids = this.ids;
    for (let i = this.count; i < ids.length && ids[i] !== ''; i++) ids[i] = '';
  }

  private add(id: string, x: number, y: number, vx: number, vy: number, radius: number, side: number): void {
    // A non-finite pose would poison every query's distances; never expected.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const i = this.count++;
    if (i >= this.xs.length) this.grow(i + 1);
    this.ids[i] = id;
    this.xs[i] = x; this.ys[i] = y; this.vxs[i] = vx; this.vys[i] = vy;
    this.radii[i] = radius; this.side[i] = side;
    const cx = Math.floor(x * this.inv), cy = Math.floor(y * this.inv);
    this.cellX[i] = cx; this.cellY[i] = cy;
    const h = bucketOf(cx, cy);
    this.next[i] = this.head[h]!;
    this.head[h] = i;
  }

  queryNeighbours(x: number, y: number, r: number, maxK: number, outIdx: Int32Array, excludeId?: string): number {
    this.queriesThisTick++;
    this.queriesTotal++;
    let k = maxK < outIdx.length ? maxK : outIdx.length;
    if (k <= 0 || this.count === 0 || !(r >= 0)) return 0;
    if (k > this.bestD2.length) {
      // TODO: alloc-debt — grows once to the largest K ever asked (amortised).
      this.bestD2 = new Float64Array(Math.max(k, this.bestD2.length * 2));
    }
    if (k > this.count) k = this.count;
    const r2 = r * r;
    const inv = this.inv;
    const rg = r + GUARD;
    const c0 = Math.floor((x - rg) * inv), c1 = Math.floor((x + rg) * inv);
    const r0 = Math.floor((y - rg) * inv), r1 = Math.floor((y + rg) * inv);
    let n = 0;
    if (c1 - c0 < MAX_QUERY_CELLS && r1 - r0 < MAX_QUERY_CELLS) {
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          for (let e = this.head[bucketOf(cx, cy)]!; e !== -1; e = this.next[e]!) {
            if (this.cellX[e] !== cx || this.cellY[e] !== cy) continue;
            n = this.consider(e, x, y, r2, k, n, outIdx, excludeId);
          }
        }
      }
    } else {
      for (let e = 0; e < this.count; e++) n = this.consider(e, x, y, r2, k, n, outIdx, excludeId);
    }
    return n;
  }

  /** Insert entry `e` into the sorted best-K prefix if it qualifies. */
  private consider(e: number, x: number, y: number, r2: number, k: number, n: number, out: Int32Array, excludeId: string | undefined): number {
    const dx = this.xs[e]! - x, dy = this.ys[e]! - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) return n;
    if (excludeId !== undefined && this.ids[e] === excludeId) return n;
    const best = this.bestD2;
    // Full and not better than the worst kept (ties: lower index wins).
    if (n === k && (d2 > best[n - 1]! || (d2 === best[n - 1]! && e > out[n - 1]!))) return n;
    let j = n < k ? n : k - 1;
    while (j > 0 && (best[j - 1]! > d2 || (best[j - 1]! === d2 && out[j - 1]! > e))) {
      best[j] = best[j - 1]!;
      out[j] = out[j - 1]!;
      j--;
    }
    best[j] = d2;
    out[j] = e;
    return n < k ? n + 1 : n;
  }

  idAt(i: number): string { return this.ids[i]!; }
  xAt(i: number): number { return this.xs[i]!; }
  yAt(i: number): number { return this.ys[i]!; }
  vxAt(i: number): number { return this.vxs[i]!; }
  vyAt(i: number): number { return this.vys[i]!; }
  radiusAt(i: number): number { return this.radii[i]!; }
  sideAt(i: number): string { return SIDES[this.side[i]!]!; }
  isPilotAt(i: number): boolean { return this.side[i] === 0; }

  // TODO: alloc-debt — amortised doubling past the entity high-water mark.
  private grow(need: number): void {
    let n = this.xs.length * 2;
    while (n < need) n *= 2;
    this.xs = growF(this.xs, n); this.ys = growF(this.ys, n);
    this.vxs = growF(this.vxs, n); this.vys = growF(this.vys, n);
    this.radii = growF(this.radii, n);
    const s = new Uint8Array(n); s.set(this.side); this.side = s;
    this.cellX = growI(this.cellX, n); this.cellY = growI(this.cellY, n);
    this.next = growI(this.next, n);
  }
}

function growF(a: Float64Array<ArrayBuffer>, n: number): Float64Array<ArrayBuffer> {
  const b = new Float64Array(n);
  b.set(a);
  return b;
}

function growI(a: Int32Array<ArrayBuffer>, n: number): Int32Array<ArrayBuffer> {
  const b = new Int32Array(n);
  b.set(a);
  return b;
}
