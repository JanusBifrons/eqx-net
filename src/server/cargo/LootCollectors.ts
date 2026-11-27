/**
 * The hulls that collect loot this tick (`LootSubsystemDeps.forEachCollector`,
 * the auto-deposit pass) and the one hull a pod hit
 * (`LootSubsystemDeps.fillCollector`): a pilot's ACTIVE live hull with a hold,
 * or a `collectsLoot` AI ship (a live swarm entity, kind 1). Fill logic over
 * injected room accessors; one reused scratch (no per-tick alloc, #14).
 *
 * Also the room's collector hooks, moved verbatim out of `SectorRoom`: the
 * pickup notice (`onLootCollected`, `LootSubsystemDeps.onCollected`) and the
 * hand-moved-cargo set (`manualCargo`, filled by the cargo messages). The
 * auto-deposit pass itself is `rooms/features/craneBays.ts` (`CraneBays`).
 */
import { getShipKind } from '../../shared-types/shipKinds.js';
import { cargoCapacityForMaxHealth } from '../../shared-types/goods.js';
import { SLOT_ANGLE_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import type { LootCollector } from './LootSubsystem.js';
import type { Client } from 'colyseus';
import type { Hold } from '../../shared-types/goods.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';
import { holdWeight, isHoldEmpty } from '../../core/cargo/hold.js';
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
  pilotPose: (pid: string) => { x: number; y: number; angle: number; vx: number; vy: number } | undefined;
  /** A fitted Cargo Expander raises the capacity (shared helper, #15). */
  cargoCapacity: (kind: string, shipInstanceId: string) => number;
  swarm: { all: () => Iterable<SwarmEntityRecord>; get: (id: string) => SwarmEntityRecord | null };
  sab: () => Float32Array;
  playerToSession: () => ReadonlyMap<string, string>;
  clients: () => ReadonlyArray<Client>;
  /** The fleet's owned hulls and their orders (`forEachSalvager`). Absent:
   *  no AI-flown hull ever collects. */
  fleet?: { readonly size: number; idAt(i: number): string; ownerAt(i: number): string; ordersAt(i: number): { order: { kind: string } | null } };
  /** An AI-flown (lingering) hull's pose; absent when it is not one. */
  lingeringPose?: (shipInstanceId: string) => { x: number; y: number; angle: number; vx: number; vy: number } | undefined;
  /** The hull's ship row (any liveness class). */
  ship?: (shipInstanceId: string) => PilotHull | undefined;
}

/** Economy v2 W4a — the packed products a pickup/deposit moved, for the popup
 *  (spread into the message; absent when none). Discrete event, not per tick. */
function packedProducts(moved: Hold): { packed?: string[] } {
  if (moved.packed === undefined || moved.packed.length === 0) return {};
  return { packed: moved.packed.slice(0, 20).map((p) => p.product) };
}

export class LootCollectors {
  private readonly c: LootCollector = { playerId: '', shipInstanceId: '', x: 0, y: 0, angle: 0, vx: 0, vy: 0, shieldUp: false, capacity: 0, kind: getShipKind(null) };

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

  /**
   * Visit every AI-flown owned hull on a fleet SALVAGE order (#17: LINGERING
   * hulls flown by the AI pilot, alive, with a hold; ACTIVE and DEAD never):
   * the pieces it cuts or tractors go into its hold (`LootSubsystem`'s piece
   * store, never pods). Its owner is `playerId` (the pickup notice); its
   * beams are keyed by its shipInstanceId (`emitterId`). One scratch (#14).
   */
  forEachSalvager(visit: (c: LootCollector) => void): void {
    const fl = this.d.fleet;
    if (fl === undefined || this.d.sectorKey() === null) return;
    const c = this.c;
    for (let i = 0; i < fl.size; i++) {
      if (fl.ordersAt(i).order?.kind !== 'salvage') continue;
      const sid = fl.idAt(i);
      const ship = this.d.ship?.(sid);
      const pose = this.d.lingeringPose?.(sid);
      if (!ship?.alive || pose === undefined || !this.d.hasHold(sid)) continue;
      c.playerId = fl.ownerAt(i);
      c.shipInstanceId = sid;
      c.emitterId = sid;
      c.x = pose.x; c.y = pose.y; c.angle = pose.angle; c.vx = pose.vx; c.vy = pose.vy; c.shieldUp = ship.shield > 0;
      c.capacity = this.d.cargoCapacity(ship.kind, sid);
      c.kind = getShipKind(ship.kind);
      c.npc = false;
      visit(c);
    }
    c.emitterId = undefined;
  }

  /** Fill `c` with ship `shipId`'s collector (a pilot, or an AI ship, kind 1):
   *  true = filled; false = a ship but not collecting; null = not a ship. */
  fill(shipId: string, c: LootCollector): boolean | null {
    if (this.d.pilots.has(shipId)) return this.d.sectorKey() !== null && this.pilot(shipId, c);
    const rec = this.d.swarm.get(shipId);
    if (rec === null || rec.kind !== 1) return null;
    return this.d.sectorKey() !== null && this.npc(rec, c);
  }

  /** Pilot `pid`'s collector (the reused scratch: read it before the next
   *  call), or null with no live hold-carrying hull (the loot window's reach). */
  pilotCollector(pid: string): LootCollector | null {
    return this.d.sectorKey() !== null && this.pilot(pid, this.c) ? this.c : null;
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
    c.y = pose.y; c.angle = pose.angle; c.vx = pose.vx; c.vy = pose.vy; c.shieldUp = ship.shield > 0; // the hull-touch pickup's shape
    c.capacity = this.d.cargoCapacity(ship.kind, ship.shipInstanceId);
    c.kind = getShipKind(ship.kind); // its hull radius + mounts: the pieces it consumes
    c.npc = false;
    return true;
  }

  /** structure-restyle 3h — fill `c` with any live AI ship's pose and
   *  capacity (kind 1), collecting or not: a convoy hauler a crane serves
   *  (`SectorRoom.craneServe`). False = not a live AI ship here. */
  fillShip(shipId: string, c: LootCollector): boolean {
    const rec = this.d.swarm.get(shipId);
    return rec !== null && this.npc(rec, c, false);
  }

  /** Fill `c` with swarm entity `rec`'s collector; false = not a `collectsLoot` AI ship (kind 1). */
  private npc(rec: SwarmEntityRecord, c: LootCollector, collectingOnly = true): boolean {
    if (rec.kind !== 1) return false;
    const kindDef = getShipKind(rec.shipKind);
    if (collectingOnly && kindDef.collectsLoot !== true) return false;
    const b = slotBase(rec.slot);
    const sab = this.d.sab();
    c.playerId = rec.id;
    c.shipInstanceId = rec.id;
    c.x = sab[b + SLOT_X_OFF]!;
    c.y = sab[b + SLOT_Y_OFF]!; c.angle = sab[b + SLOT_ANGLE_OFF]!; c.vx = sab[b + SLOT_VX_OFF]!; c.vy = sab[b + SLOT_VY_OFF]!; c.shieldUp = !rec.shieldDown;
    c.capacity = cargoCapacityForMaxHealth(kindDef);
    c.kind = kindDef;
    c.npc = true;
    return true;
  }

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

  /** An auto-deposit / crane trade moved goods (`CraneBays`): tell the pilot
   *  and audit it (nothing moved ⇒ silent). `loaded` (3d outlet): goods came
   *  ABOARD, so the pickup popup. */
  onDeposited(c: LootCollector, target: StructureRecord, moved: Hold, loaded = false): void {
    if (isHoldEmpty(moved)) return; // storage full — nothing moved
    const sessionId = this.d.playerToSession().get(c.playerId);
    const client = sessionId !== undefined ? this.d.clients().find((cl) => cl.sessionId === sessionId) : undefined;
    const type = loaded ? 'loot_collected' : 'cargo_deposited';
    try {
      client?.send(type, { type, goods: moved.goods, blueprints: moved.blueprints.length, ...packedProducts(moved) });
    } catch { /* socket closing */ }
    auditEvent({
      event: loaded ? 'cargo_loaded' : 'cargo_deposited', sector: this.d.sectorKey() ?? undefined, playerId: c.playerId,
      shipInstanceId: c.shipInstanceId, structureKind: target.kind, weight: holdWeight(moved),
    });
  }
}
