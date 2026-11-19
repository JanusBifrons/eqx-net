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
 * Extracted from SectorRoom (commit 22 partial). Also owns the other
 * end-of-life teardowns moved out of the room: `abandonShipToScrap` /
 * `abandonLingeringHullToScrap` (abandon → scrap or wreck) and
 * `onLingeringHullDeath` (a lingering hull died in combat). Built once in
 * `onCreate` (#14); discrete events only, never per tick.
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
import { recordGameLeave } from '../stats/StatsService.js';
import type { Client } from 'colyseus';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';
import type { FleetCommandSubsystem } from '../fleet/FleetCommandSubsystem.js';
import type { WingmanPilots } from './features/wingmanPilots.js';

export interface OwnerlessShipEvictorDeps {
  sabF32: Float32Array;
  sectorKey: () => string | null;
  shipsMap: MapSchema<ShipState>;
  ownerlessShips: Map<string, ReturnType<typeof setTimeout> | null>;
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
  // ── Abandon → scrap and lingering-hull death (moved from SectorRoom) ──
  getActiveShip(playerId: string): ShipState | undefined;
  fleet: Pick<FleetCommandSubsystem, 'forgetSquadMember'>;
  wingmen(): Pick<WingmanPilots, 'detachWingman'>;
  clients(): readonly Pick<Client, 'sessionId' | 'send' | 'leave'>[];
  playerToSession(): Map<string, string>;
  sessionToPlayer(): Map<string, string>;
  spawnCapitalWreck(
    targetId: string, kindId: string,
    pose: { x: number; y: number; vx: number; vy: number; angle: number; angvel?: number },
    maxHull: number, bodySlot?: number, bodyId?: string,
  ): boolean;
  spawnHullScrap(kind: ShipKindId, pose: { x: number; y: number; vx: number; vy: number; angle: number }, shipInstanceId: string): void;
  spillOrLoseShipHold(
    shipInstanceId: string, playerId: string,
    pose: { x: number; y: number; vx: number; vy: number } | undefined,
    cause: string, death?: { kind: string; vaporised: boolean; shooterId: string },
  ): void;
  awardKillXp(killerId: string, victimMaxHealth: number): void;
  deleteRosterRow(shipInstanceId: string): void;
}

export class OwnerlessShipEvictor {
  constructor(private readonly deps: OwnerlessShipEvictorDeps) {}

  evict(shipInstanceId: string): void {
    const d = this.deps;
    const timer = d.ownerlessShips.get(shipInstanceId);
    if (timer !== undefined) {
      if (timer) clearTimeout(timer); // R2.26: a persist-forever marker is null (no timer)
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

  /**
   * Equinox P6.3 (C2 — "scrap replaces wrecks") — abandon an ACTIVE hull by
   * shattering it into drifting scrap instead of converting it to a wreck. Same
   * trigger as the old `convertShipToWreck` (the roster row was deleted while the
   * ship was alive), but the hull leaves as scrap: spawn scrap at the death pose,
   * DESPAWN the body + free the slot (no wreck rekey), tear down the player-keyed
   * bookkeeping, and eject the owning session. No-op if missing / already dead.
   */
  abandonShipToScrap(playerId: string): void {
    const d = this.deps;
    const ship = d.getActiveShip(playerId);
    const slot = d.playerToSlot.get(playerId);
    if (ship === undefined || slot === undefined || ship.shipInstanceId === '') return;
    if (!ship.alive) return; // already destroyed — the despawn path handles it
    const shipInstanceId = ship.shipInstanceId;
    const b = slotBase(slot);
    const pose = d.shipPoseCache.get(playerId) ?? {
      x:     d.sabF32[b + SLOT_X_OFF]!,
      y:     d.sabF32[b + SLOT_Y_OFF]!,
      vx:    d.sabF32[b + SLOT_VX_OFF]!,
      vy:    d.sabF32[b + SLOT_VY_OFF]!,
      angle: d.sabF32[b + SLOT_ANGLE_OFF]!,
    };
    // Player capitals: an abandoned capital breaks into a wreck like its death
    // (its body despawned first; the DESPAWN below is then a no-op).
    d.spawnCapitalWreck(playerId, ship.kind, pose,
      ship.maxHealth > 0 ? ship.maxHealth : getShipKind(ship.kind).maxHealth, slot, playerId);
    d.spawnHullScrap(ship.kind as ShipKindId, pose, shipInstanceId);
    // Living World P1a — an abandoned hull's hold spills where it sat (P1a-2
    // turns this into a salvageable hulk).
    d.spillOrLoseShipHold(shipInstanceId, playerId, pose, 'abandoned');
    // RTS slice 4b: a squad member its owner was flying leaves its squad.
    d.fleet.forgetSquadMember(shipInstanceId);

    // Free the slot + DESPAWN the playerId body (no wreck rekey).
    d.freeSlots.push(slot);
    d.postToWorker({ type: 'DESPAWN', slot, playerId });

    // Tear down player-keyed bookkeeping (mirror of the old wreck path minus the
    // wreck slot maps).
    d.playerToSlot.delete(playerId);
    d.slotToPlayer.delete(slot);
    d.lastFireClientTick.delete(playerId);
    d.mountTicker.clearPlayer(playerId);
    d.initialSpawnPositions.delete(playerId);
    d.shipPoseCache.delete(playerId);
    d.snapshotRing.unregisterEntity(playerId);
    d.shipsMap.delete(shipInstanceId);
    d.playerToActiveShipInstance.delete(playerId);

    // Eject the owning session (if connected) — their next galaxy-map visit
    // shows the roster minus the abandoned row.
    const sessionId = d.playerToSession().get(playerId);
    if (sessionId !== undefined) {
      const client = d.clients().find((c) => c.sessionId === sessionId);
      if (client !== undefined) {
        try { client.send('ship_abandoned', { shipInstanceId }); } catch { /* socket already closed */ }
        try { client.leave(1000); } catch { /* already gone */ }
      }
      d.playerToSession().delete(playerId);
    }
    d.sessionToPlayer().forEach((pid, sid) => {
      if (pid === playerId) d.sessionToPlayer().delete(sid);
    });
    d.playerToUser.delete(playerId);

    d.serverLogEvent('ship_abandoned', { playerId, shipInstanceId, sectorKey: d.sectorKey() });
    auditEvent({ event: 'ship_abandoned', sector: d.sectorKey() ?? undefined, playerId, shipInstanceId });
    d.logger.info({ playerId, shipInstanceId, sectorKey: d.sectorKey() }, 'ship abandoned → scrap');
  }

  /**
   * Equinox P6.3 (C2) — abandon a LINGERING hull (displaced / disconnected,
   * isActive=false) by shattering it into scrap. Mirrors the lingering-hull
   * DEATH policy (slot/pose teardown + scrap), keyed by shipInstanceId so it
   * NEVER touches any playerId-keyed map (the owner may be piloting a different
   * active hull). No-op if missing / already dead.
   */
  abandonLingeringHullToScrap(shipInstanceId: string): void {
    const d = this.deps;
    const ship = d.shipsMap.get(shipInstanceId);
    const slot = d.lingeringSlots.get(shipInstanceId);
    if (ship === undefined || slot === undefined || ship.shipInstanceId === '') return;
    if (!ship.alive) return;
    const b = slotBase(slot);
    const pose = d.lingeringPoseCache.get(shipInstanceId) ?? {
      x:     d.sabF32[b + SLOT_X_OFF]!,
      y:     d.sabF32[b + SLOT_Y_OFF]!,
      vx:    d.sabF32[b + SLOT_VX_OFF]!,
      vy:    d.sabF32[b + SLOT_VY_OFF]!,
      angle: d.sabF32[b + SLOT_ANGLE_OFF]!,
    };
    d.spawnCapitalWreck(shipInstanceId, ship.kind, pose,
      ship.maxHealth > 0 ? ship.maxHealth : getShipKind(ship.kind).maxHealth, slot, `linger-${shipInstanceId}`);
    d.spawnHullScrap(ship.kind as ShipKindId, pose, shipInstanceId);
    d.spillOrLoseShipHold(shipInstanceId, ship.playerId, pose, 'abandoned');

    d.wingmen().detachWingman(shipInstanceId);
    d.lingeringSlots.delete(shipInstanceId);
    d.lingeringPoseCache.delete(shipInstanceId);
    d.freeSlots.push(slot);
    // The displaced lingering body is keyed `linger-${shipInstanceId}`.
    d.postToWorker({ type: 'DESPAWN', slot, playerId: `linger-${shipInstanceId}` });
    const timer = d.ownerlessShips.get(shipInstanceId);
    if (timer !== undefined) {
      if (timer) clearTimeout(timer); // R2.26: a persist-forever marker is null
      d.ownerlessShips.delete(shipInstanceId);
    }
    d.shipsMap.delete(shipInstanceId);

    d.serverLogEvent('ship_abandoned', {
      playerId: ship.playerId, shipInstanceId, sectorKey: d.sectorKey(), lingering: true,
    });
    auditEvent({ event: 'ship_abandoned', sector: d.sectorKey() ?? undefined, playerId: ship.playerId, shipInstanceId });
    d.logger.info({ playerId: ship.playerId, shipInstanceId, sectorKey: d.sectorKey() }, 'lingering hull abandoned → scrap');
  }

  /**
   * Hostile-review A1 — a LINGERING hull died in combat. Runs inside the
   * lingering death policy BEFORE its teardown (see `LeafDeps.onLingeringHullDeath`).
   * Mirrors what the `SHIP_DESTROYED` handler does for an ACTIVE hull — that
   * handler can't resolve a lingering hull (it has left `shipsMap` by emit time):
   *  - award the killer's XP (victim toughness from the catalogue);
   *  - wipe the roster row (D9 — and with it the ship's carried hold);
   *  - drop the persist-forever ownerless marker (the hull is gone).
   */
  onLingeringHullDeath(
    ship: { shipInstanceId: string; playerId: string; kind: string },
    pose: { x: number; y: number; vx: number; vy: number } | undefined,
    sourceId: string,
    vaporised = false,
  ): void {
    const d = this.deps;
    // RTS slice 4: the dying hull stops being flown before the leaf frees its slot.
    d.wingmen().detachWingman(ship.shipInstanceId);
    d.awardKillXp(sourceId, getShipKind(ship.kind).maxHealth);
    // Hardcore: the dead hull's hold spills where it died (atomic with the
    // ship-hold delete), with its hull salvage. With no pose both are lost.
    d.spillOrLoseShipHold(ship.shipInstanceId, ship.playerId, pose, 'lingering_death',
      { kind: ship.kind, vaporised, shooterId: sourceId });
    d.deleteRosterRow(ship.shipInstanceId);
    const timer = d.ownerlessShips.get(ship.shipInstanceId);
    if (timer) clearTimeout(timer);
    d.ownerlessShips.delete(ship.shipInstanceId);
  }
}
