/**
 * Structure placement (speed-dial-resource-structures plan, Phase 2).
 *
 * Turns a validated `place_structure` request into a swarm entity + a
 * `StructureRegistry` record. Decision logic over injected hooks (no Colyseus,
 * no SAB) so it unit-tests like `TransitOrchestrator` — the `SectorRoom`
 * supplies the concretions (spawn, health seed, id, bounds clamp).
 *
 * Placement model (eqx-peri parity):
 *   - Every structure lands as a **blueprint / scaffolding**: 10 % HP
 *     (`SCAFFOLDING_HP_FRACTION`), `isConstructed = false`, non-operational.
 *     The grid pulse builds it up over time (Phase 3).
 *   - The **Capital** is the exception: `constructionCost === 0` ⇒ pre-built
 *     (full HP, `isConstructed = true`) so the first builds have something to
 *     draw from.
 *   - Placement does NOT pre-charge minerals — the cost is drained DURING
 *     construction by the flow economy (Phase 3), so a blueprint can be placed
 *     with an empty bank and simply waits.
 */
import {
  getStructureKind,
  isStructureKindId,
  structureKindToIndex,
  type StructureKindId,
  normaliseStructureRotation,
  structureHalfExtents,
} from '../../shared-types/structureKinds.js';
import {
  SCAFFOLDING_HP_FRACTION,
  CAPITAL_STARTING_MINERALS,
} from '../../core/structures/structureGridConstants.js';
import type { GridObstacle, ObstacleBox } from '../../core/structures/Grid.js';
import { placementRejection, placementRejectionNotice } from '../../core/structures/placementRules.js';
import { StructureRegistry, type StructureRecord } from './StructureRegistry.js';
import { autoConnectStructure, linkReachBox } from './structureGridView.js';
import { STARTER_STRUCTURE_KINDS, needsPackedCrate } from '../../shared-types/blueprints.js';
import { randomUUID } from 'node:crypto';
import { cloneHold, isHoldEmpty, takePackedOfProduct } from '../../core/cargo/hold.js';
import type { PackedItem } from '../../shared-types/items.js';
import { effectiveStructureMaxHealth } from '../../core/leveling/structureLevel.js';
import type { HoldStore } from '../cargo/HoldStore.js';
import type { StorageService } from '../cargo/StorageService.js';

/** A packed-structure check for one placement (Living World W4). `ok` false
 *  rejects it; `commit` consumes the packed item, as ONE HoldStore group, once
 *  the structure is registered (a failed spawn spends nothing). */
export interface PackedGateResult {
  ok: boolean;
  /** Consume the packed item; returns it (null if it vanished). */
  commit(): PackedItem | null;
}

export interface StructurePlacementHooks {
  /**
   * P2b seam (plan soft-leaping-truffle v3; user ruling: non-starter structures
   * are placed from a PACKED item). Called only for placements that pass
   * `requirePacked` (a player's `place_structure`), after the overlap rules and
   * before the spawn. Starter kinds never reach it. ABSENT ⇒ no check: every
   * kind builds from minerals, until packed structures can be bought (W4
   * injects it in the same PR).
   */
  packedGateForBuild?(owner: string, kindId: StructureKindId, sectorKey: string | null): PackedGateResult;
  /** A kind's own placement rule for a PLAYER placement (`requirePacked`):
   *  the refusal text, or null to allow. Today only the Territory Lock has one
   *  (`territoryLockRefusal`). Absent ⇒ no extra rule. */
  placementRefusal?(owner: string, kindId: StructureKindId): string | null;
  /** Room's sector key (for the packed gate). Null or absent = no sector:
   *  no holds there, so the Capital needs no crate. */
  sectorKey?(): string | null;
  /** Spawn the kind=2 swarm entity (returns false if the slot pool is full). */
  /** `blueprint`: an unbuilt structure, spawned non-colliding (hologram
   *  pass-through) until the grid finishes it with no ship inside. */
  spawnStructure(s: { id: string; x: number; y: number; radius: number; shipKind: string; angle?: number; blueprint?: boolean }): boolean;
  /** Seed the hull (and zero the shield) so the structure is damageable. */
  seedHealth(id: string, hp: number): void;
  /** Despawn a placed structure's swarm entity (broadcast the destroy). */
  despawn(id: string): void;
  /** Clamp a requested world position to playable sector bounds. */
  clamp(x: number, y: number): { x: number; y: number };
  /** Allocate a fresh, unique structure id. */
  nextId(): string;
  /** Living World P1a-2 — stable structure uid for (owner, kind, pose). Optional
   *  (test fixtures omit it ⇒ the record has no uid and no persisted hold). */
  structureUid?(owner: string, kind: string, x: number, y: number): string;
  /** Shared registry. */
  registry: StructureRegistry;
  /** Item D — live non-structure obstacles (asteroids) that block a connection's
   *  line of sight, so a structure never auto-wires straight through a rock.
   *  Optional: when omitted, auto-connection falls back to the structures-only
   *  LOS check (byte-identical to pre-Item-D). `near` (the footprint, or the
   *  box the new links may run in, `linkReachBox`): also the obstacles with
   *  no body that reach that box (cut-field rocks whose chunk is not loaded,
   *  macro terrain C5). `wrecks`: placement's own overlap check also wants
   *  wreck pieces, loaded and not (wreck fields 7); auto-connect's line of
   *  sight never passes it, so links are unchanged. */
  getObstacles?: (near?: ObstacleBox, wrecks?: boolean) => readonly GridObstacle[];
}

export class StructurePlacementSubsystem {
  /** Scratch for `linkReachBox` (auto-connect's `near` box). */
  private readonly linkBox: ObstacleBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  /** Why the last `place` was refused (an overlap, or a kind rule via
   *  `placementRefusal`), for the room's notice; null when it wasn't (or it
   *  succeeded). */
  lastRefusal: string | null = null;

  constructor(private readonly hooks: StructurePlacementHooks) {}

  /**
   * Place a structure for `owner`. Returns the new structure id, or `null` if
   * the request was rejected (unknown kind, overlap, or slot pool exhausted).
   *
   * `skipAutoConnect` — a generated base (or a scale lattice) supplies its own
   * intended connection graph via `connectExplicit`; greedy auto-connect would
   * link e.g. gate pylons and close a gate. Players never pass it.
   */
  place(
    owner: string,
    kindId: string,
    x: number,
    y: number,
    opts?: { skipAutoConnect?: boolean; rot?: number; requirePacked?: boolean },
  ): string | null {
    this.lastRefusal = null;
    if (!isStructureKindId(kindId)) return null;
    const kind = getStructureKind(kindId);
    const pos = this.hooks.clamp(x, y);
    const rot = normaliseStructureRotation(opts?.rot);
    const { hw, hh } = structureHalfExtents(kindId, rot);

    // No-overlap: reject if the new footprint would intersect an existing
    // structure's footprint OR an asteroid/obstacle (Phase-4 C2 — the obstacle
    // pass is the fix for "places on an asteroid"; the same `getObstacles` hook
    // the auto-connect LOS check already uses). Shared pure predicate so the
    // client ghost can validate identically.
    const near = { x0: pos.x - hw, y0: pos.y - hh, x1: pos.x + hw, y1: pos.y + hh };
    const rejection = placementRejection(kindId, pos.x, pos.y, this.hooks.registry.all(), this.hooks.getObstacles?.(near, true), rot);
    if (rejection !== null) {
      this.lastRefusal = placementRejectionNotice(rejection);
      return null;
    }

    // A kind's own rule (the Territory Lock: hold the sector, one per sector).
    if (opts?.requirePacked === true && this.hooks.placementRefusal) {
      this.lastRefusal = this.hooks.placementRefusal(owner, kindId);
      if (this.lastRefusal !== null) return null;
    }

    // A player's placement uses a held packed crate first (a free build).
    // Only the Capital NEEDS one; any other kind without a crate builds from
    // the bank (not prepaid). The crate rule applies only where holds exist:
    // a room with no sector (engineering / test sandbox: no roster, no hold)
    // places a Capital without one, as unpack_hull is galaxy-rooms-only.
    let packed: PackedGateResult | null = null;
    const sectorKey = this.hooks.sectorKey?.() ?? null;
    const crate = needsPackedCrate(kindId) && sectorKey !== null;
    if (opts?.requirePacked === true && this.hooks.packedGateForBuild && (crate || !STARTER_STRUCTURE_KINDS.includes(kindId))) {
      const gate = this.hooks.packedGateForBuild(owner, kindId, sectorKey);
      if (gate.ok) packed = gate;
      else if (crate) return null;
    }

    const preBuilt = kind.constructionCost <= 0;
    const hp = preBuilt
      ? kind.maxHealth
      : Math.max(1, Math.floor(kind.maxHealth * SCAFFOLDING_HP_FRACTION));

    const id = this.hooks.nextId();
    const ok = this.hooks.spawnStructure({
      id,
      x: pos.x,
      y: pos.y,
      radius: kind.radius,
      shipKind: kindId,
      // Game-space angle (Y-up, CCW) for a quarter-turn rotation.
      angle: (rot * Math.PI) / 180,
      ...(preBuilt ? {} : { blueprint: true }),
    });
    if (!ok) return null;

    this.hooks.seedHealth(id, hp);

    // The Capital is born with a starting mineral bank (capped by its storage)
    // so a base can bootstrap a few structures before mining (Phase 4) exists.
    const minerals =
      kindId === 'capital' ? Math.min(CAPITAL_STARTING_MINERALS, kind.storageCapacity) : 0;

    const rec: StructureRecord = {
      id,
      owner,
      kind: kindId as StructureKindId,
      subtypeIndex: structureKindToIndex(kindId),
      x: pos.x,
      y: pos.y,
      radius: kind.radius,
      rot,
      halfW: hw,
      halfH: hh,
      isConstructed: preBuilt,
      ...(preBuilt ? {} : { ghostBody: true }),
      constructionProgress: preBuilt ? kind.constructionCost : 0,
      constructionCost: kind.constructionCost,
      isDeconstructing: false,
      minerals,
      storedPower: 0,
      // Phase 4 (Leveling & XP, WS-B4) — every fresh structure starts at level 1.
      // A paid Upgrade build phase increments it (restore overrides on hydrate).
      level: 1,
      // Economy v2 W4b — placed from a packed item: the build costs only time.
      ...(packed !== null ? { prepaid: true } : {}),
      // Living World P1a-2 — stable identity for the holds table.
      ...(this.hooks.structureUid ? { uid: this.hooks.structureUid(owner, kindId, pos.x, pos.y) } : {}),
    };
    this.hooks.registry.add(rec);
    const crateItem = packed?.commit() ?? null;
    // Economy v2 — remember the crate's quality so taking it down REPACKS it.
    if (crateItem !== null) rec.packedQuality = crateItem.quality;
    // A Capital crate carries its bank: a repacked one starts the Capital with
    // what it held, never a fresh 5,000 (pack/unpack must not print minerals).
    if (kindId === 'capital' && crateItem?.minerals !== undefined) {
      rec.minerals = Math.min(crateItem.minerals, kind.storageCapacity);
    }
    // A pre-built kind (the Capital) placed from a crate is born at its FULL
    // quality hull, not the base one: else the repair pulse buys the crate's
    // bonus HP out of the new bank the moment it lands.
    if (crateItem !== null && preBuilt) {
      this.hooks.seedHealth(id, effectiveStructureMaxHealth(kind.maxHealth, rec.level, crateItem.quality));
    }
    // Auto-wire into the owner's grid: nearest in-range hub with a free slot
    // whose connecting segment isn't blocked by another structure OR an asteroid
    // (incl. one with no body, over the box the links may run in). Nothing in
    // range ⇒ nothing to link.
    if (opts?.skipAutoConnect !== true && linkReachBox(this.hooks.registry, id, this.linkBox)) {
      autoConnectStructure(this.hooks.registry, id, this.hooks.getObstacles?.(this.linkBox));
    }
    return id;
  }

  /**
   * Remove a structure the requester owns. Returns true if removed. Rejects
   * unknown ids and ids owned by another player (anti-grief).
   */
  remove(owner: string, id: string): boolean {
    const rec = this.hooks.registry.get(id);
    if (!rec || rec.owner !== owner) return false;
    this.hooks.despawn(id);
    this.hooks.registry.remove(id);
    return true;
  }
}

/** A Capital crate holding `minerals`: one of a kind (own uid), so crates
 *  with different banks never merge. The starter grant makes one at 5,000. */
export function capitalCrateItem(quality: number, minerals: number): PackedItem {
  return { product: 'structure:capital', quality, uid: `cap-${randomUUID()}`, minerals: Math.max(0, Math.floor(minerals)) };
}

/** The packed item a PREPAID structure repacks into (`onRepack`). A Capital's
 *  crate takes its mineral bank (the bank is zeroed, so the spill that follows
 *  holds only the goods in its hold: those drop as a pod where it stood). */
export function repackItem(rec: StructureRecord, defaultQuality: number): PackedItem {
  const quality = rec.packedQuality ?? defaultQuality;
  if (rec.kind !== 'capital') return { product: `structure:${rec.kind}`, quality };
  const item = capitalCrateItem(quality, rec.minerals);
  rec.minerals = 0;
  return item;
}

/** What `packedGateForBuild` reads from the room: the storage service (for
 *  committing a storage structure's hold), the hold store, the sector key
 *  (null = not roster-backed, so the hold change is not persisted) and the
 *  room's `findPacked` lookup (shared with the grid pulse's repack). */
export interface PackedGateHost {
  storage(): StorageService;
  holdStore(): HoldStore;
  sectorKey(): string | null;
  findPacked(owner: string, product: string): { rec: StructureRecord } | { shipId: string } | null;
}

/** The `packedGateForBuild` hook: ok when `owner` has a packed `kindId`
 *  here; `commit` takes one (best quality first) as ONE hold group. */
export function packedGateForBuild(h: PackedGateHost, owner: string, kindId: StructureKindId): PackedGateResult {
  const product = `structure:${kindId}`;
  const src = h.findPacked(owner, product);
  if (src === null) return { ok: false, commit: () => null };
  return {
    ok: true,
    commit: () => {
      if ('rec' in src) {
        const item = takePackedOfProduct(src.rec.hold!, product);
        h.storage().commitChanged([src.rec], []);
        return item;
      }
      const row = h.holdStore().get(src.shipId);
      if (row === undefined) return null;
      const hc = cloneHold(row.hold);
      const item = takePackedOfProduct(hc, product);
      const persist = h.sectorKey() !== null;
      if (isHoldEmpty(hc)) h.holdStore().commit([], [src.shipId], persist);
      else h.holdStore().commit([{ ...row, hold: hc }], [], persist);
      return item;
    },
  };
}
