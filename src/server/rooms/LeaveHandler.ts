/**
 * Player onLeave handler — disconnect / transit-out / dead-ship paths.
 *
 * Three branches, dispatched at the top:
 *   1. shouldLinger (galaxy room + alive ship + not transit-in-flight):
 *      Phase 8 sub-phase B lingering-ship rail. Writes a 15-min Limbo
 *      entry, mirrors into the roster row, sets the 15-min eviction
 *      timer, flips schema.isActive=false. Slot stays in playerToSlot
 *      for rebind. Does NOT add to lingeringSlots (that fills only on
 *      fresh-spawn-displaces in onJoin).
 *   2. transit-in-flight: destination room's onJoin restores from the
 *      transit Limbo entry; this room just unwinds session state +
 *      the worker DESPAWN.
 *   3. dead / engineering room: full despawn — slot returned to
 *      freeSlots, schema entry deleted, recordGameLeave.
 *
 * Always first: purge AI hostility ledger, clear session + per-tick
 * caches (sabAppliedTicks / boostingPlayers / thrustingPlayers / etc.),
 * cancel any in-flight transit orchestrator entry.
 *
 * Extracted from SectorRoom (commit 22 partial).
 */

import type { Client } from 'colyseus';
import type { Logger } from 'pino';
import type { Bus } from '../../core/events/Bus.js';
import type { MapSchema } from '@colyseus/schema';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { clearSession } from '../transit/sessionRegistry.js';
import { recordGameLeave } from '../stats/StatsService.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import type { WeaponMountTicker } from './WeaponMountTicker.js';
import type { RosterPersistence } from './RosterPersistence.js';
import type { SnapshotBroadcaster } from './SnapshotBroadcaster.js';

export interface LeaveHandlerDeps {
  sabF32: Float32Array;
  sectorKey: () => string | null;
  shipsMap: MapSchema<ShipState>;
  sessionToPlayer: Map<string, string>;
  playerToSession: Map<string, string>;
  playerToSlot: Map<string, number>;
  slotToPlayer: Map<number, string>;
  freeSlots: number[];
  lastFireClientTick: Map<string, number>;
  initialSpawnPositions: Map<string, { x: number; y: number }>;
  shipPoseCache: Map<string, ShipPhysicsState>;
  playerToUser: Map<string, unknown>;
  playerToActiveShipInstance: Map<string, string>;
  playerToTransitInFlight: Set<string>;
  // R2.26: value is `null` for a persist-forever lingering hull (presence
  // marker, no despawn timer); a real Timeout only on legacy/other arm sites.
  ownerlessShips: Map<string, ReturnType<typeof setTimeout> | null>;
  boostingPlayers: Set<string>;
  thrustingPlayers: Set<string>;
  snapshotBroadcaster: SnapshotBroadcaster;
  snapshotRing: { unregisterEntity(id: string): void };
  mountTicker: WeaponMountTicker;
  rosterPersistence: RosterPersistence;
  /** Resolves the active ShipState for a playerId. */
  getActiveShip: (pid: string) => ShipState | undefined;
  /** Resolves the shipInstanceId for a playerId (used to delete from
   *  shipsMap — keyed by shipInstanceId post-6a). */
  resolveActiveShipKey: (pid: string) => string | undefined;
  /** Hostility ledger surface — purge on leave. */
  aiController: { purgeHostility(playerId: string): void };
  /** Transit orchestrator — cancel any in-flight entry. */
  cancelTransit: (playerId: string, reason: 'manual') => void;
  /** Used to schedule the lingering TTL eviction. */
  evictOwnerlessShip: (shipInstanceId: string) => void;
  /** Test-only per-player disconnect-linger TTL override (ms). Returns
   *  undefined when the player passed no `lingerMs` JoinOption, in which
   *  case the production `LIMBO_DISCONNECT_TTL_MS` (15 min) is used. */
  lingerMs: (playerId: string) => number | undefined;
  /** Drop the captured lingerMs override for a player (called on leave). */
  clearLingerMs: (playerId: string) => void;
  postToWorker: (cmd: WorkerCmd) => void;
  bus: Bus;
  logger: Logger;
  serverLogEvent: (tag: string, data: Record<string, unknown>) => void;
}

export class LeaveHandler {
  constructor(private readonly deps: LeaveHandlerDeps) {}

  handle(client: Client, _consented: boolean): void {
    const d = this.deps;
    const playerId = d.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;

    // Capture the active ship's shipInstanceId NOW, before any cleanup
    // clears the indirection map. We need it to delete from the schema
    // (now shipInstanceId-keyed) at the end of the despawn path. May
    // be undefined if the player never finished joining; downstream
    // guards handle that case.
    const onLeaveShipKey = d.resolveActiveShipKey(playerId);

    // Phase 1 AI: drop this player from every drone's hostile set.
    d.aiController.purgeHostility(playerId);

    // Always clear session-bound state.
    d.sessionToPlayer.delete(client.sessionId);
    d.playerToSession.delete(playerId);
    d.snapshotBroadcaster.onClientLeave(client.sessionId);
    d.snapshotBroadcaster.sabAppliedTicks.delete(playerId);
    d.boostingPlayers.delete(playerId);
    d.thrustingPlayers.delete(playerId);
    clearSession(client.sessionId);

    const slot = d.playerToSlot.get(playerId);
    const ship = d.getActiveShip(playerId);
    const transitInFlight = d.playerToTransitInFlight.has(playerId);
    d.playerToTransitInFlight.delete(playerId);

    // Cancel any in-flight orchestrator entry for this player.
    d.cancelTransit(playerId, 'manual');

    // Branch 1: should-linger (Phase 8 sub-phase B).
    const shouldLinger =
      d.sectorKey() !== null
      && slot !== undefined
      && ship?.alive === true
      && !transitInFlight;

    if (shouldLinger) {
      const sectorKey = d.sectorKey()!;
      // WS-B (Phase 5): the disconnect Limbo entry is RETIRED. The roster
      // `markLinger` below is now the SINGLE source of reconnect/restore state —
      // the hull also persists in-world (`lingeringHulls[]` in the sector
      // snapshot) and a returning player resumes by shipId. The roster has no
      // enforced TTL (no prune sweep), so the hull effectively lingers forever
      // (R2.26) until combat / respawn-evict / abandon → scrap.
      const b = slotBase(slot!);
      d.rosterPersistence.markLinger(ship!.shipInstanceId, {
        x:      d.sabF32[b + SLOT_X_OFF]!,
        y:      d.sabF32[b + SLOT_Y_OFF]!,
        vx:     d.sabF32[b + SLOT_VX_OFF]!,
        vy:     d.sabF32[b + SLOT_VY_OFF]!,
        angle:  d.sabF32[b + SLOT_ANGLE_OFF]!,
        angvel: d.sabF32[b + SLOT_ANGVEL_OFF]!,
        health: ship!.health,
        lastFireClientTick: d.lastFireClientTick.get(playerId) ?? 0,
      });

      // Phase 6b cleanup — keyed by shipInstanceId. WS-12 / R2.26: lingering
      // hulls PERSIST IN THE WORLD FOREVER — there is NO timed despawn. We
      // record a `null` presence marker (so the rebind / restore / displace
      // gates that check `ownerlessShips` still detect the lingering hull) but
      // arm NO eviction timer. The hull leaves the world ONLY via the existing
      // explicit paths: combat destruction, the owner resuming a different
      // roster ship (respawn-evict), or abandonment → scrap (unchanged). The
      // `ttlMs` above still bounds the Limbo reconnect-DATA window, not the hull.
      const shipInstanceId = ship!.shipInstanceId;
      d.ownerlessShips.set(shipInstanceId, null);

      // Phase 6b — flip the schema's isActive=false. The slot stays in
      // playerToSlot for rebind. lingeringSlots fills only on
      // fresh-spawn-displaces in onJoin.
      ship.isActive = false;
      // Override consumed for this disconnect; drop it so a later rejoin
      // without lingerMs reverts to the production TTL.
      d.clearLingerMs(playerId);

      d.serverLogEvent('player_lingered', { playerId });
      auditEvent({ event: 'ship_lingered', sector: d.sectorKey() ?? undefined, playerId, shipInstanceId });
      d.logger.info(
        { playerId, sectorKey, health: ship.health },
        'player left, ship lingering in sector',
      );
      return;
    }

    // Branch 2/3: despawn path.
    d.lastFireClientTick.delete(playerId);
    d.mountTicker.clearPlayer(playerId);
    d.initialSpawnPositions.delete(playerId);
    d.snapshotRing.unregisterEntity(playerId);
    d.playerToActiveShipInstance.delete(playerId);
    d.clearLingerMs(playerId);

    if (slot !== undefined) {
      d.playerToSlot.delete(playerId);
      d.slotToPlayer.delete(slot);
      d.freeSlots.push(slot);
      d.postToWorker({ type: 'DESPAWN', slot, playerId });
    }

    if (onLeaveShipKey !== undefined) d.shipsMap.delete(onLeaveShipKey);
    d.shipPoseCache.delete(playerId);
    recordGameLeave(playerId);
    d.playerToUser.delete(playerId);
    d.bus.emit('SHIP_DESPAWNED', { type: 'SHIP_DESPAWNED' as const, playerId });
    d.serverLogEvent('player_leave', { playerId });
    auditEvent({ event: 'player_left', sector: d.sectorKey() ?? undefined, playerId });
    d.logger.info({ playerId }, 'player left');
  }
}
