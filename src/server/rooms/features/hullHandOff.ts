/**
 * v4 T3 / RTS fleet warp — THE cross-sector hand-off of parked (LINGERING,
 * #17) hulls, shared by the teleporter (`TeleportPadRiders`) and the fleet
 * warp (`transitHostRoom`), plus its far side (`receiveHandedOffHull`, wired
 * as the room's `TeleportRoom.receiveLingeringHull`). Moved verbatim out of
 * `SectorRoom`. The room hands in live accessors (`() => value` for fields it
 * reassigns); built once (#14). Discrete events only (a jump, a warp), never
 * per tick.
 */
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import type { HandedOffHull, TeleportRoom } from '../../teleport/TeleportBroker.js';
import type { FleetSavedSquad } from '../../fleet/fleetPersistence.js';
import type { FleetCommandSubsystem } from '../../fleet/FleetCommandSubsystem.js';
import { isNeighbour } from '../../../core/galaxy/galaxy.js';
import { clampToSectorBounds } from '../../../shared-types/sectorBounds.js';
import { isLingeringHull } from '../../../core/entity/shipLiveness.js';
import { getPlayerShipStore } from '../../db/PersistenceWorker.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { WorkerCmd } from '../PhysicsWorkerProxy.js';
import type { ShipState } from '../schema/SectorState.js';
import type { SectorSnapshotRestore } from '../SectorSnapshotRestore.js';
import type { WarpTravelTracker } from '../warpTravel.js';
import type { WingmanPilots } from './wingmanPilots.js';
import type { HullMove } from './transitMessages.js';

/** What the hull hand-off needs from the room; getters read the live field. */
export interface HullHandOffHost {
  sectorKey(): string | null;
  serverTick(): number;
  ships(): Pick<MapSchema<ShipState>, 'get' | 'delete'>;
  lingeringSlots: Pick<Map<string, number>, 'get' | 'has' | 'delete'>;
  lingeringPoseCache: Pick<Map<string, ShipPhysicsState>, 'delete'>;
  freeSlots(): Pick<number[], 'push'>;
  ownerlessShips: Pick<Map<string, ReturnType<typeof setTimeout> | null>, 'get' | 'delete'>;
  fleet: Pick<FleetCommandSubsystem, 'exportSquads' | 'exportShip'>;
  wingmen(): Pick<WingmanPilots, 'detachWingman'>;
  snapshotRestore(): Pick<SectorSnapshotRestore, 'restoreLingeringHulls'>;
  warpTravel(): Pick<WarpTravelTracker, 'markArrived'>;
  logger: Pick<Logger, 'warn' | 'error'>;
  landingPoint(playerId: string, x: number, y: number, kind: string | undefined, onlySkipShipId?: string): { x: number; y: number };
  postToWorker(cmd: WorkerCmd): void;
}

export class HullHandOff {
  constructor(private readonly h: HullHandOffHost) {}

  /**
   * THE cross-sector hand-off of parked (LINGERING, #17) hulls, shared by the
   * teleporter and the fleet warp. Per hull, in order: (1) ask the far room
   * whether it can take it (a free physics slot) BEFORE touching it here, so
   * a hull that can't fit stays put and is never lost; (2) take its AI pilot's
   * standing job (`exportShip`); (3) remove it here quietly; (4) re-home its
   * roster row to the far sector (`markStored`); (5) rebuild it there
   * (`receiveLingeringHull`, which applies the arrival rule: guard where it
   * lands, stance carries); (6) a `sector_change` audit. Then the squads any
   * moved hull belonged to are re-formed there from the members that moved
   * (squad mode dropped: the old sector's routes and posts stay behind).
   * Returns the ids that moved; the rest are still here.
   */
  handOffHullsTo(toRoom: TeleportRoom, moves: readonly HullMove[], arrival: 'warp' | 'teleport'): string[] {
    const h = this.h;
    const dest = toRoom.sectorKey;
    const moved: string[] = [];
    if (dest === null) return moved;
    // Squads are read BEFORE any removal: a detach shrinks / dissolves them.
    const squads = h.fleet.exportSquads();
    const from = h.sectorKey() ?? undefined;
    const adjacent = from !== undefined ? isNeighbour(from, dest) : undefined;
    for (const m of moves) {
      const id = m.shipInstanceId;
      const ship = h.ships().get(id);
      if (ship === undefined || !h.lingeringSlots.has(id) || !isLingeringHull(ship)) continue;
      if (!toRoom.canReceiveHull(id)) {
        h.logger.warn({ shipInstanceId: id, from, to: dest }, 'hull hand-off: destination has no free slot; the hull stays');
        continue;
      }
      const job = h.fleet.exportShip(id);
      const playerId = ship.playerId, kind = ship.kind, health = ship.health, shieldDown = ship.shield <= 0;
      if (!this.removeLingeringHullQuietly(id)) continue;
      getPlayerShipStore().markStored(id, {
        x: m.x, y: m.y, vx: m.vx, vy: m.vy, angle: m.angle, angvel: m.angvel, health, sectorKey: dest,
      });
      const ok = toRoom.receiveLingeringHull({
        ...(job ?? {}),
        shipInstanceId: id, playerId, kind,
        x: m.x, y: m.y, vx: m.vx, vy: m.vy, angle: m.angle, angvel: m.angvel,
        health, shieldDown, arrival,
      });
      if (!ok) {
        // Checked above, so this is a bug; the roster row (now in `dest`)
        // survives, so the ship is not deleted.
        h.logger.error({ shipInstanceId: id, from, to: dest }, 'hull hand-off: destination refused the hull after the check');
        continue;
      }
      moved.push(id);
      auditEvent({ event: 'sector_change', entityKind: 'hull', id, sector: from, from, to: dest, adjacent });
    }
    if (moved.length > 0 && squads.length > 0) {
      const carried: FleetSavedSquad[] = [];
      for (const sq of squads) {
        const members = sq.memberIds.filter((mid) => moved.includes(mid));
        if (members.length === 0) continue;
        carried.push({ id: sq.id, ownerId: sq.ownerId, leaderId: sq.leaderId, memberIds: members });
      }
      if (carried.length > 0) toRoom.receiveFleetSquads(carried);
    }
    return moved;
  }

  /**
   * The far side of {@link handOffHullsTo}: rebuild a handed-off hull here.
   * A fleet `warp` arrival is nudged clear of what is already here, the
   * owner's own ships included (only this ship is skipped), clamped to the
   * bounds, with its roster pose updated to match. Then the arrival rule
   * (owner): the AI pilot GUARDS WHERE IT LANDS; its stance carries (and its
   * squad, re-formed by `receiveFleetSquads`); its old route / post / escort
   * belonged to the old sector and is dropped.
   */
  receiveHandedOffHull(row: HandedOffHull): boolean {
    const h = this.h;
    let x = row.x, y = row.y;
    if (row.arrival === 'warp') {
      const p = h.landingPoint(row.playerId, x, y, row.kind, row.shipInstanceId);
      const c = clampToSectorBounds(p.x, p.y);
      if (c.x !== x || c.y !== y) {
        x = c.x; y = c.y;
        const sectorKey = h.sectorKey();
        getPlayerShipStore().markStored(row.shipInstanceId, {
          x, y, vx: row.vx, vy: row.vy, angle: row.angle, angvel: row.angvel, health: row.health,
          ...(sectorKey !== null ? { sectorKey } : {}),
        });
      }
    }
    h.snapshotRestore().restoreLingeringHulls([{
      shipInstanceId: row.shipInstanceId, playerId: row.playerId, kind: row.kind,
      x, y, vx: row.vx, vy: row.vy, angle: row.angle, angvel: row.angvel,
      health: row.health, shieldDown: row.shieldDown,
      mode: 'defend', modeData: { x, y },
      ...(row.stance !== undefined ? { stance: row.stance } : {}),
    }]);
    const placed = h.lingeringSlots.has(row.shipInstanceId);
    // RTS fleet warp (S4): every client here draws the drop for a hull that
    // just warped in. The "just arrived" window is the WarpTravelTracker's
    // (keyed by the shipInstanceId, which never collides with a playerId);
    // the snapshot reads it through `warpArrived`.
    if (placed && row.arrival === 'warp') h.warpTravel().markArrived(row.shipInstanceId, h.serverTick());
    return placed;
  }

  /** A parked hull left this sector by teleporter: drop it here without scrap,
   *  spill or audit (its hold is keyed by its id and travels with it). */
  private removeLingeringHullQuietly(shipInstanceId: string): boolean {
    const h = this.h;
    const ships = h.ships();
    const ship = ships.get(shipInstanceId);
    const slot = h.lingeringSlots.get(shipInstanceId);
    if (ship === undefined || slot === undefined) return false;
    h.wingmen().detachWingman(shipInstanceId);
    h.lingeringSlots.delete(shipInstanceId);
    h.lingeringPoseCache.delete(shipInstanceId);
    h.freeSlots().push(slot);
    h.postToWorker({ type: 'DESPAWN', slot, playerId: `linger-${shipInstanceId}` });
    const timer = h.ownerlessShips.get(shipInstanceId);
    if (timer !== undefined) {
      if (timer) clearTimeout(timer);
      h.ownerlessShips.delete(shipInstanceId);
    }
    ships.delete(shipInstanceId);
    return true;
  }
}
