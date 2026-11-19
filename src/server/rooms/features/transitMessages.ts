/**
 * Transit client messages — `engage_transit` and `cancel_transit` (Phase 8
 * sub-phase B). Moved verbatim out of `SectorRoom.onCreate`. Both check the
 * sender and the orchestrator BEFORE the parse (a message from an unknown
 * session is dropped without a malformed note), so they register directly
 * rather than through `parsedMessage`.
 */
import type { Client } from 'colyseus';
import type { TransitHostRoom, TransitOrchestrator } from '../../transit/TransitOrchestrator.js';
import type { FleetCommandSubsystem } from '../../fleet/FleetCommandSubsystem.js';
import type { TeleportRoom } from '../../teleport/TeleportBroker.js';
import type { MapSchema } from '@colyseus/schema';
import type { ShipState } from '../schema/SectorState.js';
import type { FleetRoomHooks } from './fleetRoomHooks.js';
import { getTeleportBroker } from '../../teleport/TeleportBroker.js';
import { fleetArrivalPoses, largestHullIndex, type FleetArrivalPose } from '../../transit/fleetArrivalPoses.js';
import { isLingeringHull } from '../../../core/entity/shipLiveness.js';
import { clearFleetOrder } from '../../fleet/fleetShipOrders.js';
import { FLEET_STOP_ORDER } from './fleetMessages.js';
import { SHIP_MAX_HEALTH } from '../../../core/combat/Weapons.js';
import { DEFAULT_SHIP_KIND } from '../../../shared-types/shipKinds.js';
import { SLOT_ANGLE_OFF, slotBase } from '../../../shared-types/sabLayout.js';
import type { ParsedMessageHost, RoomFeature } from './parsedMessage.js';
import { CancelTransitSchema, EngageTransitSchema } from '../../../shared-types/messages.js';

/** What the handlers need from the room; getters read the live field. */
export interface TransitMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  transitOrchestrator(): Pick<
    TransitOrchestrator,
    'beginTransit' | 'beginFleetTransit' | 'cancelTransit' | 'cancelFleetTransits'
  > | null;
}

export function registerTransitMessages(h: TransitMessageHost): RoomFeature {
  h.onMessage('engage_transit', (client: Client, raw: unknown) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    const transitOrchestrator = h.transitOrchestrator();
    if (!playerId || !transitOrchestrator) return;
    const parsed = EngageTransitSchema.safeParse(raw);
    if (!parsed.success) {
      h.malformed.record(client.sessionId, 'engage_transit');
      return;
    }
    // RTS fleet warp: the selected ships warp together (Command view).
    if (parsed.data.shipIds !== undefined) {
      transitOrchestrator.beginFleetTransit(
        playerId,
        parsed.data.targetSectorKey,
        parsed.data.shipIds,
        parsed.data.arrival,
      );
      return;
    }
    transitOrchestrator.beginTransit(
      playerId,
      parsed.data.targetSectorKey,
      parsed.data.arrival,
      parsed.data.shipId,
    );
  });

  h.onMessage('cancel_transit', (client: Client, raw: unknown) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    const transitOrchestrator = h.transitOrchestrator();
    if (!playerId || !transitOrchestrator) return;
    const parsed = CancelTransitSchema.safeParse(raw);
    if (!parsed.success) {
      h.malformed.record(client.sessionId, 'cancel_transit');
      return;
    }
    transitOrchestrator.cancelTransit(playerId, 'manual');
    // …and any fleet warp they ordered (a disconnect does not cancel those).
    transitOrchestrator.cancelFleetTransits(playerId, 'manual');
  });
  return {};
}

// ── Phase 8 sub-phase B — TransitOrchestrator host adapter (moved verbatim
// from SectorRoom) ───────────────────────────────────────────────────────

/** One parked hull for `handOffHullsTo`: where it lands in the far sector. */
export interface HullMove {
  shipInstanceId: string;
  x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
}

/** RTS fleet warp: `handOffHulls` until slice S3 moves hulls. */
const NO_HULLS_MOVED: readonly string[] = [];

/** What the adapter reads from the room. Built once, in `onCreate`, where the
 *  orchestrator is made (the plain values are read there, as before). */
export interface TransitRoomHost extends Pick<TransitHostRoom,
  'sectorKey' | 'bus' | 'sabF32' | 'playerToSlot' | 'playerToUser' | 'playerToActiveShipInstance'
  | 'lastFireClientTick' | 'playerToTransitInFlight' | 'broadcast'> {
  readonly playerToSession: ReadonlyMap<string, string>;
  readonly lingeringSlots: ReadonlyMap<string, number>;
  readonly fleet: Pick<FleetCommandSubsystem, 'applyOrder' | 'ownerOfAttached' | 'ordersOf'>;
  readonly fleetHooks: Pick<FleetRoomHooks, 'fleetStatusSoonFor' | 'fleetHullPoses'>;
  getActiveShip(playerId: string): ShipState | undefined;
  clients(): readonly Client[];
  ships(): Pick<MapSchema<ShipState>, 'get'>;
  handOffHullsTo(toRoom: TeleportRoom, moves: readonly HullMove[], arrival: 'warp' | 'teleport'): readonly string[];
}

/**
 * Adapts this room to the narrow `TransitHostRoom` contract the
 * orchestrator depends on. Keeps the orchestrator decoupled from the
 * full SectorRoom surface so its tests can mock just these members.
 */
export function transitHostRoom(h: TransitRoomHost): TransitHostRoom {
  return {
    sectorKey: h.sectorKey,
    bus: h.bus,
    sabF32: h.sabF32,
    playerToSlot: h.playerToSlot,
    playerToUser: h.playerToUser,
    playerToActiveShipInstance: h.playerToActiveShipInstance,
    lastFireClientTick: h.lastFireClientTick,
    getShipHealth: (playerId: string): number => {
      const ship = h.getActiveShip(playerId);
      return ship?.health ?? SHIP_MAX_HEALTH;
    },
    getShipKind: (playerId: string): string => {
      const ship = h.getActiveShip(playerId);
      return ship?.kind ?? DEFAULT_SHIP_KIND;
    },
    // Campaign 3.1 — warp requires a LIVE hull. Alive-only, NOT isActive:
    // a dead player has no state.ships entry under their playerId (removed
    // or rekeyed to linger-<id>), so `!!ship && ship.alive` fully blocks the
    // dead-warp bug, while a PENDING hull (joined, pre-client_ready —
    // isActive still false) keeps its long-standing ability to engage
    // transit (the Phase-A9 transitShipIdBinding wiring contract).
    hasLiveHull: (playerId: string): boolean => {
      const ship = h.getActiveShip(playerId);
      return !!ship && ship.alive;
    },
    playerToTransitInFlight: h.playerToTransitInFlight,
    clientForPlayer: (playerId: string): Client | null => {
      const sessionId = h.playerToSession.get(playerId);
      if (!sessionId) return null;
      const c = h.clients().find((x) => x.sessionId === sessionId);
      return c ?? null;
    },
    broadcast: (type: string, message: unknown, options?: { except?: Client | Client[] }): void => {
      h.broadcast(type, message, options);
    },
    // ── RTS fleet warp hooks ──────────────────────────────────────────
    // A parked (LINGERING, #17) hull in this room, owned by the commander.
    canFleetWarp: (commanderId: string, shipId: string): boolean => {
      if (!h.lingeringSlots.has(shipId)) return false;
      const ship = h.ships().get(shipId);
      return ship !== undefined && isLingeringHull(ship)
        && ship.playerId === commanderId && ship.shipInstanceId === shipId;
    },
    // The existing fleet `stop` order holds them while they spool.
    holdFleetShips: (commanderId: string, shipIds: readonly string[]): void => {
      h.fleet.applyOrder(commanderId, shipIds, FLEET_STOP_ORDER);
      h.fleetHooks.fleetStatusSoonFor(commanderId);
    },
    // Clear the hold: each ship goes back to its mode (a squad's leader to
    // the squad mode; members follow it).
    releaseFleetShips: (commanderId: string, shipIds: readonly string[]): void => {
      for (let i = 0; i < shipIds.length; i++) {
        const id = shipIds[i]!;
        if (h.fleet.ownerOfAttached(id) !== commanderId) continue;
        const w = h.fleet.ordersOf(id);
        if (w !== null) clearFleetOrder(w);
      }
      h.fleetHooks.fleetStatusSoonFor(commanderId);
    },
    // The LARGEST hull's live pose (the `fleetArrivalPoses` rule: it lands
    // on the anchor and the others keep their offsets from it).
    fleetAnchor: (shipIds: readonly string[]): { x: number; y: number } | null => {
      const hulls = h.fleetHooks.fleetHullPoses(shipIds, null);
      const lead = largestHullIndex(hulls);
      return lead === -1 ? null : { x: hulls[lead]!.x, y: hulls[lead]!.y };
    },
    // The parked hulls go through the ONE hand-off the teleporter uses, in
    // formation round the anchor (velocity zeroed, heading kept).
    handOffHulls: (shipIds: readonly string[], destSectorKey: string, anchor: { x: number; y: number }): readonly string[] => {
      const toRoom = getTeleportBroker().room(destSectorKey);
      if (toRoom === null) return NO_HULLS_MOVED;
      const ids: string[] = [];
      const hulls = h.fleetHooks.fleetHullPoses(shipIds, ids);
      const poses: FleetArrivalPose[] = [];
      if (fleetArrivalPoses(hulls, anchor, poses) === -1) return NO_HULLS_MOVED;
      const moves: HullMove[] = [];
      for (let i = 0; i < ids.length; i++) {
        const slot = h.lingeringSlots.get(ids[i]!)!;
        moves.push({
          shipInstanceId: ids[i]!, x: poses[i]!.x, y: poses[i]!.y,
          vx: 0, vy: 0, angle: h.sabF32[slotBase(slot) + SLOT_ANGLE_OFF]!, angvel: 0,
        });
      }
      return h.handOffHullsTo(toRoom, moves, 'warp');
    },
  };
}
