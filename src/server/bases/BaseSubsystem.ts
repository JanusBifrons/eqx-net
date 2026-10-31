/**
 * Server side of procedural bases (plan: soft-leaping-truffle, PR-V2 + PR-D).
 *
 * Single responsibility: own this sector's base layouts and answer the
 * questions the rest of the room asks about them.
 *  - `add` generates the layout (shared core generator), writes the
 *    descriptor into room state (joiners regenerate from it — Invariant #16),
 *    and tells the physics worker to spawn its colliders (the worker
 *    regenerates too; no geometry crosses the thread boundary).
 *  - `rayFirst` / `segmentBlocked` — weapon-blocking queries (no damage).
 *  - `shotHit` / `projectileHit` (PR-D) — the same queries, and the piece at
 *    the impact point takes the damage. When its hit points run out its whole
 *    GROUP (a piece the layout builder split at chunk lines) is destroyed:
 *    destroy bits go into room state (late joiners see the hole), the worker
 *    rebuilds the base's colliders without it, and the ray grid is rebuilt.
 *  - `isPointClear` / `findClearSpawn` — keep spawns out of solid geometry.
 *
 * Decision logic over injected hooks (the TransitOrchestrator pattern), so it
 * is unit-testable without a room. Per-hit work allocates nothing except on
 * the (rare) destroy path.
 */
import { BASE_GENERATOR_VERSION, type BaseArchetype, type BaseDescriptor, type BaseLayout } from '../../core/procgen/baseLayout.js';
import { generateBase } from '../../core/procgen/generateBase.js';
import { BaseRayGrid } from '../../core/procgen/baseRayGrid.js';
import { isPieceDead } from '../../core/procgen/baseChunkMesh.js';
import { basePieceKindAt } from '../../shared-types/basePieceKinds.js';
import { BASE_CHUNK_SIZE, MAX_PIECES_PER_SECTOR } from '../../shared-types/baseBudgets.js';

export interface BaseSpec {
  readonly archetype: BaseArchetype;
  readonly seed: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface BaseSubsystemDeps {
  /** Post the worker command that spawns a base's colliders. */
  spawnInWorker(id: string, desc: BaseDescriptor): void;
  /** Write the descriptor into room state (`state.bases`). */
  writeState(id: string, desc: BaseDescriptor): void;
  /** A piece group was destroyed: publish the new destroy mask (room state)
   *  and rebuild the worker colliders. `destroyed` = layout piece indices. */
  onDestroyed?(id: string, dead: Uint32Array, destroyed: readonly number[]): void;
}

export interface BaseSubsystemOptions {
  /** Multiplies every piece's hit points (testMode bespoke trigger: 0.001 ⇒
   *  one shot breaks a piece). Default 1. */
  readonly hpScale?: number;
}

interface LiveBase {
  readonly id: string;
  readonly layout: BaseLayout;
  grid: BaseRayGrid;
  dead: Uint32Array;
  /** Remaining hit points per GROUP (indexed by group id). */
  readonly groupHp: Float32Array;
  /** Group id per piece (split siblings share one). */
  readonly group: Int32Array;
  /** World AABB for quick rejects. */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export class BaseSubsystem {
  private readonly bases: LiveBase[] = [];
  private pieceTotal = 0;
  private hpScale: number;
  /** Base index of the last hit found by `rayFirst` (-1 = none). */
  private lastHitBase = -1;

  constructor(private readonly deps: BaseSubsystemDeps, opts: BaseSubsystemOptions = {}) {
    this.hpScale = opts.hpScale ?? 1;
  }

  /** Generate + register a base. Throws if it would break the sector budget. */
  add(id: string, spec: BaseSpec): BaseLayout {
    const desc: BaseDescriptor = {
      ver: BASE_GENERATOR_VERSION,
      archetype: spec.archetype,
      seed: spec.seed >>> 0,
      x: Math.round(spec.x),
      y: Math.round(spec.y),
      size: Math.round(spec.size),
    };
    const layout = generateBase(desc);
    if (this.pieceTotal + layout.count > MAX_PIECES_PER_SECTOR) {
      throw new RangeError(`base ${id}: sector piece budget ${MAX_PIECES_PER_SECTOR} exceeded`);
    }
    this.pieceTotal += layout.count;
    const grid = new BaseRayGrid();
    grid.build(layout);
    const { group, groupCount } = groupSplitPieces(layout);
    const groupHp = new Float32Array(groupCount);
    for (let i = 0; i < layout.count; i++) {
      const g = group[i]!;
      if (groupHp[g] === 0) groupHp[g] = basePieceKindAt(layout.kind[i]!).hp * this.hpScale;
    }
    this.bases.push({
      id,
      layout,
      grid,
      dead: new Uint32Array(Math.ceil(layout.count / 32)),
      groupHp,
      group,
      minX: desc.x - layout.half,
      minY: desc.y - layout.half,
      maxX: desc.x + layout.half,
      maxY: desc.y + layout.half,
    });
    this.deps.writeState(id, desc);
    this.deps.spawnInWorker(id, desc);
    return layout;
  }

  get count(): number {
    return this.bases.length;
  }

  /** Set the hit-point multiplier before any base is added (room onCreate
   *  reads the testMode `baseHpScale` option after construction). */
  setHpScale(scale: number): void {
    if (this.bases.length > 0) throw new Error('setHpScale must run before add()');
    this.hpScale = scale;
  }

  /** Distance along the unit ray to the nearest base wall within maxDist, or -1. */
  rayFirst(ox: number, oy: number, dx: number, dy: number, maxDist: number): number {
    let best = -1;
    this.lastHitBase = -1;
    for (let i = 0; i < this.bases.length; i++) {
      const b = this.bases[i]!;
      if (!rayMayHitBox(ox, oy, dx, dy, maxDist, b)) continue;
      const t = b.grid.rayFirst(ox, oy, dx, dy, best >= 0 ? best : maxDist);
      if (t >= 0 && (best < 0 || t < best)) {
        best = t;
        this.lastHitBase = i;
      }
    }
    return best;
  }

  /** True when the segment (x,y)→(x+sx,y+sy) crosses a base wall. */
  segmentBlocked(x: number, y: number, sx: number, sy: number): boolean {
    const len = Math.hypot(sx, sy);
    if (len === 0 || this.bases.length === 0) return false;
    return this.rayFirst(x, y, sx / len, sy / len, len) >= 0;
  }

  /**
   * A beam/hitscan shot: distance to the first base wall (or -1), and the
   * piece at the impact point takes `damage`.
   */
  shotHit(ox: number, oy: number, dx: number, dy: number, maxDist: number, damage: number): number {
    const t = this.rayFirst(ox, oy, dx, dy, maxDist);
    if (t >= 0 && damage > 0) this.damageAtHit(ox + dx * (t + 2), oy + dy * (t + 2), damage);
    return t;
  }

  /** A projectile step: true when it hits a base wall (the piece takes damage). */
  projectileHit(x: number, y: number, sx: number, sy: number, damage: number): boolean {
    const len = Math.hypot(sx, sy);
    if (len === 0 || this.bases.length === 0) return false;
    const dx = sx / len, dy = sy / len;
    const t = this.rayFirst(x, y, dx, dy, len);
    if (t < 0) return false;
    if (damage > 0) this.damageAtHit(x + dx * (t + 2), y + dy * (t + 2), damage);
    return true;
  }

  /** Apply damage to the solid, alive piece containing (x,y) in the base the
   *  last ray hit. Allocation-free unless a group is destroyed. */
  private damageAtHit(x: number, y: number, damage: number): void {
    if (this.lastHitBase < 0) return;
    const b = this.bases[this.lastHitBase]!;
    const i = this.pieceContaining(b, x, y);
    if (i < 0) return;
    const g = b.group[i]!;
    if (basePieceKindAt(b.layout.kind[i]!).hp <= 0) return; // indestructible kind
    b.groupHp[g] = b.groupHp[g]! - damage;
    if (b.groupHp[g]! <= 0) this.destroyGroup(b, g);
  }

  /** Layout piece index of the solid alive piece containing (x,y), or -1. */
  private pieceContaining(b: LiveBase, x: number, y: number): number {
    const l = b.layout;
    const lx = x - l.descriptor.x;
    const ly = y - l.descriptor.y;
    const eps = 3;
    // Only pieces in the impact chunk or its neighbours can contain the point.
    const cx = Math.floor((lx + l.half) / BASE_CHUNK_SIZE);
    const cy = Math.floor((ly + l.half) / BASE_CHUNK_SIZE);
    for (let i = 0; i < l.count; i++) {
      const c = l.chunk[i]!;
      const pcx = c % l.chunksAcross;
      const pcy = (c - pcx) / l.chunksAcross;
      if (Math.abs(pcx - cx) > 1 || Math.abs(pcy - cy) > 1) continue;
      if (!basePieceKindAt(l.kind[i]!).solid || isPieceDead(b.dead, i)) continue;
      if (lx >= l.x[i]! - eps && lx <= l.x[i]! + l.w[i]! + eps && ly >= l.y[i]! - eps && ly <= l.y[i]! + l.h[i]! + eps) return i;
    }
    return -1;
  }

  private destroyGroup(b: LiveBase, g: number): void {
    const destroyed: number[] = [];
    for (let i = 0; i < b.layout.count; i++) {
      if (b.group[i] !== g || isPieceDead(b.dead, i)) continue;
      b.dead[i >>> 5] = b.dead[i >>> 5]! | (1 << (i & 31));
      destroyed.push(i);
    }
    if (destroyed.length === 0) return;
    const grid = new BaseRayGrid();
    grid.build(b.layout, b.dead);
    b.grid = grid;
    this.deps.onDestroyed?.(b.id, b.dead, destroyed);
  }

  /** Destroy mask for a base (tests / persistence). */
  deadMask(id: string): Uint32Array | null {
    for (const b of this.bases) if (b.id === id) return b.dead;
    return null;
  }

  /** True when a circle of radius r at (x,y) overlaps no solid, alive piece. */
  isPointClear(x: number, y: number, r: number): boolean {
    for (const b of this.bases) {
      if (x + r < b.minX || x - r > b.maxX || y + r < b.minY || y - r > b.maxY) continue;
      const l = b.layout;
      const lx = x - l.descriptor.x;
      const ly = y - l.descriptor.y;
      for (let i = 0; i < l.count; i++) {
        if (!basePieceKindAt(l.kind[i]!).solid || isPieceDead(b.dead, i)) continue;
        const nx = Math.max(l.x[i]!, Math.min(lx, l.x[i]! + l.w[i]!));
        const ny = Math.max(l.y[i]!, Math.min(ly, l.y[i]! + l.h[i]!));
        const ddx = lx - nx, ddy = ly - ny;
        if (ddx * ddx + ddy * ddy < r * r) return false;
      }
    }
    return true;
  }

  /**
   * The nearest clear point to (x,y) for a body of radius r: the point itself
   * if clear, else a deterministic outward ring search (8 bearings per ring,
   * 64 u ring step). Falls back to the input if nothing is found in range.
   */
  findClearSpawn(x: number, y: number, r: number, out: { x: number; y: number }): { x: number; y: number } {
    out.x = x;
    out.y = y;
    if (this.isPointClear(x, y, r)) return out;
    for (let ring = 1; ring <= 64; ring++) {
      const d = ring * 64;
      for (let k = 0; k < 8; k++) {
        const cx = x + d * RING_DX[k]!;
        const cy = y + d * RING_DY[k]!;
        if (this.isPointClear(cx, cy, r)) {
          out.x = cx;
          out.y = cy;
          return out;
        }
      }
    }
    return out;
  }
}

/**
 * Group pieces the layout builder split at chunk lines back into their parent:
 * two pieces of the same kind that meet edge-to-edge on a chunk line with
 * identical extents on the other axis are one logical piece. Union-find;
 * generation-time only.
 */
export function groupSplitPieces(l: BaseLayout): { group: Int32Array; groupCount: number } {
  const parent = new Int32Array(l.count);
  for (let i = 0; i < l.count; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
    return i;
  };
  const byEdge = new Map<string, number>();
  for (let i = 0; i < l.count; i++) {
    const x0 = l.x[i]!, y0 = l.y[i]!, x1 = x0 + l.w[i]!, y1 = y0 + l.h[i]!;
    // Register this piece's high edges; look up a neighbour's matching low edge.
    byEdge.set(`v|${l.kind[i]}|${x1}|${y0}|${y1}`, i);
    byEdge.set(`h|${l.kind[i]}|${y1}|${x0}|${x1}`, i);
  }
  for (let i = 0; i < l.count; i++) {
    const x0 = l.x[i]!, y0 = l.y[i]!, x1 = x0 + l.w[i]!, y1 = y0 + l.h[i]!;
    const left = byEdge.get(`v|${l.kind[i]}|${x0}|${y0}|${y1}`);
    if (left !== undefined && isChunkLine(x0, l.half)) parent[find(i)] = find(left);
    const below = byEdge.get(`h|${l.kind[i]}|${y0}|${x0}|${x1}`);
    if (below !== undefined && isChunkLine(y0, l.half)) parent[find(i)] = find(below);
  }
  const ids = new Map<number, number>();
  const group = new Int32Array(l.count);
  for (let i = 0; i < l.count; i++) {
    const r = find(i);
    let g = ids.get(r);
    if (g === undefined) { g = ids.size; ids.set(r, g); }
    group[i] = g;
  }
  return { group, groupCount: ids.size };
}

function isChunkLine(v: number, half: number): boolean {
  const off = v + half;
  return off > 0 && off % BASE_CHUNK_SIZE === 0;
}

const RING_DX = [1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2, 0, Math.SQRT1_2];
const RING_DY = [0, Math.SQRT1_2, 1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2];

function rayMayHitBox(
  ox: number, oy: number, dx: number, dy: number, maxDist: number,
  b: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  const ex = ox + dx * maxDist;
  const ey = oy + dy * maxDist;
  return !(
    Math.max(ox, ex) < b.minX || Math.min(ox, ex) > b.maxX ||
    Math.max(oy, ey) < b.minY || Math.min(oy, ey) > b.maxY
  );
}
