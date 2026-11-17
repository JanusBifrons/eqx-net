/**
 * The hulls that collect loot this tick (`LootSubsystemDeps.forEachCollector`,
 * the auto-deposit pass) and the one hull a pod hit
 * (`LootSubsystemDeps.fillCollector`): a pilot's ACTIVE live hull with a hold,
 * or a `collectsLoot` AI ship (a live swarm entity, kind 1). Fill logic over
 * injected room accessors; one reused scratch (no per-tick alloc, #14).
 */
import { getShipKind } from '../../shared-types/shipKinds.js';
import { cargoCapacityForMaxHealth } from '../../shared-types/goods.js';
import { SLOT_ANGLE_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import type { LootCollector } from './LootSubsystem.js';

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
}
