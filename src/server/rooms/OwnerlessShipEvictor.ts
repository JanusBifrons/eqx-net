/**
 * Phase 8 sub-phase B — full despawn for an ownerless ship.
 *
 * Three callers:
 *   - The eviction timer (started in onLeave's `shouldLinger` branch)
 *     fires after `LIMBO_DISCONNECT_TTL_MS` without reconnect.
 *   - The lingering hull is destroyed by combat mid-offline
 *     (applyDamage's lingering branch + the snapshot eviction tail).
 *   - The room is disposed (timer is unrefd; cleanup runs in onDispose).
 *
 * Branches on `lingeringSlots.has(shipInstanceId)`:
 *   - active-hull eviction (player's 15-min TTL fired with no
 *     reconnect): full player-scope teardown — slot, fire ticks,
 *     mount angles, spawn pose, snapshot ring, indirection, schema,
 *     pose cache, user map, Limbo delete, recordGameLeave.
 *   - lingering-hull eviction (the hull was displaced by a fresh
 *     spawn; the player is piloting a different hull): free the
 *     `lingeringSlots` side only — DESPAWN the `linger-${id}` body,
 *     leave player-keyed maps alone.
 *
 * Both cases delete the schema entry + mark the roster row stored
 * (frozen pose, indefinite retention so the player can pick it later).
 *
 * Extracted from SectorRoom (commit 22 partial).
 */

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
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import type { WeaponMountTicker } from './WeaponMountTicker.js';
import type { RosterPersistence, RosterPose } from './RosterPersistence.js';
import { getLimboStore } from '../db/PersistenceWorker.js';
import { recordGameLeave } from '../stats/StatsService.js';

export interface OwnerlessShipEvictorDeps {
  sabF32: Float32Array;
  sectorKey: () => string | null;
  shipsMap: MapSchema<ShipState>;
  ownerlessShips: Map<string, ReturnType<typeof setTimeout>>;
  lingeringSlots: Map<string, number>;
  lingeringPoseCache: Map<string, ShipPhysicsState>;
  playerToSlot: Map<string, number>;
  slotToPlayer: Map<number, string>;
  freeSlots: number[];
  lastFireClientTick: Map<string, number>;
  initialSpawnPositions: Map<string, { x: number; y: number }>;
  shipPoseCache: Map<string, ShipPhysicsState>;
  playerToUser: Map<string, unknown>;
  playerToActiveShipInstance: Map<string, string>;
  snapshotRing: { unregisterEntity(id: string): void };
  mountTicker: WeaponMountTicker;
  rosterPersistence: RosterPersistence;
  postToWorker: (cmd: WorkerCmd) => void;
  bus: Bus;
  logger: Logger;
  serverLogEvent: (tag: string, data: Record<string, unknown>) => void;
}

export class OwnerlessShipEvictor {
  constructor(private readonly deps: OwnerlessShipEvictorDeps) {}

  evict(shipInstanceId: string): void {
    const d = this.deps;
    const timer = d.ownerlessShips.get(shipInstanceId);
    if (timer !== undefined) {
      clearTimeout(timer);
      d.ownerlessShips.delete(shipInstanceId);
    }

    const ship = d.shipsMap.get(shipInstanceId);
    if (ship === undefined) {
      // Already cleaned up by another path (e.g. applyDamage destroyed
      // the lingering hull and ran the lingeringSlots cleanup inline).
      return;
    }
    const playerId = ship.playerId;

    // Branch on lingering vs active.
    const isLingeringHull = d.lingeringSlots.has(shipInstanceId);
    const slot = isLingeringHull
      ? d.lingeringSlots.get(shipInstanceId)
      : d.playerToSlot.get(playerId);

    // Capture final pose for the roster mirror BEFORE freeing the schema entry.
    let rosterPose: RosterPose | null = null;
    if (slot !== undefined) {
      const b = slotBase(slot);
      if (ship.alive && ship.health <= 0) {
        d.logger.warn(
          { playerId, shipId: shipInstanceId, shipHealth: ship.health, sectorKey: d.sectorKey(), isLingeringHull },
          'evicting lingering ship with non-positive health — applyDamage race?',
        );
      }
      rosterPose = {
        x:      d.sabF32[b + SLOT_X_OFF]!,
        y:      d.sabF32[b + SLOT_Y_OFF]!,
        vx:     d.sabF32[b + SLOT_VX_OFF]!,
        vy:     d.sabF32[b + SLOT_VY_OFF]!,
        angle:  d.sabF32[b + SLOT_ANGLE_OFF]!,
        angvel: d.sabF32[b + SLOT_ANGVEL_OFF]!,
        health: Math.max(1, ship.health),
        lastFireClientTick: isLingeringHull ? 0 : (d.lastFireClientTick.get(playerId) ?? 0),
      };
    }

    if (isLingeringHull) {
      // Free only the lingering-hull side of bookkeeping. The player's
      // active hull (if any) keeps all of its playerId-keyed entries.
      d.lingeringSlots.delete(shipInstanceId);
      d.lingeringPoseCache.delete(shipInstanceId);
      if (slot !== undefined) {
        d.freeSlots.push(slot);
        // The worker rekeyed this body to `linger-${shipInstanceId}` at
        // the fresh-spawn-displaces point; DESPAWN must use the same
        // key or it'd despawn the player's active ship.
        d.postToWorker({ type: 'DESPAWN', slot, playerId: `linger-${shipInstanceId}` });
      }
    } else {
      // Active-hull eviction — full player-scope teardown.
      d.lastFireClientTick.delete(playerId);
      d.mountTicker.clearPlayer(playerId);
      d.initialSpawnPositions.delete(playerId);
      d.snapshotRing.unregisterEntity(playerId);
      d.playerToActiveShipInstance.delete(playerId);
      if (slot !== undefined) {
        d.playerToSlot.delete(playerId);
        d.slotToPlayer.delete(slot);
        d.freeSlots.push(slot);
        d.postToWorker({ type: 'DESPAWN', slot, playerId });
      }
      d.shipPoseCache.delete(playerId);
      d.playerToUser.delete(playerId);

      // Clear the active-Limbo UI gate.
      try {
        getLimboStore().delete(playerId);
      } catch (err) {
        d.logger.warn({ err, playerId }, 'Limbo delete on eviction failed');
      }

      recordGameLeave(playerId);
    }

    // Schema entry removal applies to both cases.
    d.shipsMap.delete(shipInstanceId);

    // Phase 3 dual-write — flip the roster row to stored state with
    // the ship's last pose frozen in place. Indefinite retention.
    if (rosterPose !== null) {
      d.rosterPersistence.markStored(shipInstanceId, rosterPose);
    }

    d.bus.emit('SHIP_DESPAWNED', { type: 'SHIP_DESPAWNED' as const, playerId });
    d.serverLogEvent('ownerless_evicted', { playerId, shipInstanceId, isLingeringHull });
    d.logger.info(
      { playerId, shipInstanceId, sectorKey: d.sectorKey(), isLingeringHull },
      'ownerless ship evicted',
    );
  }
}
