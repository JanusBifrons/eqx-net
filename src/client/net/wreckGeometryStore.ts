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
 * Two owners, one class: `ColyseusClient` keeps one fed from the welcome's
 * full set (`apply`) and each snapshot's deltas + resync chunk
 * (`applySnapshot`, sub-capital break-up slice 3), and the renderer keeps its
 * own, fed from `RenderMirror.wrecks`
 * (`geometryFor`) — the renderer may run in a worker, which has its own heap.
 *
 * A descriptor from another `FRACTURE_ALGO_VERSION` is dropped, never guessed
 * at: its pieces then have no body and no sprite until the versions agree.
 *
 * CHILD wrecks (salvage stream; capital-destruction.md §S4 "Re-split"): a
 * descriptor with `parentWreck` / `parentPiece` is one step of a
 * `WreckChildChain`. Its pieces are resolved by walking parent descriptors to
 * the root and calling the shared `wreckChildGeometry`. A child whose
 * ancestor is not (yet) known is DEFERRED, not dropped: it is kept, its
 * pieces read as null (no body, no sprite), and resolution is retried on the
 * first lookup after any wreck arrives or leaves (welcome / adds / resync
 * may land a child before its parent). A resolved child re-checks its
 * ancestors only after the wreck set changed, and rebuilds if one was
 * replaced (a recycled id). Contract: the server keeps every ancestor on
 * the wire while a descendant lives; an ancestor that leaves first leaves
 * its descendants unresolved (null) until it is back.
 */
import { wreckPieceGeometry, type WreckPieceGeometry } from '@core/destruction/wreckPieces';
import { wreckChildGeometry, wreckChildSeed, type WreckChildStep } from '@core/destruction/wreckChildren';
import { FRACTURE_ALGO_VERSION } from '@core/destruction/fractureHull';
import { isShipKindId, type ShipKindId } from '@shared-types/shipKinds';
import { isWreckDescriptor, isWreckId, type SnapshotMessage, type WreckDescriptor, type WreckSync } from '@shared-types/messages/snapshotMessages';

/** Deepest child chain the client resolves (a guard against a parent cycle
 *  on a malformed wire; real chains are a few breaks deep). */
export const MAX_WRECK_CHAIN_DEPTH = 16;

interface Entry {
  desc: WreckDescriptor;
  pieces: WreckPieceGeometry[] | null;
  gen: number;
  /** A child: the ancestor entries (parent first) its pieces were resolved
   *  against; empty for a root or an unresolved child. */
  anc: Entry[];
  /** The store `epoch` this child was last resolved or checked at. */
  checked: number;
}

function sameInputs(a: WreckDescriptor, b: WreckDescriptor): boolean {
  return a.parentKind === b.parentKind && a.seed === b.seed && a.killX === b.killX && a.killY === b.killY
    && a.killBlowDamage === b.killBlowDamage && a.recentDamageRate === b.recentDamageRate
    && a.snapChance === b.snapChance && a.algoVersion === b.algoVersion
    && a.cutKind === b.cutKind && a.cutAng === b.cutAng && a.cutW === b.cutW
    && sameExtraCuts(a.extraCuts, b.extraCuts)
    && a.parentWreck === b.parentWreck && a.parentPiece === b.parentPiece;
}

/** Fracture v12: the same further cut lines, in the same order. */
function sameExtraCuts(a: WreckDescriptor['extraCuts'], b: WreckDescriptor['extraCuts']): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p.x !== q.x || p.y !== q.y || p.ang !== q.ang || p.w !== q.w) return false;
  }
  return true;
}

/** The step a child descriptor names (its break of its parent's piece). */
function stepOf(d: WreckDescriptor): WreckChildStep {
  return {
    pieceIndex: d.parentPiece!, killX: d.killX, killY: d.killY, cutKind: d.cutKind, cutAng: d.cutAng, cutW: d.cutW,
    extraCuts: d.extraCuts,
  };
}

/**
 * The pieces of a child descriptor, resolving its chain through `lookup`
 * (pure; the parity tests call it). Null when an ancestor is unknown, the
 * chain is deeper than `MAX_WRECK_CHAIN_DEPTH`, or a link disagrees with its
 * parent (kind, fracture version, or a seed that is not
 * `wreckChildSeed(parent.seed, parentPiece)`). `ancOut`, when given, gets the
 * ancestor descriptors parent first.
 */
export function resolveChildWreckPieces(
  d: WreckDescriptor,
  lookup: (wreckId: number) => WreckDescriptor | undefined,
  ancOut?: WreckDescriptor[],
): WreckPieceGeometry[] | null {
  const steps: WreckChildStep[] = [];
  let cur = d;
  while (cur.parentWreck !== undefined) {
    if (steps.length >= MAX_WRECK_CHAIN_DEPTH) return null;
    const p = lookup(cur.parentWreck);
    if (p === undefined || p.parentKind !== cur.parentKind || p.algoVersion !== cur.algoVersion
      || cur.seed !== wreckChildSeed(p.seed, cur.parentPiece!)) return null;
    steps.push(stepOf(cur));
    ancOut?.push(p);
    cur = p;
  }
  steps.reverse();
  return wreckChildGeometry({
    root: {
      kindId: cur.parentKind as ShipKindId, seed: cur.seed, killX: cur.killX, killY: cur.killY,
      killBlowDamage: cur.killBlowDamage, recentDamageRate: cur.recentDamageRate, snapChance: cur.snapChance,
      cutKind: cur.cutKind, cutAng: cur.cutAng, cutW: cur.cutW, extraCuts: cur.extraCuts,
    },
    steps,
  });
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
    // The v9 kill cut rides as-is (absent = no cut).
    cutKind: d.cutKind,
    cutAng: d.cutAng,
    cutW: d.cutW,
    // v12 multi-cut: the other beams' lines, as-is too.
    extraCuts: d.extraCuts,
  });
}

export class WreckGeometryStore {
  private readonly byId = new Map<number, Entry>();
  /** wreckId → descriptor of every usable wreck (what `RenderMirror.wrecks` holds). */
  readonly descriptors = new Map<number, WreckDescriptor>();
  private gen = 0;
  /** Bumped whenever a wreck arrives, is replaced or leaves: a deferred
   *  child retries, and a resolved one re-checks its ancestors, only then. */
  private epoch = 0;
  private readonly ancScratch: Entry[] = [];
  private readonly lookupDesc = (id: number): WreckDescriptor | undefined => {
    const p = this.byId.get(id);
    if (p !== undefined) this.ancScratch.push(p);
    return p?.desc;
  };
  /** Descriptors dropped for an algorithm-version or kind mismatch. */
  rejected = 0;

  /** Resync sweep context (set per `resync`, read by the bound visitor). */
  private syncLo = 0;
  private syncHi = 0;
  private syncGen = 0;
  private readonly sweepRange = (e: Entry, id: number): void => {
    if (id >= this.syncLo && id < this.syncHi && e.gen !== this.syncGen) {
      this.byId.delete(id);
      this.epoch++;
      this.descriptors.delete(id);
    }
  };

  /**
   * Apply the FULL list of live wrecks (the welcome's `wrecks`): add new
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
        this.epoch++;
        this.descriptors.delete(id);
      }
    }
  }

  /**
   * Apply one snapshot's wreck deltas (sub-capital break-up slice 3):
   * the resync chunk first, then removes, then adds (deltas are never older
   * than the chunk they ride with). Idempotent: an add of a known wreck with
   * the same inputs, a remove of an unknown id and a chunk that agrees are
   * all no-ops, so the repeats of a window cost a map lookup each. Malformed
   * entries are dropped (`rejected`), never applied: the snapshot is the
   * documented #3 carve-out, so these fields are checked here, alloc-free.
   * Returns true when the snapshot carried any wreck field.
   */
  applySnapshot(snap: SnapshotMessage): boolean {
    const sync = snap.wreckSync;
    const removes = snap.wreckRemoves;
    const adds = snap.wreckAdds;
    if (sync !== undefined) this.resync(sync);
    if (removes !== undefined) this.remove(removes);
    if (adds !== undefined) this.add(adds);
    return sync !== undefined || removes !== undefined || adds !== undefined;
  }

  /** New (or recycled) wrecks. */
  add(list: readonly WreckDescriptor[]): void {
    if (!Array.isArray(list)) { this.rejected++; return; }
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!isWreckDescriptor(d) || !wreckDescriptorUsable(d)) { this.rejected++; continue; }
      this.touch(d, this.gen);
    }
  }

  /** Wrecks gone (every piece left the world). Unknown ids are no-ops. */
  remove(ids: readonly number[]): void {
    if (!Array.isArray(ids)) { this.rejected++; return; }
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!isWreckId(id)) { this.rejected++; continue; }
      this.byId.delete(id);
      this.epoch++;
      this.descriptors.delete(id);
    }
  }

  /** A resync chunk: the live wrecks with `lo <= id < hi` are exactly `d`. */
  resync(sync: WreckSync): void {
    if (typeof sync !== 'object' || sync === null || !Array.isArray(sync.d)
      || !Number.isInteger(sync.lo) || !Number.isInteger(sync.hi)) { this.rejected++; return; }
    const gen = ++this.gen;
    for (let i = 0; i < sync.d.length; i++) {
      const d = sync.d[i];
      if (!isWreckDescriptor(d) || d.wreckId < sync.lo || d.wreckId >= sync.hi) { this.rejected++; continue; }
      if (!wreckDescriptorUsable(d)) { this.rejected++; continue; }
      this.touch(d, gen);
    }
    this.syncLo = sync.lo;
    this.syncHi = sync.hi;
    this.syncGen = gen;
    this.byId.forEach(this.sweepRange);
  }

  private touch(d: WreckDescriptor, gen: number): Entry {
    let e = this.byId.get(d.wreckId);
    if (e === undefined || !sameInputs(e.desc, d)) {
      e = { desc: d, pieces: null, gen, anc: [], checked: -1 }; // a new wreck (death event)
      this.epoch++;
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

  /** One piece of a known wreck, or null (unknown wreck / bad index / a
   *  child whose chain is not resolvable yet). The wreck's pieces are
   *  fractured on the first call and cached. */
  piece(wreckId: number, index: number): WreckPieceGeometry | null {
    const e = this.byId.get(wreckId);
    if (e === undefined) return null;
    const pieces = this.resolve(e);
    return pieces === null ? null : pieces[index] ?? null;
  }

  /** Renderer path: the pieces for a descriptor read off the mirror (a fresh
   *  structured clone each frame in the worker, so inputs are compared by
   *  value). Null for an unusable descriptor or an unresolved child. */
  geometryFor(d: WreckDescriptor): WreckPieceGeometry[] | null {
    if (!wreckDescriptorUsable(d)) return null;
    return this.resolve(this.touch(d, this.gen));
  }

  /** A wreck's pieces: a root's fractured once; a child's resolved through
   *  its parents (deferred while one is missing, see the header). Allocates
   *  only when it fractures (once per wreck, or a retry after the wreck set
   *  changed while an ancestor was missing). */
  private resolve(e: Entry): WreckPieceGeometry[] | null {
    if (e.desc.parentWreck === undefined) {
      if (e.pieces === null) e.pieces = rebuildWreckPieces(e.desc);
      return e.pieces;
    }
    if (e.checked === this.epoch) return e.pieces;
    e.checked = this.epoch;
    if (e.pieces !== null && this.ancestorsSame(e)) return e.pieces;
    const anc = this.ancScratch;
    anc.length = 0;
    e.pieces = resolveChildWreckPieces(e.desc, this.lookupDesc);
    e.anc.length = 0;
    if (e.pieces !== null) for (let i = 0; i < anc.length; i++) e.anc.push(anc[i]!);
    anc.length = 0;
    return e.pieces;
  }

  /** Are the entries this child resolved against still its live ancestors? */
  private ancestorsSame(e: Entry): boolean {
    let d = e.desc;
    for (let i = 0; i < e.anc.length; i++) {
      if (d.parentWreck === undefined || this.byId.get(d.parentWreck) !== e.anc[i]) return false;
      d = e.anc[i]!.desc;
    }
    return d.parentWreck === undefined;
  }

  /** Renderer path: forget wrecks the mirror no longer lists. */
  retain(live: ReadonlyMap<number, unknown>): void {
    if (this.byId.size <= live.size) return;
    for (const id of this.byId.keys()) {
      if (!live.has(id)) {
        this.byId.delete(id);
        this.epoch++;
        this.descriptors.delete(id);
      }
    }
  }

  clear(): void {
    this.epoch++;
    this.byId.clear();
    this.descriptors.clear();
  }

  size(): number {
    return this.byId.size;
  }
}
