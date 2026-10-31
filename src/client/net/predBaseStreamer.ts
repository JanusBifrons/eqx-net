/**
 * Client predWorld side of procedural bases (plan: soft-leaping-truffle, PR-V2).
 *
 * The server worker holds every chunk of every base. The client predWorld only
 * instantiates chunks within PREDWORLD_ACTIVE_RADIUS of the local ship
 * (chunk streaming): every reconcile replays ~20 ticks, and a phone is ~4× a
 * desktop, so the client must not carry a whole sector of colliders into each
 * replay (budget MAX_CLIENT_ACTIVE_PIECES, see baseBudgets.ts).
 *
 * Geometry comes from the SAME shared functions the worker uses
 * (`generateBase` → `buildChunkOutlines`) from the room-state descriptor, so
 * client and server colliders are identical by construction (Invariant #15).
 *
 * `sync` runs per snapshot; in steady state it allocates nothing (Invariant
 * #14): per-base `active` flags in a Uint8Array, a reused bounds scratch.
 * Generation (first sight of a base) allocates once.
 */
import type { PhysicsWorld } from '../../core/physics/World.js';
import { generateBase } from '../../core/procgen/generateBase.js';
import { buildChunkOutlines, chunkBounds, type ChunkOutline } from '../../core/procgen/baseChunkMesh.js';
import type { BaseDescriptor, BaseLayout } from '../../core/procgen/baseLayout.js';
import { PREDWORLD_ACTIVE_RADIUS } from '../../shared-types/baseBudgets.js';

/** The room-state fields a base descriptor is read from. */
export interface BaseStateView {
  readonly ver: number;
  readonly archetype: string;
  readonly seed: number;
  readonly originX: number;
  readonly originY: number;
  readonly size: number;
}

interface StreamedBase {
  readonly layout: BaseLayout;
  readonly outlines: ChunkOutline[];
  readonly active: Uint8Array;
  /** Generation stamp — bases not seen this sync are torn down. */
  seen: number;
}

export class PredBaseStreamer {
  private readonly bases = new Map<string, StreamedBase>();
  private readonly bounds = new Float64Array(4);
  private gen = 0;

  constructor(private readonly radius = PREDWORLD_ACTIVE_RADIUS) {}

  /**
   * Bring the predWorld's base chunks in line with the descriptors in
   * `states` and the local ship position. `states` is the Colyseus
   * `state.bases` MapSchema (anything with `forEach((value, key) => …)`).
   */
  sync(
    world: PhysicsWorld,
    states: { forEach(cb: (value: BaseStateView, key: string) => void): void } | undefined,
    shipX: number,
    shipY: number,
  ): void {
    this.gen = (this.gen + 1) >>> 0;
    const gen = this.gen;
    if (states) {
      states.forEach((st, id) => {
        let b = this.bases.get(id);
        if (!b) {
          const desc: BaseDescriptor = {
            ver: st.ver,
            archetype: st.archetype as BaseDescriptor['archetype'],
            seed: st.seed,
            x: st.originX,
            y: st.originY,
            size: st.size,
          };
          const layout = generateBase(desc);
          const outlines = buildChunkOutlines(layout);
          b = { layout, outlines, active: new Uint8Array(outlines.length), seen: gen };
          this.bases.set(id, b);
        }
        b.seen = gen;
        this.streamChunks(world, id, b, shipX, shipY);
      });
    }
    for (const [id, b] of this.bases) {
      if (b.seen === gen) continue;
      for (let c = 0; c < b.active.length; c++) if (b.active[c]) world.removeBaseChunk(id, c);
      this.bases.delete(id);
    }
  }

  private streamChunks(world: PhysicsWorld, id: string, b: StreamedBase, sx: number, sy: number): void {
    const r2 = this.radius * this.radius;
    for (let c = 0; c < b.outlines.length; c++) {
      chunkBounds(b.layout, c, this.bounds);
      // Distance from the ship to the chunk's AABB.
      const dx = Math.max(this.bounds[0]! - sx, 0, sx - this.bounds[2]!);
      const dy = Math.max(this.bounds[1]! - sy, 0, sy - this.bounds[3]!);
      const want = dx * dx + dy * dy <= r2;
      if (want && !b.active[c]) {
        const o = b.outlines[c]!;
        world.spawnBaseChunk(id, c, o.vertices, o.indices);
        b.active[c] = 1;
      } else if (!want && b.active[c]) {
        world.removeBaseChunk(id, c);
        b.active[c] = 0;
      }
    }
  }

  /** Forget all streamed state WITHOUT touching a world — call when the
   *  predWorld instance itself is (re)created, so stale `active` flags can't
   *  claim chunks exist in a world that never had them. */
  reset(): void {
    this.bases.clear();
  }

  /** Total chunks currently instantiated (budget-lock seam). */
  activeChunkCount(): number {
    let n = 0;
    for (const b of this.bases.values()) for (let c = 0; c < b.active.length; c++) n += b.active[c]!;
    return n;
  }

  /** Layouts by base id — the renderer reuses them (no second generation). */
  layouts(): ReadonlyMap<string, StreamedBase> {
    return this.bases;
  }
}
