/**
 * The hulls that collect loot this tick (`LootSubsystemDeps.forEachCollector`,
 * the auto-deposit pass) and the one hull a pod hit
 * (`LootSubsystemDeps.fillCollector`): a pilot's ACTIVE live hull with a hold,
 * or a `collectsLoot` AI ship (a live swarm entity, kind 1). Fill logic over
 * injected room accessors; one reused scratch (no per-tick alloc, #14).
 *
 * Also the room's collector hooks, moved verbatim out of `SectorRoom`: the
 * pickup notice (`onLootCollected`, `LootSubsystemDeps.onCollected`) and the
 * auto-deposit pass (`autoDepositTick`) with its dwell state and the
 * hand-moved-cargo set (`manualCargo`, filled by the cargo messages).
 */
import { getShipKind } from '../../shared-types/shipKinds.js';
import { cargoCapacityForMaxHealth } from '../../shared-types/goods.js';
import { SLOT_ANGLE_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import type { LootCollector } from './LootSubsystem.js';
import type { Client } from 'colyseus';
import type { Hold } from '../../shared-types/goods.js';
import { holdWeight, isHoldEmpty } from '../../core/cargo/hold.js';
import { DEPOSIT_DWELL_TICKS, type StorageService } from './StorageService.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';

/** The pilot hull fields a collector reads (`ShipState`). */
interface PilotHull { alive: boolean; isActive: boolean; shipInstanceId: string; shield: number; kind: string }

export interface LootCollectorsDeps {
  /** Persistent sector identity (null ⇒ engineering room: no roster ⇒ no holds). */
  sectorKey: () => string | null;
  /** Pilots in the room (keyed by playerId). */
  pilots: ReadonlyMap<string, unknown>;
  activeShip: (pid: string) => PilotHull | undefined;
  hasHold: (shipInstanceId: string) => boolean;
  pilotPose: (pid: string) => { x: number; y: number; angle: number } | undefined;
  /** A fitted Cargo Expander raises the capacity (shared helper, #15). */
  cargoCapacity: (kind: string, shipInstanceId: string) => number;
  swarm: { all: () => Iterable<SwarmEntityRecord>; get: (id: string) => SwarmEntityRecord | null };
  sab: () => Float32Array;
  /** Auto-deposit early-out: placed structures in the sector. */
  structureCount: () => number;
  storage: () => Pick<StorageService, 'nearestOwnStorage' | 'deposit'>;
  shipHold: (shipInstanceId: string) => Hold | undefined;
  serverTick: () => number;
  playerToSession: () => ReadonlyMap<string, string>;
  clients: () => ReadonlyArray<Client>;
}

/** Economy v2 W4a — the packed products a pickup/deposit moved, for the popup
 *  (spread into the message; absent when none). Discrete event, not per tick. */
function packedProducts(moved: Hold): { packed?: string[] } {
  if (moved.packed === undefined || moved.packed.length === 0) return {};
  return { packed: moved.packed.slice(0, 20).map((p) => p.product) };
}

export class LootCollectors {
  private readonly c: LootCollector = { playerId: '', shipInstanceId: '', x: 0, y: 0, angle: 0, shieldUp: false, capacity: 0, kind: getShipKind(null) };

  constructor(private readonly d: LootCollectorsDeps) {}

  /**
   * Visit every hull allowed to collect loot this tick (#17 liveness: ACTIVE +
   * alive hulls only — lingering and dead hulls never collect; and only hulls
   * WITH a roster row, since a ship with no roster row has nowhere to keep a
   * hold — hostile-review A2). Reuses one scratch object (no per-tick alloc).
   */
  forEach(visit: (c: LootCollector) => void): void {
    if (this.d.sectorKey() === null) return; // engineering rooms: no roster ⇒ no holds
    const c = this.c;
    for (const [pid] of this.d.pilots) if (this.pilot(pid, c)) visit(c);
    // NPC loot collectors (the `collectsLoot` kind trait, e.g. robot
    // harvesters) collect too (#17: a live swarm entity, kind 1; its hold is
    // keyed by its swarm id). Capacity is the kind's cargo capacity.
    for (const rec of this.d.swarm.all()) if (this.npc(rec, c)) visit(c);
  }

  /** Fill `c` with ship `shipId`'s collector (a pilot, or an AI ship, kind 1):
   *  true = filled; false = a ship but not collecting; null = not a ship. */
  fill(shipId: string, c: LootCollector): boolean | null {
    if (this.d.pilots.has(shipId)) return this.d.sectorKey() !== null && this.pilot(shipId, c);
    const rec = this.d.swarm.get(shipId);
    if (rec === null || rec.kind !== 1) return null;
    return this.d.sectorKey() !== null && this.npc(rec, c);
  }

  /** Fill `c` with pilot `pid`'s collector; false = none (#17: a live ACTIVE hull with a hold). */
  private pilot(pid: string, c: LootCollector): boolean {
    const ship = this.d.activeShip(pid);
    if (!ship?.alive || !ship.isActive || !this.d.hasHold(ship.shipInstanceId)) return false;
    const pose = this.d.pilotPose(pid);
    if (!pose) return false;
    c.playerId = pid;
    c.shipInstanceId = ship.shipInstanceId;
    c.x = pose.x;
    c.y = pose.y; c.angle = pose.angle; c.shieldUp = ship.shield > 0; // the hull-touch pickup's shape
    c.capacity = this.d.cargoCapacity(ship.kind, ship.shipInstanceId);
    c.kind = getShipKind(ship.kind); // its hull radius + mounts: the pieces it consumes
    c.npc = false;
    return true;
  }

  /** Fill `c` with swarm entity `rec`'s collector; false = not a `collectsLoot` AI ship (kind 1). */
  private npc(rec: SwarmEntityRecord, c: LootCollector): boolean {
    if (rec.kind !== 1) return false;
    const kindDef = getShipKind(rec.shipKind);
    if (kindDef.collectsLoot !== true) return false;
    const b = slotBase(rec.slot);
    const sab = this.d.sab();
    c.playerId = rec.id;
    c.shipInstanceId = rec.id;
    c.x = sab[b + SLOT_X_OFF]!;
    c.y = sab[b + SLOT_Y_OFF]!; c.angle = sab[b + SLOT_ANGLE_OFF]!; c.shieldUp = !rec.shieldDown;
    c.capacity = cargoCapacityForMaxHealth(kindDef);
    c.kind = kindDef;
    c.npc = true;
    return true;
  }

  /** Auto-deposit dwell: playerId → (target structure id, first in-range tick). */
  readonly depositDwell = new Map<string, { targetId: string; sinceTick: number }>();
  /** Auto-deposit progress 0..100 by shipInstanceId (own-ship snapshot ring). */
  readonly depositProgress = new Map<string, number>();
  /** C1 — pilots who moved cargo by hand. Auto-deposit stays off for them
   *  until they fly out of deposit range of their storage, so a withdrawal
   *  from your own storage isn't banked straight back 2 s later. */
  readonly manualCargo = new Set<string>();

  /** A pickup landed: tell the collector (UI accelerator — the authoritative
   *  cargo rides the own-ship snapshot slice) + audit. */
  onLootCollected(c: LootCollector, moved: Hold, podId: string): void {
    if (c.npc === true) {
      auditEvent({ event: 'loot_collected', sector: this.d.sectorKey() ?? undefined, podId, playerId: c.playerId, shipInstanceId: c.shipInstanceId, weight: holdWeight(moved) });
      return;
    }
    const sessionId = this.d.playerToSession().get(c.playerId);
    const client = sessionId !== undefined ? this.d.clients().find((cl) => cl.sessionId === sessionId) : undefined;
    if (client) {
      try {
        client.send('loot_collected', { type: 'loot_collected', goods: moved.goods, blueprints: moved.blueprints.length, ...packedProducts(moved) });
      } catch { /* socket closing */ }
    }
    auditEvent({
      event: 'loot_collected', sector: this.d.sectorKey() ?? undefined, podId,
      playerId: c.playerId, shipInstanceId: c.shipInstanceId, weight: holdWeight(moved),
    });
  }

  /**
   * Living World P1a-2 — AUTO-DEPOSIT. A collector (#17: active + alive + roster
   * row) carrying cargo that stays within `DEPOSIT_RANGE` of its OWN operational
   * storage for `DEPOSIT_DWELL_TICKS` (2 s) deposits its whole hold into that
   * storage network. Progress (0..100) rides the own-ship snapshot slice. Runs
   * every 6 ticks; early-outs when the sector has no structures.
   */
  autoDepositTick(): void {
    if (this.d.structureCount() === 0) {
      if (this.depositDwell.size > 0) { this.depositDwell.clear(); this.depositProgress.clear(); }
      this.manualCargo.clear();
      return;
    }
    this.forEach(this.visitDepositor);
  }

  /** Bound once (no per-tick closure allocation, #14). */
  private readonly visitDepositor = (c: LootCollector): void => {
    if (this.manualCargo.has(c.playerId)) {
      // Moved cargo by hand: no auto-deposit until they leave their storage.
      if (this.d.storage().nearestOwnStorage(c.playerId, c.x, c.y) === null) this.manualCargo.delete(c.playerId);
      if (this.depositDwell.delete(c.playerId)) this.depositProgress.delete(c.shipInstanceId);
      return;
    }
    const hold = this.d.shipHold(c.shipInstanceId);
    const target = hold !== undefined && !isHoldEmpty(hold)
      ? this.d.storage().nearestOwnStorage(c.playerId, c.x, c.y)
      : null;
    if (target === null) {
      if (this.depositDwell.delete(c.playerId)) this.depositProgress.delete(c.shipInstanceId);
      return;
    }
    const dwell = this.depositDwell.get(c.playerId);
    if (dwell === undefined || dwell.targetId !== target.id) {
      this.depositDwell.set(c.playerId, { targetId: target.id, sinceTick: this.d.serverTick() });
      this.depositProgress.set(c.shipInstanceId, 0);
      return;
    }
    const elapsed = this.d.serverTick() - dwell.sinceTick;
    if (elapsed < DEPOSIT_DWELL_TICKS) {
      this.depositProgress.set(c.shipInstanceId, Math.floor((elapsed / DEPOSIT_DWELL_TICKS) * 100));
      return;
    }
    const moved = this.d.storage().deposit(c.shipInstanceId, c.playerId, target);
    this.depositDwell.delete(c.playerId);
    this.depositProgress.delete(c.shipInstanceId);
    if (isHoldEmpty(moved)) return; // storage full — nothing moved
    const sessionId = this.d.playerToSession().get(c.playerId);
    const client = sessionId !== undefined ? this.d.clients().find((cl) => cl.sessionId === sessionId) : undefined;
    try {
      client?.send('cargo_deposited', { type: 'cargo_deposited', goods: moved.goods, blueprints: moved.blueprints.length, ...packedProducts(moved) });
    } catch { /* socket closing */ }
    auditEvent({
      event: 'cargo_deposited', sector: this.d.sectorKey() ?? undefined, playerId: c.playerId,
      shipInstanceId: c.shipInstanceId, structureKind: target.kind, weight: holdWeight(moved),
    });
  };
}
