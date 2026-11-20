/**
 * C3 — NPC loot holds and kill pods, moved verbatim out of `SectorRoom`
 * (god-file split slice 45). An NPC ship's loot IS its hold: rolled once per
 * spawn from a seed (`hold`), spilled as an ordinary pod where it died
 * (`dropKillLoot`), placed beside the wreck away from the killer (`podSpot`,
 * shared with a pilot's death spill). The rolled-spawn set is memory only;
 * the room calls `forget` when a drone leaves. One reused `_podSpot` scratch:
 * nothing is allocated per kill for the spot.
 */
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { LootSubsystem } from './LootSubsystem.js';
import type { Hold } from '../../shared-types/goods.js';
import { cloneHold, emptyHold, isHoldEmpty, mergeInto } from '../../core/cargo/hold.js';
import { hashString } from '../../core/bases/baseProfile.js';
import { podSizeClass } from '../../shared-types/shipKinds/cargoPod.js';
import { SLOT_VX_OFF, SLOT_VY_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { isHaulerId } from '../livingworld/directorBotIds.js';
import { getHoldStore } from '../db/PersistenceWorker.js';
import { DEATH_POD_PUSH, killPodSpot, rollHullLoot, vaporisedSalvageExtra } from './hullLoot.js';

/** The room state the NPC loot holds read (late-assigned fields read at call time). */
export interface NpcLootHoldsHost {
  sectorKey: () => string | null;
  sabF32: () => Float32Array;
  loot: () => LootSubsystem;
  swarmRegistry: SwarmEntityRegistry;
  shipPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  lingeringPoseCache: ReadonlyMap<string, ShipPhysicsState>;
}

export class NpcLootHolds {
  constructor(private readonly host: NpcLootHoldsHost) {}

  dropKillLoot(rec: SwarmEntityRecord, shooterId?: string, vaporised = false): void {
    const sabF32 = this.host.sabF32();
    const b = slotBase(rec.slot);
    // C3 — an NPC ship's loot IS its hold: rolled once from a seed (so a
    // break-in that already took some leaves less to drop), and a trade
    // hauler's hold is its cargo. Anything with a hold spills where it died.
    const hold = this.hold(rec);
    // An NPC drop is an ordinary pod (its contents' tier), never the bright
    // dead-player spill tier (owner 2026-11-13).
    if (!isHoldEmpty(hold)) {
      const key = `${rec.id}:${rec.entityId}`;
      // Vaporised (owner 2026-11-15): its hull salvage still aboard × 1.5.
      const extra = vaporised ? vaporisedSalvageExtra(key, rec.shipKind, rec.elite !== undefined, hold.goods.salvage ?? 0) : undefined;
      const spot = this.podSpot(hashString(key), sabF32[b + SLOT_X_OFF]!, sabF32[b + SLOT_Y_OFF]!, rec.radius, shooterId);
      // The pod keeps the ship's velocity plus a gentle push clear of the wreck.
      this.host.loot().spillShipHold(rec.id, spot.x, spot.y,
        sabF32[b + SLOT_VX_OFF]! + spot.ux * DEATH_POD_PUSH, sabF32[b + SLOT_VY_OFF]! + spot.uy * DEATH_POD_PUSH,
        isHaulerId(rec.id) ? 'hauler-raided' : 'kill', { player: false, deathLoss: key, size: podSizeClass(rec.radius), ...(extra !== undefined ? { extra } : {}) });
    }
    else getHoldStore().delete(rec.id, false);
  }

  /** `killPodSpot` for a dead ship at (cx, cy), the killer's live pose looked
   *  up by id (pilot, parked hull or swarm ship). Returns the reused `_podSpot`. */
  podSpot(seed: number, cx: number, cy: number, hullRadius: number, shooterId?: string): { x: number; y: number; ux: number; uy: number } {
    let sx = Number.NaN;
    let sy = Number.NaN;
    if (shooterId !== undefined && shooterId !== '') {
      const p = this.host.shipPoseCache.get(shooterId) ?? this.host.lingeringPoseCache.get(shooterId);
      const srec = p === undefined ? this.host.swarmRegistry.get(shooterId) : undefined;
      if (p !== undefined) { sx = p.x; sy = p.y; }
      else if (srec) { const sabF32 = this.host.sabF32(); sx = sabF32[slotBase(srec.slot) + SLOT_X_OFF]!; sy = sabF32[slotBase(srec.slot) + SLOT_Y_OFF]!; }
    }
    return killPodSpot(this._podSpot, seed, cx, cy, hullRadius, sx, sy);
  }
  private readonly _podSpot = { x: 0, y: 0, ux: 0, uy: 0 };

  /**
   * C3 — an NPC ship's hold: a trade hauler's real cargo, or (any other NPC)
   * its kind's loot — an elite's guaranteed rare haul — rolled ONCE from a
   * seed (its id + this spawn's entityId) the first time it's needed (opened,
   * broken into, or killed). NPC loot holds live in memory only.
   */
  hold(rec: SwarmEntityRecord): Hold {
    const store = getHoldStore();
    const key = `${rec.id}:${rec.entityId}`;
    const row = store.get(rec.id);
    if (this.npcLootRolled.has(key)) return row?.hold ?? emptyHold();
    // Roll this spawn's loot table ONCE, on top of anything it already
    // carries (a nexus hoard, a harvester's scoop, a hauler's cargo).
    this.npcLootRolled.add(key);
    const loot = rollHullLoot(key, rec.shipKind, rec.elite !== undefined);
    if (row !== undefined) {
      if (isHoldEmpty(loot)) return row.hold;
      const merged = cloneHold(row.hold);
      mergeInto(merged, loot);
      store.put({ ...row, hold: merged }, false);
      return merged;
    }
    store.put({ holderUid: rec.id, holderType: 'hauler', ownerId: null, sectorKey: this.host.sectorKey(), x: null, y: null, hold: loot, expiresAt: null }, false);
    return loot;
  }

  /** The spawn left the room: its loot roll goes with it. */
  forget(rec: SwarmEntityRecord): void {
    this.npcLootRolled.delete(`${rec.id}:${rec.entityId}`);
  }

  /** C3 — NPC spawns (`id:entityId`) whose loot table is already in their hold. */
  private readonly npcLootRolled = new Set<string>();
}
