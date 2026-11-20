/**
 * The room side of the sector snapshot (`SectorPersistence`): the scrap and
 * lingering-hull rows it saves, and the restore of structures, scrap and
 * lingering hulls on hydrate. Moved verbatim out of `SectorRoom` (god-file
 * split); `SectorPersistence` still owns the payload, the DB rows and the
 * hydrate order, and calls these through its deps. The room hands in live
 * accessors (`() => value` for fields it reassigns). Not on the tick: persist
 * runs on the save timer, restore once at hydrate (and the test / hand-off
 * seams that reuse it).
 */
import type { MapSchema } from '@colyseus/schema';
import type { Logger } from 'pino';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import { scrapColliderFor } from '../../core/geometry/scrapCollider.js';
import { effectiveShipShieldMax, type StatAlloc as CoreStatAlloc } from '../../core/leveling/shipStats.js';
import { GOOD_IDS, type GoodId } from '../../shared-types/goods.js';
import { MAX_FREIGHT_ORDERS } from '../../shared-types/messages/cargoMessages.js';
import { PackedItemSchema } from '../../shared-types/items.js';
import { isRecipeId } from '../../shared-types/recipes.js';
import { MAX_BUILD_COUNT } from '../../shared-types/production.js';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { SWARM_KIND_SCRAP } from '../../shared-types/swarmWireFormat.js';
import { TeleportRulesSchema, TeleportTollSchema, isTeleporterKind } from '../../shared-types/teleport.js';
import type { LootSubsystem } from '../cargo/LootSubsystem.js';
import type { StorageService } from '../cargo/StorageService.js';
import { getPlayerShipStore } from '../db/PersistenceWorker.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import type { FleetCommandSubsystem } from '../fleet/FleetCommandSubsystem.js';
import { canonicalPlayerId } from '../identity/AccountPlayerRegistry.js';
import type { SnapshotRing } from '../lagcomp/SnapshotRing.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import type { StructurePlacementSubsystem } from '../structures/StructurePlacementSubsystem.js';
import type { StructureRegistry } from '../structures/StructureRegistry.js';
import type { WingmanPilots } from './features/wingmanPilots.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import { ShipState } from './schema/SectorState.js';
import type { SectorSnapshotLingeringHull, SectorSnapshotScrap, SectorSnapshotStructure } from './SectorSnapshot.js';
import { normalizeStructureThrottle } from '../../shared-types/structurePower.js';

/** What the snapshot rows and restores need from the room; getters read the live field. */
export interface SectorSnapshotRestoreHost {
  state(): { ships: MapSchema<ShipState> };
  structurePlacement(): Pick<StructurePlacementSubsystem, 'place'>;
  storage(): Pick<StorageService, 'restore' | 'restorePad' | 'restoreSlot'>;
  swarmHealth(): Map<string, number>;
  loot(): Pick<LootSubsystem, 'isPod'>;
  sabF32(): Float32Array;
  swarmSpawner(): Pick<SwarmSpawner, 'spawnScrap'>;
  freeSlots(): number[];
  sectorKey(): string | null;
  serverTick(): number;
  wingmen(): Pick<WingmanPilots, 'attachWingman'>;
  structureRegistry: StructureRegistry;
  swarmRegistry: Pick<SwarmEntityRegistry, 'all'>;
  lingeringSlots: Map<string, number>;
  lingeringPoseCache: Map<string, ShipPhysicsState>;
  ownerlessShips: Map<string, ReturnType<typeof setTimeout> | null>;
  snapshotRing: Pick<SnapshotRing, 'registerEntity'>;
  fleet: Pick<FleetCommandSubsystem, 'exportShip' | 'isAttached' | 'restoreShip'>;
  logger: Pick<Logger, 'warn' | 'error'>;
  structureGridTick(): void;
  shipHullMax(kindMax: number, alloc: CoreStatAlloc | undefined, shipInstanceId: string): number;
  postToWorker(cmd: WorkerCmd): void;
  applyStatMulToWorker(bodyKey: string, alloc: CoreStatAlloc | undefined): void;
}

export class SectorSnapshotRestore {
  constructor(private readonly h: SectorSnapshotRestoreHost) {}

  /**
   * Phase 5 (persistence) — reconstruct placed structures from a hydrated
   * snapshot. Reuses the SAME placement seam `seedStructureScenario` uses
   * (`structurePlacement.place` → spawn body + fresh registry record), then
   * restores the persisted construction / minerals / power / health and rebuilds
   * the grid so connections re-derive via the auto-connect sweep. A fresh server
   * mints new entity ids — nothing references the saved ids across a restart.
   */
  restoreStructures(rows: readonly SectorSnapshotStructure[]): void {
    let restored = 0;
    for (const r of rows) {
      // PR 3a — a structure saved under one of the account's historical
      // per-browser ids belongs to the account's canonical playerId now.
      const id = this.h.structurePlacement().place(canonicalPlayerId(r.owner), r.kind, r.x, r.y, { rot: r.rot });
      if (id === null) {
        this.h.logger.warn({ kind: r.kind, x: r.x, y: r.y }, 'persisted structure rejected on hydrate');
        continue;
      }
      const rec = this.h.structureRegistry.get(id);
      if (rec) {
        rec.isConstructed = r.isConstructed;
        rec.constructionProgress = r.constructionProgress;
        rec.minerals = r.minerals;
        rec.storedPower = r.storedPower;
        // Phase 4 (Leveling & XP, WS-B4) — restore the persisted level (default
        // 1 for a pre-v6 / un-levelled row). The hydrated HP below is the
        // persisted (already-leveled) value, so no re-seed is needed.
        rec.level = r.level ?? 1;
        if (r.gateAccess !== undefined) rec.gateAccess = r.gateAccess;
        if (r.switchedOff === true) rec.switchedOff = true;
        const throttle = normalizeStructureThrottle(r.throttle);
        if (throttle !== undefined) rec.throttle = throttle;
        // v4 T1 — a teleporter's partner, rules, charge and pad hold survive a restart.
        if (isTeleporterKind(rec.kind)) {
          const t = r.teleport;
          if (t?.partner && typeof t.partner.uid === 'string' && typeof t.partner.sectorKey === 'string') rec.tpPartner = { ...t.partner };
          const rules = TeleportRulesSchema.safeParse(t?.rules);
          if (rules.success) rec.tpRules = rules.data;
          if (typeof t?.charge === 'number' && Number.isFinite(t.charge) && t.charge > 0) rec.tpCharge = t.charge;
          const toll = TeleportTollSchema.safeParse(t?.toll);
          if (toll.success && toll.data.per1000 > 0) rec.tpToll = toll.data;
          this.h.storage().restorePad(rec);
        }
        // P2b — the owner's recipe choice and a cycle in progress survive a restart.
        if (r.recipe !== undefined && isRecipeId(r.recipe)) rec.recipe = r.recipe;
        if (Number.isInteger(r.prodCount) && r.prodCount! >= 0) rec.prodCount = Math.min(r.prodCount!, MAX_BUILD_COUNT); // job 2E
        if (r.prepaid === true) rec.prepaid = true;
        // T4b — a Freight Dock's standing orders survive a restart.
        if (r.freightOrders) {
          const ok = r.freightOrders.filter((o) => (GOOD_IDS as readonly string[]).includes(o.good) && (o.mode === 'import' || o.mode === 'export') && o.level > 0);
          if (ok.length > 0) rec.freightOrders = ok.map((o) => ({ good: o.good as GoodId, mode: o.mode, level: Math.floor(o.level) })).slice(0, MAX_FREIGHT_ORDERS);
        }
        if (r.acceptAutoUnload === false) rec.acceptAutoUnload = false; // cargo pods 14c
        if (typeof r.packedQuality === 'number') rec.packedQuality = r.packedQuality;
        if (r.prodLoaded === true) {
          rec.prodLoaded = true;
          rec.prodProgress = r.prodProgress ?? 0;
          if (r.prodChunk) { const c = PackedItemSchema.safeParse(r.prodChunk); if (c.success) rec.prodChunk = c.data; }
        }
        // Living World P1a-2 — overlay the fresher holds-table payload (bank +
        // deposited goods) keyed by the structure's stable uid.
        this.h.storage().restore(rec);
        // P2b — a processor's loaded blueprint comes back into its slot.
        this.h.storage().restoreSlot(rec);
      }
      this.h.swarmHealth().set(id, r.health);
      restored += 1;
    }
    if (restored > 0) {
      this.h.structureRegistry.topologyDirty = true;
      // One pulse re-forms the connection web (auto-connect sweep) + powers the
      // grid + refreshes the structures[] slice.
      this.h.structureGridTick();
    }
  }

  /** Phase 5 (persistence v4) — the free-floating scrap pieces to persist: their
   *  drifted SAB pose + parent ship-kind + scrap-group component index + health.
   *  The collider is re-derived on hydrate, so it's NOT persisted. */
  *scrapEntities(): Iterable<SectorSnapshotScrap> {
    for (const rec of this.h.swarmRegistry.all()) {
      if (rec.kind !== SWARM_KIND_SCRAP) continue;
      // A3 — loot pods persist ONLY via the holds table; including them here
      // would restore every pod twice (once as value-less scrap).
      if (this.h.loot().isPod(rec.id) || rec.shipKind === 'cargo-pod') continue;
      if (rec.shipKind === undefined || rec.componentIndex === undefined) continue;
      const b = slotBase(rec.slot);
      yield {
        entityId: rec.id,
        parentShipKind: rec.shipKind,
        componentIndex: rec.componentIndex,
        x: this.h.sabF32()[b + SLOT_X_OFF]!,
        y: this.h.sabF32()[b + SLOT_Y_OFF]!,
        vx: this.h.sabF32()[b + SLOT_VX_OFF]!,
        vy: this.h.sabF32()[b + SLOT_VY_OFF]!,
        angle: this.h.sabF32()[b + SLOT_ANGLE_OFF]!,
        health: this.h.swarmHealth().get(rec.id) ?? 0,
      };
    }
  }

  /** Phase 5 (persistence v4) — reconstruct persisted scrap on hydrate. The
   *  convex-hull collider is RE-DERIVED from (parentShipKind, componentIndex) via
   *  the SAME `scrapColliderFor` the death path uses, so the restored body is
   *  byte-identical. Restored scrap is NOT re-registered in the ScrapSpawner FIFO
   *  (it's a bounded set from the snapshot; the slot pool still hard-caps it). */
  restoreScrap(rows: readonly SectorSnapshotScrap[]): void {
    for (const r of rows) {
      const geom = scrapColliderFor(r.parentShipKind as ShipKindId, r.componentIndex);
      if (geom === null) continue; // parent kind no longer scraps / index gone
      const ok = this.h.swarmSpawner().spawnScrap({
        id: r.entityId,
        x: r.x,
        y: r.y,
        vx: r.vx,
        vy: r.vy,
        angle: r.angle,
        radius: geom.radius,
        parentShipKind: r.parentShipKind as ShipKindId,
        componentIndex: r.componentIndex,
        vertices: geom.vertices,
      });
      if (ok) this.h.swarmHealth().set(r.entityId, r.health);
    }
  }

  /** Phase 5 (persistence v5) — the lingering hulls to persist: the in-world
   *  disconnected / fresh-spawn-displaced ships. Identity is the shipInstanceId
   *  (= roster shipId); pose is the per-tick lingering cache; identity + health +
   *  shield come from the schema entry. */
  *lingeringHulls(): Iterable<SectorSnapshotLingeringHull> {
    for (const [shipInstanceId] of this.h.lingeringSlots) {
      const ship = this.h.state().ships.get(shipInstanceId);
      if (ship === undefined || !ship.alive) continue;
      const pose = this.h.lingeringPoseCache.get(shipInstanceId);
      if (pose === undefined) continue;
      // RTS slice 9 — the wingman's standing job rides with the hull.
      const job = this.h.fleet.exportShip(shipInstanceId);
      yield {
        ...(job ?? {}),
        shipInstanceId,
        playerId: ship.playerId,
        kind: ship.kind,
        x: pose.x,
        y: pose.y,
        vx: pose.vx,
        vy: pose.vy,
        angle: pose.angle,
        angvel: pose.angvel ?? 0,
        health: ship.health,
        shieldDown: ship.shield <= 0,
      };
    }
  }

  /**
   * Phase 5 (persistence v5) — reconstruct lingering hulls in-world on hydrate,
   * so a disconnected/displaced ship reappears "where you left it" after a
   * restart (visible to others, reclaimable by the owner). Runs during hydrate
   * (before any onJoin), so a reconnecting owner rebinds to the reconstructed
   * hull rather than spawning a duplicate. Mirrors the disconnect-linger machine:
   * a schema `isActive=false` entry + SAB pose + `linger-<id>` worker body +
   * lingering bookkeeping. Skips a hull whose roster row is gone (abandoned → the
   * abandon→scrap flow already removed it) or whose identity is already live.
   */
  restoreLingeringHulls(rows: readonly SectorSnapshotLingeringHull[]): void {
    for (const r of rows) {
      if (r.shipInstanceId === '' || r.health <= 0) continue;
      if (this.h.state().ships.has(r.shipInstanceId)) continue;
      // Roster row gone ⇒ abandoned before shutdown ⇒ do NOT resurrect it as a
      // lingering hull (the abandon→scrap flow already removed it).
      const rosterRow = getPlayerShipStore().get(r.shipInstanceId);
      if (rosterRow === null) continue;
      // The roster says the ship is in ANOTHER sector (a hand-off re-homed it
      // with `markStored` and this sector's snapshot still lists it, e.g. a
      // crash before the next save) ⇒ that sector owns it; never a duplicate.
      if (this.h.sectorKey() !== null && rosterRow.lastSectorKey !== this.h.sectorKey()) continue;
      const kind = getShipKind(r.kind);
      const slot = this.h.freeSlots().pop();
      if (slot === undefined) {
        this.h.logger.error({ shipInstanceId: r.shipInstanceId }, 'no free slot for lingering-hull reconstruction');
        continue;
      }
      // Schema entry — a lingering (isActive=false) hull.
      const ship = new ShipState();
      // PR 3a — owner mapped to the account's canonical playerId (the roster
      // row was re-keyed by the boot merge; the snapshot blob was not).
      ship.playerId = canonicalPlayerId(r.playerId);
      ship.shipInstanceId = r.shipInstanceId;
      ship.kind = r.kind;
      // WS-B1/B2/B3 — seed the per-instance progression from the roster so a
      // restored lingering hull renders its public level badge + activated
      // turrets to observers (the gap is keyed by the stable shipInstanceId).
      // statAlloc is read BEFORE the hull/shield seed so the maxHull/shield
      // upgrade multipliers apply to a restored lingering hull too (review
      // must-fix #1 — the `effectiveShip*` helpers are the one source).
      const lingerRow = rosterRow;
      ship.level = lingerRow?.level ?? 1;
      ship.statAlloc = lingerRow?.statAlloc ?? {};
      ship.mounts = lingerRow?.mounts ?? [];
      ship.maxHealth = this.h.shipHullMax(kind.maxHealth, ship.statAlloc, ship.shipInstanceId);
      ship.health = r.health;
      ship.shield = r.shieldDown ? 0 : effectiveShipShieldMax(kind.shieldMax, ship.statAlloc);
      ship.shieldLastDamageTick = this.h.serverTick();
      ship.alive = true;
      ship.isActive = false;
      this.h.state().ships.set(r.shipInstanceId, ship);
      // SAB pose seed.
      const b = slotBase(slot);
      this.h.sabF32()[b + SLOT_X_OFF] = r.x;
      this.h.sabF32()[b + SLOT_Y_OFF] = r.y;
      this.h.sabF32()[b + SLOT_VX_OFF] = r.vx;
      this.h.sabF32()[b + SLOT_VY_OFF] = r.vy;
      this.h.sabF32()[b + SLOT_ANGLE_OFF] = r.angle;
      this.h.sabF32()[b + SLOT_ANGVEL_OFF] = r.angvel;
      // Lingering bookkeeping (shipInstanceId-keyed). `null` = persist-forever
      // marker (R2.26; no evict timer).
      this.h.lingeringSlots.set(r.shipInstanceId, slot);
      this.h.lingeringPoseCache.set(r.shipInstanceId, {
        x: r.x, y: r.y, vx: r.vx, vy: r.vy, angle: r.angle, angvel: r.angvel,
      });
      this.h.ownerlessShips.set(r.shipInstanceId, null);
      this.h.snapshotRing.registerEntity(r.shipInstanceId);
      // Worker body keyed `linger-<id>` (the REKEY invariant the fresh-spawn-
      // displace + abandon→scrap paths rely on). SPAWN creates at angle 0; a
      // SET_POSITION applies the full persisted pose.
      const bodyKey = `linger-${r.shipInstanceId}`;
      this.h.postToWorker({ type: 'SPAWN', slot, playerId: bodyKey, x: r.x, y: r.y, kindId: r.kind });
      this.h.postToWorker({
        type: 'SET_POSITION',
        entityId: bodyKey,
        x: r.x, y: r.y, angle: r.angle, vx: r.vx, vy: r.vy, angvel: r.angvel,
      });
      // RTS slice 4: the rebuilt body moves under a wingman, so it takes its
      // upgrade multipliers like the original body had (the brain's stats
      // assume them).
      this.h.applyStatMulToWorker(bodyKey, ship.statAlloc);
      this.h.wingmen().attachWingman(r.shipInstanceId);
      serverLogEvent('lingering_hull_reconstructed', {
        shipInstanceId: r.shipInstanceId,
        playerId: r.playerId,
        sectorKey: this.h.sectorKey(),
      });
    }
    // RTS slice 9 — re-apply each brain's saved standing job once EVERY hull
    // of the batch is attached (an escort target may be a later row). The
    // subsystem re-validates ownership + escort targets; squads follow in
    // `restoreFleetSquads`. Rows without the fields (older snapshots) keep the
    // default brain; a cross-sector hand-off row arrives as "defend here"
    // (`HullHandOff.receiveHandedOffHull`).
    for (const r of rows) {
      if (r.mode === undefined && r.stance === undefined) continue;
      if (!this.h.fleet.isAttached(r.shipInstanceId)) continue;
      this.h.fleet.restoreShip(r.shipInstanceId, r);
    }
  }
}
