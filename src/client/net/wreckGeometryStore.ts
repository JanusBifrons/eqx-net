/**
 * Capital destruction S2b — the client's wreck geometry, rebuilt from the
 * `wrecks[]` snapshot descriptor (docs/architecture/capital-destruction.md §S2).
 *
 * No vertex is on the wire: each descriptor carries the fracture inputs, and
 * the SAME deterministic `wreckPieceGeometry` the server used to build its
 * bodies rebuilds every piece here (#15). The pieces are cached per wreckId
 * and computed lazily (once per wreck), so the predWorld twin
 * (`wreckClientLeaf`) and the drawing (`swarmSpriteUpdater`) read one result.
 *
 * Two owners, one class: `ColyseusClient` keeps one fed from the snapshot
 * (`apply`), and the renderer keeps its own, fed from `RenderMirror.wrecks`
 * (`geometryFor`) — the renderer may run in a worker, which has its own heap.
 *
 * A descriptor from another `FRACTURE_ALGO_VERSION` is dropped, never guessed
 * at: its pieces then have no body and no sprite until the versions agree.
 */
import { wreckPieceGeometry, type WreckPieceGeometry } from '@core/destruction/wreckPieces';
import { FRACTURE_ALGO_VERSION } from '@core/destruction/fractureHull';
import { isShipKindId, type ShipKindId } from '@shared-types/shipKinds';
import type { WreckDescriptor } from '@shared-types/messages/snapshotMessages';

interface Entry {
  desc: WreckDescriptor;
  pieces: WreckPieceGeometry[] | null;
  gen: number;
}

function sameInputs(a: WreckDescriptor, b: WreckDescriptor): boolean {
  return a.parentKind === b.parentKind && a.seed === b.seed && a.killX === b.killX && a.killY === b.killY
    && a.killBlowDamage === b.killBlowDamage && a.recentDamageRate === b.recentDamageRate
    && a.snapChance === b.snapChance && a.algoVersion === b.algoVersion;
}

/** Is this descriptor one this client can rebuild? */
export function wreckDescriptorUsable(d: WreckDescriptor): boolean {
  return d.algoVersion === FRACTURE_ALGO_VERSION && isShipKindId(d.parentKind);
}

/** The deterministic pieces of one wreck (pure; the parity tests call it). */
export function rebuildWreckPieces(d: WreckDescriptor): WreckPieceGeometry[] {
  return wreckPieceGeometry({
    kindId: d.parentKind as ShipKindId,
    seed: d.seed,
    killX: d.killX,
    killY: d.killY,
    killBlowDamage: d.killBlowDamage,
    recentDamageRate: d.recentDamageRate,
    snapChance: d.snapChance,
  });
}

export class WreckGeometryStore {
  private readonly byId = new Map<number, Entry>();
  /** wreckId → descriptor of every usable wreck (what `RenderMirror.wrecks` holds). */
  readonly descriptors = new Map<number, WreckDescriptor>();
  private gen = 0;
  /** Descriptors dropped for an algorithm-version or kind mismatch. */
  rejected = 0;

  /**
   * Apply one snapshot's `wrecks[]` (the full list of live wrecks): add new
   * wrecks, rebuild any whose inputs changed (a recycled wreckId), drop the
   * ones no longer listed. Allocates only for a NEW wreck (a death event);
   * a steady list is a map walk.
   */
  apply(list: readonly WreckDescriptor[]): void {
    const gen = ++this.gen;
    for (let i = 0; i < list.length; i++) {
      const d = list[i]!;
      if (!wreckDescriptorUsable(d)) {
        this.rejected++;
        continue;
      }
      this.touch(d, gen);
    }
    for (const [id, e] of this.byId) {
      if (e.gen !== gen) {
        this.byId.delete(id);
        this.descriptors.delete(id);
      }
    }
  }

  private touch(d: WreckDescriptor, gen: number): Entry {
    let e = this.byId.get(d.wreckId);
    if (e === undefined || !sameInputs(e.desc, d)) {
      e = { desc: d, pieces: null, gen }; // a new wreck (death event)
      this.byId.set(d.wreckId, e);
    }
    e.desc = d;
    e.gen = gen;
    this.descriptors.set(d.wreckId, d);
    return e;
  }

  /** Is this wreck known (and rebuildable)? */
  has(wreckId: number): boolean {
    return this.byId.has(wreckId);
  }

  /** One piece of a known wreck, or null (unknown wreck / bad index). The
   *  wreck's pieces are fractured on the first call and cached. */
  piece(wreckId: number, index: number): WreckPieceGeometry | null {
    const e = this.byId.get(wreckId);
    if (e === undefined) return null;
    if (e.pieces === null) e.pieces = rebuildWreckPieces(e.desc);
    return e.pieces[index] ?? null;
  }

  /** Renderer path: the pieces for a descriptor read off the mirror (a fresh
   *  structured clone each frame in the worker, so inputs are compared by
   *  value). Null for an unusable descriptor. */
  geometryFor(d: WreckDescriptor): WreckPieceGeometry[] | null {
    if (!wreckDescriptorUsable(d)) return null;
    const e = this.touch(d, this.gen);
    if (e.pieces === null) e.pieces = rebuildWreckPieces(e.desc);
    return e.pieces;
  }

  /** Renderer path: forget wrecks the mirror no longer lists. */
  retain(live: ReadonlyMap<number, unknown>): void {
    if (this.byId.size <= live.size) return;
    for (const id of this.byId.keys()) {
      if (!live.has(id)) {
        this.byId.delete(id);
        this.descriptors.delete(id);
      }
    }
  }

  clear(): void {
    this.byId.clear();
    this.descriptors.clear();
  }

  size(): number {
    return this.byId.size;
  }
}
