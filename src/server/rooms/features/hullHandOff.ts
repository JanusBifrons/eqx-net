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
import { ROSTER_SOFT_GUARD } from '../../playerShips/PlayerShipStore.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { qualityHullFactor } from '../../../shared-types/blueprints.js';
import { getStructureKind, structureLocalToWorld } from '../../../shared-types/structureKinds.js';
import { shipyardBayKeel, shipyardBayOf } from '../../../core/articulation/rigs/heavyIndustry.js';
import { shipyardSlipFits } from '../../../core/structures/gateGeometry.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { WorkerCmd } from '../PhysicsWorkerProxy.js';
import type { ShipState } from '../schema/SectorState.js';
import type { SectorSnapshotRestore } from '../SectorSnapshotRestore.js';
import type { WarpTravelTracker } from '../warpTravel.js';
import type { WingmanPilots } from './wingmanPilots.js';
import type { HullMove } from './transitMessages.js';

/** A brand-new hull parks this far from the structure it came out of, then is
 *  nudged clear (`landingPoint`). Shared by the Shipyard and `unpack_hull`. */
export const NEW_HULL_PARK_OFFSET = 400;

/**
 * Where a brand-new hull appears and where it parks. Beside its maker
 * (`flyOut` false: it appears at the park point), or (loop 3M) on a
 * Shipyard's keel, nose out of the bow (`flyOut`: it then flies to the park
 * point on an ordinary Move order, the one a player gives).
 */
export interface NewHullOrigin {
  x: number; y: number; angle: number;
  parkX: number; parkY: number;
  flyOut: boolean;
}

/**
 * The origin for a `hullKind` hull made by a structure of `kind` at (x, y),
 * rotated `rotDeg`. A Shipyard prints it on the keel of its bay (loop 3R:
 * `shipyardBayKeel(shipyardBayOf(cycles))`, `cycles` = the yard's finished
 * builds, on the slip centre line) and it leaves through the open slipway
 * (`gateColliderBoxes`), over any empty bays ahead, out of the bow (local +x) to a spot
 * `NEW_HULL_PARK_OFFSET` beyond the bow edge; a hull too wide for the slip
 * (`shipyardSlipFits`: the Barge) appears at that spot. Any other maker (or
 * an unpacked crate): parked beside it, as before.
 * Ship heading: the nose points along (-sin a, cos a) (`applyShipInput`).
 * A `mirror`ed yard (build mirror) flips all of it through the shared
 * `structureLocalToWorld`: the bow, and so the nose, point to local −x.
 */
export function newHullOrigin(kind: string, x: number, y: number, rotDeg: number, hullKind: string, cycles?: number, mirror?: boolean): NewHullOrigin {
  if (kind !== 'shipyard') return { x: x + NEW_HULL_PARK_OFFSET, y, angle: 0, parkX: x + NEW_HULL_PARK_OFFSET, parkY: y, flyOut: false };
  const r = (rotDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const reach = getStructureKind('shipyard').footprint.w / 2 + NEW_HULL_PARK_OFFSET;
  const k = shipyardBayKeel(shipyardBayOf(cycles));
  const keel = structureLocalToWorld(k.x, k.y, x, y, c, s, mirror, { x: 0, y: 0 });
  const park = structureLocalToWorld(reach, 0, x, y, c, s, mirror, { x: 0, y: 0 });
  // Bow direction (local +x) in world, the nose's (-sin a, cos a).
  const bow = structureLocalToWorld(1, 0, 0, 0, c, s, mirror, { x: 0, y: 0 });
  return {
    x: keel.x, y: keel.y, angle: Math.atan2(-bow.x, bow.y),
    parkX: park.x, parkY: park.y, flyOut: shipyardSlipFits(hullKind),
  };
}

/** What {@link HullHandOff.launchNewHull} did: a roster ship (`live` = also
 *  parked in this sector now), or why nothing was created. */
export type NewHullResult =
  | { ok: true; shipId: string; live: boolean }
  | { ok: false; reason: 'no_galaxy' | 'roster_full' | 'no_slot' | 'failed' };

/** What the hull hand-off needs from the room; getters read the live field. */
export interface HullHandOffHost {
  sectorKey(): string | null;
  serverTick(): number;
  ships(): Pick<MapSchema<ShipState>, 'get' | 'delete'>;
  lingeringSlots: Pick<Map<string, number>, 'get' | 'has' | 'delete'>;
  lingeringPoseCache: Pick<Map<string, ShipPhysicsState>, 'delete'>;
  freeSlots(): Pick<number[], 'push' | 'length'>;
  playerToUser: Pick<ReadonlyMap<string, string | null>, 'get'>;
  ownerlessShips: Pick<Map<string, ReturnType<typeof setTimeout> | null>, 'get' | 'delete'>;
  fleet: Pick<FleetCommandSubsystem, 'exportSquads' | 'exportShip' | 'applyOrder'>;
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

  /**
   * A brand-new owned hull (a Shipyard build, or an unpacked crate): ONE
   * roster row (quality scales its hull, `qualityHullFactor`), put in the
   * world through the hand-off arrival path ({@link receiveHandedOffHull}): a
   * lingering hull its owner sees in Command view, defensive, online or not.
   * Its park point (`o.parkX/Y`) is nudged clear of structures and ships
   * (`landingPoint`). Beside its maker it appears there and guards it; out
   * of a Shipyard (`o.flyOut`) it appears on the keel facing the bow and
   * gets the owner's ordinary Move order to the park point (`applyOrder`),
   * after which it guards where it stopped (`clearFleetOrder`). `requireLive` (the Shipyard): no free slot or
   * a failed placement creates nothing, so the caller keeps its crate; else
   * the roster row stays even if it could not be placed now. Galaxy rooms only.
   */
  launchNewHull(playerId: string, kind: string, quality: number, o: NewHullOrigin, requireLive: boolean): NewHullResult {
    const h = this.h;
    const sectorKey = h.sectorKey();
    if (sectorKey === null) return { ok: false, reason: 'no_galaxy' };
    const store = getPlayerShipStore();
    const roster = store.listByPlayer(playerId);
    if (roster.length >= ROSTER_SOFT_GUARD) return { ok: false, reason: 'roster_full' };
    if (requireLive && h.freeSlots().length === 0) return { ok: false, reason: 'no_slot' };
    const p = clampToSectorBounds(o.parkX, o.parkY);
    const l = h.landingPoint(playerId, p.x, p.y, kind, NO_SHIP);
    const park = clampToSectorBounds(l.x, l.y);
    const at = o.flyOut ? clampToSectorBounds(o.x, o.y) : park;
    const health = Math.round(getShipKind(kind).maxHealth * qualityHullFactor(quality));
    let shipId: string;
    try {
      shipId = store.create({
        playerId, userId: h.playerToUser.get(playerId) ?? roster[0]?.userId ?? null,
        kind, sectorKey, x: at.x, y: at.y, health, hullQuality: quality,
      }).shipId;
    } catch {
      return { ok: false, reason: 'failed' };
    }
    const live = h.freeSlots().length > 0 && this.receiveHandedOffHull({
      shipInstanceId: shipId, playerId, kind, x: at.x, y: at.y, vx: 0, vy: 0, angle: o.flyOut ? o.angle : 0, angvel: 0,
      health, shieldDown: false, arrival: 'teleport', stance: 'defensive',
    });
    if (!live && requireLive) {
      store.delete(shipId);
      return { ok: false, reason: 'no_slot' };
    }
    if (live && o.flyOut) h.fleet.applyOrder(playerId, [shipId], { kind: 'move', x: park.x, y: park.y });
    return { ok: true, shipId, live };
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

/** `landingPoint` with an id no ship has: the owner's own ships are obstacles too. */
const NO_SHIP = '~new-hull';
