/**
 * Atomic wreck-lifecycle transaction.
 *
 * Owns the three wreck-bookkeeping stores:
 *   - `wreckToSlot` / `slotToWreck` — bidirectional slot⇄wreck index
 *   - `wreckPoseCache` — frozen pose at conversion time (clients render
 *     wrecks from this snapshot until snapshot serialisation reads it)
 *   - `wreckConversions` counter — diagnostic
 *
 * Exposes the convert + destroy transactions; both touch ~14 collaborating
 * state stores on SectorRoom (slot maps, identity maps, session maps,
 * Colyseus schema, snapshot ring, mount-angle ticker, …) via injected
 * deps so the room stays the orchestrator + this owns the transaction.
 *
 * Crash safety: each transaction does its `state.wrecks.set` / `delete`
 * FIRST and the dependent ledger updates after — so if a future
 * refactor splits this further, the wire-visible state stays
 * consistent with the broadcast schema.
 *
 * Extracted from SectorRoom (commit 15 of v3 refactor plan).
 */

import type { Client, ClientArray } from 'colyseus';
import type { MapSchema } from '@colyseus/schema';
import type { Logger } from 'pino';
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
import type { ShipState, WreckState } from './schema/SectorState.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import type { WeaponMountTicker } from './WeaponMountTicker.js';

/** Narrow view of the snapshot ring the coordinator must un-register entities from. */
export interface SnapshotRingHandle {
  unregisterEntity(id: string): void;
}

export interface WreckLifecycleCoordinatorDeps {
  /** Resolves the active ShipState for a playerId — returns undefined when lingering or absent. */
  getActiveShip: (playerId: string) => ShipState | undefined;
  /** Constructor for the Colyseus WreckState schema row. */
  newWreckState: () => WreckState;
  /** Colyseus schema maps (passed by reference; the room exposes them
   *  to the snapshot serialiser + Colyseus's diff broadcast). */
  state: { ships: MapSchema<ShipState>; wrecks: MapSchema<WreckState> };
  /** SAB Float32 view — fallback pose source when shipPoseCache misses. */
  sabF32: Float32Array;
  /** Per-tick player pose cache. */
  shipPoseCache: Map<string, ShipPhysicsState>;
  /** Phase 6b lingering-hull bookkeeping (shipInstanceId-keyed). The
   *  lingering→wreck conversion reads the displaced hull's slot + frozen
   *  pose from here, and cancels its pending auto-evict timer. */
  lingeringSlots: Map<string, number>;
  lingeringPoseCache: Map<string, ShipPhysicsState>;
  ownerlessShips: Map<string, ReturnType<typeof setTimeout>>;
  /** Slot bookkeeping (room owns the canonical maps). */
  playerToSlot: Map<string, number>;
  slotToPlayer: Map<number, string>;
  freeSlots: number[];
  /** Per-player ledgers cleared on wreck conversion. */
  lastFireClientTick: Map<string, number>;
  initialSpawnPositions: Map<string, unknown>;
  /** Mount-angle ticker — wreck conversion clears the converted player's slot. */
  mountTicker: WeaponMountTicker;
  /** Phase 6a indirection — drop on conversion (the player no longer has an active ship here). */
  playerToActiveShipInstance: Map<string, string>;
  /** Session bookkeeping. */
  playerToSession: Map<string, string>;
  sessionToPlayer: Map<string, string>;
  playerToUser: Map<string, unknown>;
  /** Snapshot ring — drop the playerId entity row. */
  snapshotRing: SnapshotRingHandle;
  /** Colyseus client list (room.clients). */
  clients: ClientArray<Client>;
  /** Typed postMessage facade for the physics worker. */
  postToWorker: (cmd: WorkerCmd) => void;
  /** Sector key (galaxy-* or null for engineering rooms). Included in log lines. */
  sectorKey: () => string | null;
  /** Pino logger for the lifecycle log line. */
  logger: Logger;
  /** Server log-event sink (diagnostic capture stream). */
  serverLogEvent: (tag: string, data: Record<string, unknown>) => void;
}

export class WreckLifecycleCoordinator {
  /** Bidirectional slot⇄wreck index. Cleared by `destroyWreck`. */
  readonly wreckToSlot = new Map<string, number>();
  readonly slotToWreck = new Map<number, string>();
  /** Pose at conversion (frozen). Read by snapshot serialiser + Phase 6b lingering paths. */
  readonly wreckPoseCache = new Map<string, ShipPhysicsState>();
  /** Diagnostic counter — incremented on every successful convert. */
  wreckConversions = 0;

  constructor(private readonly deps: WreckLifecycleCoordinatorDeps) {}

  /**
   * Phase 4 — convert an active ship into a wreck and re-key the SAB
   * slot + Rapier body so the player can rejoin (same playerId) without
   * orphaning the wreck body.
   *
   * 8-collaborator atomic transaction:
   *   1. Build the WreckState schema entry.
   *   2. Transfer slot ownership + REKEY_SHIP the worker body.
   *   3. Tear down player-keyed bookkeeping (slot maps, fire ticks,
   *      mount angles, spawn pose, snapshot ring, ships schema,
   *      activeShipInstance indirection).
   *   4. Force the owning session to leave (if connected).
   *   5. Drop session + user maps.
   *   6. Increment counter + emit log events.
   *
   * No-op when ship missing / slot missing / shipInstanceId blank.
   * No-op when ship already destroyed (the standard despawn path
   * handles cleanup — don't leave a destroyed-but-orphaned wreck).
   */
  convertShipToWreck(playerId: string): void {
    const d = this.deps;
    const ship = d.getActiveShip(playerId);
    const slot = d.playerToSlot.get(playerId);
    if (ship === undefined || slot === undefined || ship.shipInstanceId === '') return;
    if (!ship.alive) {
      // Already destroyed — the standard despawn path handles cleanup.
      // Don't leave a destroyed-but-orphaned wreck.
      return;
    }
    const shipInstanceId = ship.shipInstanceId;
    const b = slotBase(slot);
    const pose = d.shipPoseCache.get(playerId) ?? {
      x:      d.sabF32[b + SLOT_X_OFF]!,
      y:      d.sabF32[b + SLOT_Y_OFF]!,
      vx:     d.sabF32[b + SLOT_VX_OFF]!,
      vy:     d.sabF32[b + SLOT_VY_OFF]!,
      angle:  d.sabF32[b + SLOT_ANGLE_OFF]!,
      angvel: d.sabF32[b + SLOT_ANGVEL_OFF]!,
    };

    // 1) Build the wreck schema entry.
    const wreck = d.newWreckState();
    wreck.shipInstanceId = shipInstanceId;
    wreck.kind = ship.kind;
    wreck.health = ship.health;
    wreck.maxHealth = ship.maxHealth;
    d.state.wrecks.set(shipInstanceId, wreck);
    this.wreckPoseCache.set(shipInstanceId, pose);

    // 2) Transfer SAB slot ownership AND re-key the underlying Rapier
    //    body in the worker. Without the REKEY_SHIP command, the next
    //    SPAWN for this playerId (same browser → same eqxPlayerId on
    //    reconnect) would overwrite `physics.bodies[playerId]` and
    //    orphan the wreck body — still alive in Rapier, still
    //    collidable, but invisible to the SAB writer because
    //    `getAllShipStates()` no longer iterates it. The client would
    //    render the wreck at a stale frozen pose while the real
    //    physics body drifts somewhere else and collisions land in
    //    empty space.
    this.slotToWreck.set(slot, shipInstanceId);
    this.wreckToSlot.set(shipInstanceId, slot);
    d.postToWorker({ type: 'REKEY_SHIP', oldId: playerId, newId: `wreck-${shipInstanceId}` });

    // 3) Tear down player-keyed bookkeeping. Slot is NOT pushed onto
    //    freeSlots — the wreck still owns it.
    d.playerToSlot.delete(playerId);
    d.slotToPlayer.delete(slot);
    d.lastFireClientTick.delete(playerId);
    d.mountTicker.clearPlayer(playerId);
    d.initialSpawnPositions.delete(playerId);
    d.shipPoseCache.delete(playerId);
    d.snapshotRing.unregisterEntity(playerId);
    // Phase 6b — schema is shipInstanceId-keyed; the local already
    // captured `shipInstanceId` from the ship reference earlier.
    d.state.ships.delete(shipInstanceId);
    // Phase 6a — drop the playerId → shipInstanceId indirection. The
    // hull is now a wreck (keyed by shipInstanceId in `state.wrecks`);
    // the player no longer has an active ship in this room.
    d.playerToActiveShipInstance.delete(playerId);

    // 4) Force the owning session to leave (if connected). The player
    //    sees their roster missing this ship on the next galaxy-map
    //    visit. The Limbo path is bypassed — the row is already gone.
    const sessionId = d.playerToSession.get(playerId);
    if (sessionId !== undefined) {
      const client = d.clients.find((c) => c.sessionId === sessionId);
      if (client !== undefined) {
        try { client.send('ship_abandoned', { shipInstanceId }); } catch { /* socket already closed */ }
        try { client.leave(1000); } catch { /* already gone */ }
      }
      d.playerToSession.delete(playerId);
    }
    d.sessionToPlayer.forEach((pid, sid) => {
      if (pid === playerId) d.sessionToPlayer.delete(sid);
    });
    d.playerToUser.delete(playerId);

    this.wreckConversions++;
    d.serverLogEvent('ship_abandoned', { playerId, shipInstanceId, sectorKey: d.sectorKey() });
    d.logger.info({ playerId, shipInstanceId, sectorKey: d.sectorKey() }, 'ship abandoned → wreck');
  }

  /**
   * Convert a LINGERING hull (displaced / disconnected, `isActive=false`,
   * slot tracked in `lingeringSlots`) into a wreck. Mirrors
   * `convertShipToWreck` but keyed by shipInstanceId, because the owning
   * player may be piloting a DIFFERENT active hull in this same room — so
   * this path must NEVER tear down any playerId-keyed state.
   *
   * Symmetric with the abandon-active path: "an abandoned ship becomes a
   * wreck if it's still in the game world." A lingering hull is still in
   * the world (a remote observer renders it), so abandoning it leaves a
   * wreck rather than silently lingering out its 15-min TTL.
   *
   * No-op when the hull is missing / has no lingering slot / is already
   * destroyed.
   */
  convertLingeringHullToWreck(shipInstanceId: string): void {
    const d = this.deps;
    const ship = d.state.ships.get(shipInstanceId);
    const slot = d.lingeringSlots.get(shipInstanceId);
    if (ship === undefined || slot === undefined || ship.shipInstanceId === '') return;
    if (!ship.alive) return;

    const b = slotBase(slot);
    const pose = d.lingeringPoseCache.get(shipInstanceId) ?? {
      x:      d.sabF32[b + SLOT_X_OFF]!,
      y:      d.sabF32[b + SLOT_Y_OFF]!,
      vx:     d.sabF32[b + SLOT_VX_OFF]!,
      vy:     d.sabF32[b + SLOT_VY_OFF]!,
      angle:  d.sabF32[b + SLOT_ANGLE_OFF]!,
      angvel: d.sabF32[b + SLOT_ANGVEL_OFF]!,
    };

    // 1) Build the wreck schema entry (schema-first for crash safety).
    const wreck = d.newWreckState();
    wreck.shipInstanceId = shipInstanceId;
    wreck.kind = ship.kind;
    wreck.health = ship.health;
    wreck.maxHealth = ship.maxHealth;
    d.state.wrecks.set(shipInstanceId, wreck);
    this.wreckPoseCache.set(shipInstanceId, pose);

    // 2) Transfer slot ownership + re-key the Rapier body. The displaced
    //    hull's body was re-keyed to `linger-${id}` at the
    //    fresh-spawn-displaces point (SectorRoom rebind branch), so the
    //    REKEY here must use that same old id — not the playerId.
    this.slotToWreck.set(slot, shipInstanceId);
    this.wreckToSlot.set(shipInstanceId, slot);
    d.postToWorker({ type: 'REKEY_SHIP', oldId: `linger-${shipInstanceId}`, newId: `wreck-${shipInstanceId}` });

    // 3) Tear down ONLY the lingering-hull bookkeeping. Slot is NOT
    //    pushed onto freeSlots — the wreck owns it now. Cancel the
    //    pending auto-evict timer or it would later DESPAWN the (now
    //    gone) `linger-${id}` body and double-free the slot.
    d.lingeringSlots.delete(shipInstanceId);
    d.lingeringPoseCache.delete(shipInstanceId);
    const timer = d.ownerlessShips.get(shipInstanceId);
    if (timer !== undefined) {
      clearTimeout(timer);
      d.ownerlessShips.delete(shipInstanceId);
    }
    d.state.ships.delete(shipInstanceId);

    this.wreckConversions++;
    d.serverLogEvent('ship_abandoned', { playerId: ship.playerId, shipInstanceId, sectorKey: d.sectorKey(), lingering: true });
    d.logger.info({ playerId: ship.playerId, shipInstanceId, sectorKey: d.sectorKey() }, 'lingering hull abandoned → wreck');
  }

  /**
   * Phase 4 — drop a wreck and release its SAB slot. Called from
   * `applyDamage` when a wreck's health reaches 0, and from `onDispose`
   * so we don't leak slots on room teardown.
   */
  destroyWreck(shipInstanceId: string): void {
    const slot = this.wreckToSlot.get(shipInstanceId);
    if (slot !== undefined) {
      this.wreckToSlot.delete(shipInstanceId);
      this.slotToWreck.delete(slot);
      this.deps.freeSlots.push(slot);
      this.deps.postToWorker({ type: 'DESPAWN', slot, playerId: `wreck-${shipInstanceId}` });
    }
    this.deps.state.wrecks.delete(shipInstanceId);
    this.wreckPoseCache.delete(shipInstanceId);
  }
}
