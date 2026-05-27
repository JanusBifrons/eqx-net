/**
 * Per-client snapshot build + broadcast.
 *
 * Stage 5 (post-hotfix #4) — single 20 Hz cadence with per-client
 * phase-staggered offset hashed from playerId. Two recipients with
 * different offsets almost never fire on the same tick (smooths
 * server CPU spikes), but each individual recipient sees a clean
 * 50 ms interval at 20 Hz.
 *
 * Owns:
 *   - `broadcastCounter` — main-thread monotonic counter (NOT the
 *     SAB-read `serverTick`; the worker's tick can advance by 1, 2,
 *     or 3 between successive `update()` calls when the two 60 Hz
 *     loops drift, which caused ~25% missed broadcasts pre-Phase-3).
 *   - `sabAppliedTicks` — per-player worker-applied tick anchor (read
 *     by the per-recipient snapshot for `ackedTick`).
 *   - `lastInputCaches` — per-session caches that decide when to
 *     omit `lastInput` from the wire (idle-bits dedupe).
 *   - `interestScratch` — per-session 9-cell drone interest sets,
 *     reused by `update()`'s swarm-broadcast block.
 *
 * Builds the global "all alive ships" digest ONCE per tick, then loops
 * recipients (with backpressure + phase-offset gates) to per-client-
 * filter projectiles + drones + wrecks. The wire shape is exactly the
 * pre-extraction `SnapshotMessage`.
 *
 * Extracted from SectorRoom (commit 22 of v3 refactor plan; the 271-LOC
 * inline block).
 */

import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import {
  SLOT_FLAGS_OFF,
  FLAG_INPUT_THRUST,
  FLAG_INPUT_TURN_LEFT,
  FLAG_INPUT_TURN_RIGHT,
  FLAG_INPUT_BOOST,
  FLAG_INPUT_REVERSE,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { CELL_SIZE } from '../interest/SpatialGrid.js';
import {
  shouldBroadcastFar,
  shouldIncludeLastInput,
  createLastInputCache,
  type LastInputCache,
  type ShipInputBits,
} from '../net/snapshotScheduler.js';
import { checkBackpressure } from '../net/Backpressure.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { ProjectileRecord } from './ProjectilePipeline.js';

/** Subset of SwarmEntityRecord the drone slice reads. */
export interface SwarmDroneRec {
  id: string;
  kind: number;
  shieldDown?: boolean;
}

export interface SwarmLookupByEid {
  getByEntityId(entityId: number): SwarmDroneRec | null | undefined;
}

export interface SnapshotBroadcasterDeps {
  serverTick: () => number;
  sabU32: Uint32Array;
  clients: ClientArray<Client>;
  sessionToPlayer: Map<string, string>;
  playerToSlot: Map<string, number>;
  getActiveShip: (pid: string) => ShipState | undefined;
  shipPoseCache: Map<string, ShipPhysicsState>;
  lingeringSlots: Map<string, number>;
  lingeringPoseCache: Map<string, ShipPhysicsState>;
  shipsMap: MapSchema<ShipState>;
  wreckPoseCache: Map<string, ShipPhysicsState>;
  liveProjectiles: Map<string, ProjectileRecord>;
  boostingPlayers: Set<string>;
  thrustingPlayers: Set<string>;
  swarmRegistry: SwarmLookupByEid;
  playerMountAngles: Map<string, Float32Array>;
  droneMountAngles: Map<string, Float32Array>;
  logger: Logger;
  serverLogEvent: (tag: string, data: Record<string, unknown>) => void;
}

interface AllShipEntry {
  playerId: string;
  shipInstanceId: string;
  isActive: boolean;
  pose: ShipPhysicsState;
  lastInput: ShipInputBits;
}

export class SnapshotBroadcaster {
  /** Main-thread monotonic counter — incremented every `update()` call. */
  broadcastCounter = 0;
  /** Per-player worker-applied tick. Updated from the room's worker SAB read. */
  readonly sabAppliedTicks = new Map<string, number>();
  /** Per-session lastInput dedupe caches. */
  readonly lastInputCaches = new Map<string, LastInputCache>();
  /** Per-session 9-cell drone interest sets (populated by the room's
   *  swarm-broadcast block earlier in update()). */
  readonly interestScratch = new Map<string, Set<number>>();

  // === Per-broadcast scratch (plan: quirky-rabbit, Phase 2 — invariant
  // #14). Built ONCE before the per-recipient loop, referenced
  // (read-only) by every recipient's snap. Cleared/truncated at the
  // top of broadcast() so the next call starts from a known-empty
  // state. Class fields persist across broadcasts so the backing
  // buffers + AllShipEntry instances are reused — eliminates the
  // ~6 per-broadcast allocations the inline literals used to pay.
  //
  // SAFETY: the per-recipient loop only READS these scratches; it
  // never mutates them. The reference passed via `snap.boostingIds`
  // etc. is encoded synchronously by `client.send` (Colyseus 0.16
  // msgpack-encodes inline before returning), so the array's
  // contents are captured into the wire bytes before the next
  // broadcast can clear it.
  private readonly _allShipsScratch: AllShipEntry[] = [];
  private readonly _aliveIdsScratch = new Set<string>();
  /** Map (not Record) so per-player set() is cheap and `.clear()`
   *  works in-place. Telemetry build converts to a fresh Record
   *  only when the snapshot_broadcast event actually fires (~7 Hz). */
  private readonly _ackedTicksMapScratch = new Map<string, number>();
  private readonly _boostingIdsScratch: string[] = [];
  private readonly _thrustingIdsScratch: string[] = [];

  constructor(private readonly deps: SnapshotBroadcasterDeps) {}

  /** Acquire-or-create an `AllShipEntry` slot at `index`. Used by
   *  broadcast()'s logical-length-over-physical-slot pattern — the
   *  array's backing buffer + entry instances persist across calls;
   *  only the array's `.length` is truncated each broadcast. */
  private allShipEntryAt(index: number): AllShipEntry {
    let entry = this._allShipsScratch[index];
    if (!entry) {
      entry = {
        playerId: '',
        shipInstanceId: '',
        isActive: true,
        // Pose is overwritten below — initial reference is irrelevant
        // (any ShipPhysicsState shape will do; we never read these
        // initial zeros).
        pose: undefined as unknown as ShipPhysicsState,
        lastInput: { thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false },
      };
      this._allShipsScratch[index] = entry;
    }
    return entry;
  }

  /** Drop per-session caches on disconnect. */
  onClientLeave(sessionId: string): void {
    this.lastInputCaches.delete(sessionId);
    this.interestScratch.delete(sessionId);
  }

  /**
   * Build + send a snapshot to every alive client (filtered by
   * backpressure + per-client phase offset). No-op when sector is
   * idle. Increments `broadcastCounter` once per `update()` call —
   * caller passes `sectorIdle` so the counter still advances on idle
   * ticks (matches pre-extraction semantics).
   */
  broadcast(sectorIdle: boolean): void {
    const d = this.deps;
    this.broadcastCounter++;
    const serverTick = d.serverTick();
    if (serverTick <= 0 || sectorIdle) return;

    // Clear-and-reuse per-broadcast scratches (invariant #14).
    this._aliveIdsScratch.clear();
    this._ackedTicksMapScratch.clear();
    this._boostingIdsScratch.length = 0;
    this._thrustingIdsScratch.length = 0;
    const allShips = this._allShipsScratch;
    let allShipsCount = 0;

    for (const [playerId, slot] of d.playerToSlot) {
      const ship = d.getActiveShip(playerId);
      if (!ship || !ship.alive) continue;
      const pose = d.shipPoseCache.get(playerId);
      if (!pose) continue;
      const flags = d.sabU32[slotBase(slot) + SLOT_FLAGS_OFF] ?? 0;
      const entry = this.allShipEntryAt(allShipsCount);
      entry.playerId = playerId;
      entry.shipInstanceId = ship.shipInstanceId !== '' ? ship.shipInstanceId : playerId;
      entry.isActive = ship.isActive;
      entry.pose = pose;
      entry.lastInput.thrust    = !!(flags & FLAG_INPUT_THRUST);
      entry.lastInput.turnLeft  = !!(flags & FLAG_INPUT_TURN_LEFT);
      entry.lastInput.turnRight = !!(flags & FLAG_INPUT_TURN_RIGHT);
      entry.lastInput.boost     = !!(flags & FLAG_INPUT_BOOST);
      entry.lastInput.reverse   = !!(flags & FLAG_INPUT_REVERSE);
      allShipsCount++;
      this._aliveIdsScratch.add(playerId);
      this._ackedTicksMapScratch.set(playerId, this.sabAppliedTicks.get(playerId) ?? 0);
    }
    // Phase 6b — append lingering hulls. Pose from lingeringPoseCache;
    // owner from state.ships entry's playerId; isActive=false. lastInput
    // is all-false (the worker doesn't apply input to lingering hulls).
    for (const [shipInstanceId] of d.lingeringSlots) {
      const ship = d.shipsMap.get(shipInstanceId);
      if (!ship || !ship.alive) continue;
      const pose = d.lingeringPoseCache.get(shipInstanceId);
      if (!pose) continue;
      const entry = this.allShipEntryAt(allShipsCount);
      entry.playerId = ship.playerId;
      entry.shipInstanceId = shipInstanceId;
      entry.isActive = false;
      entry.pose = pose;
      entry.lastInput.thrust = false;
      entry.lastInput.turnLeft = false;
      entry.lastInput.turnRight = false;
      entry.lastInput.boost = false;
      entry.lastInput.reverse = false;
      allShipsCount++;
    }
    // Logical truncation — backing buffer + slot instances persist.
    allShips.length = allShipsCount;

    // Boosting/thrusting filter — small lists, sent in every snapshot.
    // Class-field scratches cleared at the top of broadcast().
    const boostingIds = this._boostingIdsScratch;
    for (const id of d.boostingPlayers) if (this._aliveIdsScratch.has(id)) boostingIds.push(id);
    const thrustingIds = this._thrustingIdsScratch;
    for (const id of d.thrustingPlayers) if (this._aliveIdsScratch.has(id)) thrustingIds.push(id);

    // 3×3 cell window radius for projectile interest.
    const interestRadius = CELL_SIZE * 1.5;
    let anySnapshotSent = false;

    for (const client of d.clients) {
      const bp = checkBackpressure(client, d.logger);
      if (bp === 'close') { client.leave(4002); continue; }
      if (bp === 'drop') continue;

      const recipientPlayerId = d.sessionToPlayer.get(client.sessionId);
      if (!recipientPlayerId) continue;

      // Stage 5 (post-hotfix #4) — single 20 Hz cadence with
      // per-client phase offset hashed from playerId.
      if (!shouldBroadcastFar(this.broadcastCounter, recipientPlayerId)) continue;

      const recipientPose = d.shipPoseCache.get(recipientPlayerId);
      if (!recipientPose) continue;

      let lastInputCache = this.lastInputCaches.get(client.sessionId);
      if (!lastInputCache) {
        lastInputCache = createLastInputCache();
        this.lastInputCaches.set(client.sessionId, lastInputCache);
      }

      // Build per-recipient states map.
      const states: SnapshotMessage['states'] = {};
      for (const ship of allShips) {
        const includeLastInput = shouldIncludeLastInput(lastInputCache, ship.playerId, ship.lastInput);
        const angles = d.playerMountAngles.get(ship.playerId);
        let mountAnglesArr: number[] | undefined;
        if (angles && angles.length > 0) {
          let anyNonZero = false;
          for (let i = 0; i < angles.length; i++) {
            if (angles[i] !== 0) { anyNonZero = true; break; }
          }
          if (anyNonZero) {
            mountAnglesArr = new Array<number>(angles.length);
            for (let i = 0; i < angles.length; i++) {
              mountAnglesArr[i] = Math.round(angles[i]! * 10_000) / 10_000;
            }
          }
        }
        states[ship.shipInstanceId] = {
          x: ship.pose.x, y: ship.pose.y, vx: ship.pose.vx, vy: ship.pose.vy,
          angle: ship.pose.angle, angvel: ship.pose.angvel ?? 0,
          playerId: ship.playerId,
          isActive: ship.isActive,
          ...(includeLastInput ? { lastInput: ship.lastInput } : {}),
          ...(mountAnglesArr ? { mountAngles: mountAnglesArr } : {}),
        };
      }

      // Per-recipient projectiles in the 3×3 cell window.
      let projectiles: SnapshotMessage['projectiles'];
      if (d.liveProjectiles.size > 0) {
        for (const [projId, proj] of d.liveProjectiles) {
          if (Math.abs(proj.x - recipientPose.x) > interestRadius) continue;
          if (Math.abs(proj.y - recipientPose.y) > interestRadius) continue;
          if (!projectiles) projectiles = [];
          projectiles.push({
            id: projId,
            x: proj.x, y: proj.y, vx: proj.vx, vy: proj.vy,
            ownerId: proj.ownerId,
            weaponId: proj.weaponId,
          });
        }
      }

      // Slim per-drone turret + shield slice (drone-snapshot-interpolation
      // pivot, 2026-05-18). Drone POSE is on the binary swarm channel
      // only. For every drone in this recipient's 9-cell interest
      // window emit ONLY the non-pose fields: per-mount turret angles +
      // shield-down flag, AND only when there is something to carry.
      let drones: SnapshotMessage['drones'];
      const interest = this.interestScratch.get(client.sessionId);
      if (interest && interest.size > 0) {
        for (const eid of interest) {
          const rec = d.swarmRegistry.getByEntityId(eid);
          if (!rec || rec.kind !== 1) continue;
          const droneAngles = d.droneMountAngles.get(rec.id);
          let droneMountAnglesArr: number[] | undefined;
          if (droneAngles && droneAngles.length > 0) {
            let anyNonZero = false;
            for (let i = 0; i < droneAngles.length; i++) {
              if (droneAngles[i] !== 0) { anyNonZero = true; break; }
            }
            if (anyNonZero) {
              droneMountAnglesArr = new Array<number>(droneAngles.length);
              for (let i = 0; i < droneAngles.length; i++) {
                droneMountAnglesArr[i] = Math.round(droneAngles[i]! * 10_000) / 10_000;
              }
            }
          }
          if (!droneMountAnglesArr && !rec.shieldDown) continue;
          if (!drones) drones = [];
          drones.push({
            id: eid,
            ...(droneMountAnglesArr ? { mountAngles: droneMountAnglesArr } : {}),
            ...(rec.shieldDown ? { shieldDown: true } : {}),
          });
        }
      }

      const recipientAcked = this.sabAppliedTicks.get(recipientPlayerId) ?? 0;
      // Phase 4 — wreck poses for every wreck in the sector. No
      // interest filtering: wreck count per sector is bounded (one per
      // abandoned ship; players are 10-capped). Phase 5 can add
      // interest culling if rosters grow.
      let wrecks: SnapshotMessage['wrecks'];
      if (d.wreckPoseCache.size > 0) {
        wrecks = [];
        for (const [shipInstanceId, pose] of d.wreckPoseCache) {
          wrecks.push({
            id: shipInstanceId,
            x: pose.x, y: pose.y,
            vx: pose.vx, vy: pose.vy,
            angle: pose.angle, angvel: pose.angvel ?? 0,
          });
        }
      }
      const snap: SnapshotMessage = {
        type: 'snapshot',
        serverTick,
        states,
        ackedTick: recipientAcked,
        ...(boostingIds.length > 0 ? { boostingIds } : {}),
        ...(thrustingIds.length > 0 ? { thrustingIds } : {}),
        ...(projectiles ? { projectiles } : {}),
        ...(drones ? { drones } : {}),
        ...(wrecks ? { wrecks } : {}),
      };
      client.send('snapshot', snap);
      anySnapshotSent = true;
    }

    // Snapshot-broadcast log: gate to ~20 Hz (every 3rd tick). Only
    // allocate the wire Records here — the .map + Object.fromEntries
    // chain in the pre-Phase-2 code allocated an intermediate Array,
    // N tuples, and N inner objects on EVERY broadcast even though
    // the event only fires every 3rd. Now they allocate at ~7 Hz, not
    // 20 Hz, and the .map intermediate is eliminated entirely via
    // direct loops into the Records.
    if (anySnapshotSent && this.broadcastCounter % 3 === 0) {
      const ackedTicks: Record<string, number> = {};
      for (const [pid, tick] of this._ackedTicksMapScratch) ackedTicks[pid] = tick;
      const telemetryStates: Record<string, { x: number; y: number; vx: number; vy: number }> = {};
      for (const s of allShips) {
        telemetryStates[s.playerId] = {
          x: parseFloat(s.pose.x.toFixed(3)),
          y: parseFloat(s.pose.y.toFixed(3)),
          vx: parseFloat(s.pose.vx.toFixed(3)),
          vy: parseFloat(s.pose.vy.toFixed(3)),
        };
      }
      d.serverLogEvent('snapshot_broadcast', {
        serverTick,
        playerCount: d.playerToSlot.size,
        ackedTicks,
        states: telemetryStates,
      });
    }
  }
}
