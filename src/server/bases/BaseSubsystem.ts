/**
 * Server side of procedural bases (plan: soft-leaping-truffle, PR-V2).
 *
 * Single responsibility: own this sector's base layouts and answer the
 * questions the rest of the room asks about them.
 *  - `add` generates the layout (shared core generator), writes the
 *    descriptor into room state (joiners regenerate from it — Invariant #16),
 *    and tells the physics worker to spawn its colliders (the worker
 *    regenerates too; no geometry crosses the thread boundary).
 *  - `rayFirst` / `segmentBlocked` — the weapon-blocking queries the fire
 *    paths call next to the shield-wall hooks. Allocation-free (Invariant #14).
 *  - `isPointClear` / `findClearSpawn` — keep spawns and arrivals out of
 *    solid geometry (the colliders are hollow outlines, so a body placed
 *    inside one would be trapped).
 *
 * Decision logic over injected hooks (the TransitOrchestrator pattern), so it
 * is unit-testable without a room.
 */
import { BASE_GENERATOR_VERSION, type BaseDescriptor, type BaseLayout } from '../../core/procgen/baseLayout.js';
import { generateBase } from '../../core/procgen/generateBase.js';
import { BaseRayGrid } from '../../core/procgen/baseRayGrid.js';
import { isPieceDead } from '../../core/procgen/baseChunkMesh.js';
import { basePieceKindAt } from '../../shared-types/basePieceKinds.js';
import { MAX_PIECES_PER_SECTOR } from '../../shared-types/baseBudgets.js';

export interface BaseSpec {
  readonly archetype: 'warehouse';
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
}

interface LiveBase {
  readonly id: string;
  readonly layout: BaseLayout;
  readonly grid: BaseRayGrid;
  dead: Uint32Array;
  /** World AABB for quick rejects. */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export class BaseSubsystem {
  private readonly bases: LiveBase[] = [];
  private pieceTotal = 0;

  constructor(private readonly deps: BaseSubsystemDeps) {}

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
    this.bases.push({
      id,
      layout,
      grid,
      dead: new Uint32Array(Math.ceil(layout.count / 32)),
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

  /** Distance along the unit ray to the nearest base wall within maxDist, or -1. */
  rayFirst(ox: number, oy: number, dx: number, dy: number, maxDist: number): number {
    let best = -1;
    for (let i = 0; i < this.bases.length; i++) {
      const b = this.bases[i]!;
      if (!rayMayHitBox(ox, oy, dx, dy, maxDist, b)) continue;
      const t = b.grid.rayFirst(ox, oy, dx, dy, best >= 0 ? best : maxDist);
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
    return best;
  }

  /** True when the segment (x,y)→(x+sx,y+sy) crosses a base wall. */
  segmentBlocked(x: number, y: number, sx: number, sy: number): boolean {
    const len = Math.hypot(sx, sy);
    if (len === 0 || this.bases.length === 0) return false;
    return this.rayFirst(x, y, sx / len, sy / len, len) >= 0;
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
