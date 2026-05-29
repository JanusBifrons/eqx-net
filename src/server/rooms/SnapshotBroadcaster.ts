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

/** Narrow view of MissileSimulation the broadcaster uses. */
export interface MissileBroadcasterView {
  live(): IterableIterator<{
    id: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    angle: number;
    ownerId: string;
    weaponId: 'heat-seeker';
    ticksRemaining: number;
    weaponDef: { lifetimeTicks: number };
  }>;
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
  /** Missile simulation — per-recipient AOI-filtered missile pose slice. */
  missileSim: MissileBroadcasterView;
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

// ── Pooled per-recipient scratch shapes (plan: quirky-rabbit, Phase 5d).
// Inline-literal pre-fix; mutable-in-place post-fix. The wire shape is
// preserved because notepack.io encodes plain Objects synchronously
// inside `client.send()` and discards the reference; reusing the same
// instance across recipients does not corrupt prior sends. The fields
// are typed loose (`number/string`) so the helpers can assign without
// the readonly constraint at the wire-type level.

type MutableStateEntry = {
  x: number; y: number; vx: number; vy: number;
  angle: number; angvel: number;
  playerId: string;
  isActive: boolean;
  lastInput?: ShipInputBits;
  mountAngles?: number[];
};

type MutableProjectileEntry = {
  id: string; x: number; y: number; vx: number; vy: number;
  ownerId: string;
  weaponId: string;
};

type MutableMissileEntry = {
  id: number; x: number; y: number; vx: number; vy: number; angle: number;
  ownerId: string;
  weaponId: 'heat-seeker';
  lifePct: number;
};

type MutableDroneEntry = {
  id: number;
  mountAngles?: number[];
  shieldDown?: boolean;
};

type MutableWreckEntry = {
  id: string; x: number; y: number; vx: number; vy: number;
  angle: number; angvel: number;
};

/** Mutable view of the SnapshotMessage so we can poke optional fields
 *  in place. Cast back to `SnapshotMessage` at the `client.send` site. */
type MutableSnapshotMessage = {
  type: 'snapshot';
  serverTick: number;
  serverSendPerfNow?: number;
  wsBufferedAmountBytes?: number;
  states: SnapshotMessage['states'];
  ackedTick: number;
  boostingIds?: string[];
  thrustingIds?: string[];
  projectiles?: SnapshotMessage['projectiles'];
  missiles?: SnapshotMessage['missiles'];
  drones?: SnapshotMessage['drones'];
  wrecks?: SnapshotMessage['wrecks'];
};

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

  // ── Per-recipient scratch (Phase 5d).
  //
  // Pre-Phase-5d the per-recipient loop allocated:
  //   - `states: {}`                        — 1 per recipient
  //   - per-ship state literal              — N ships per recipient
  //   - mountAnglesArr `new Array(len)`     — per ship/drone with non-zero mounts
  //   - `projectiles[]`/`drones[]`/`wrecks[]` arrays — per recipient
  //   - per-projectile/drone/wreck literal  — per entity per recipient
  //   - `snap: {}` SnapshotMessage literal  — 1 per recipient (plus the
  //     spread-empty `...({} : {})` quirk that allocates extra empty
  //     literals for absent optional fields)
  //
  // Post-fix:
  //   - state-entry instances live in `_stateEntryPool` keyed by
  //     shipInstanceId, mutated in place. Sweep stale entries at the
  //     top of broadcast() via `_aliveShipInstanceIds`.
  //   - projectile/drone/wreck arrays + entry instances reuse the
  //     same slot-reuse pattern Phase 5b landed for WeaponMountTicker.
  //   - mountAngles arrays come from `_mountAnglesPool` keyed by length
  //     (a small finite set — mount counts 1..MAX_MOUNTS).
  //   - snap is a class-field `MutableSnapshotMessage` mutated per
  //     recipient and cast back to SnapshotMessage at send time. The
  //     spread-empty quirk goes away — optional fields are set to
  //     `undefined` when absent, which notepack.io's encoder skips.
  //
  // Wire safety: client.send synchronously msgpack-encodes the message
  // before returning (verified Phase 2). Reusing the same shapes
  // across recipients is wire-safe; the encoded buffer holds the bytes,
  // not the reference.
  private readonly _stateEntryPool = new Map<string, MutableStateEntry>();
  private readonly _aliveShipInstanceIds = new Set<string>();
  private readonly _projectilesScratch: MutableProjectileEntry[] = [];
  private readonly _missilesScratch: MutableMissileEntry[] = [];
  private readonly _dronesScratch: MutableDroneEntry[] = [];
  private readonly _wrecksScratch: MutableWreckEntry[] = [];
  private readonly _mountAnglesPool = new Map<number, number[]>();
  /** Fresh Record per recipient is unavoidable — notepack.io would
   *  encode stale keys from a reused Record into the wire. The VALUES
   *  inside are pooled via `_stateEntryPool` though, which is the
   *  larger cost. */
  private readonly _snapScratch: MutableSnapshotMessage = {
    type: 'snapshot',
    serverTick: 0,
    states: {},
    ackedTick: 0,
  };
  /** Map (not Record) so per-player set() is cheap and `.clear()`
   *  works in-place. Telemetry build converts to a fresh Record
   *  only when the snapshot_broadcast event actually fires (~7 Hz). */
  private readonly _ackedTicksMapScratch = new Map<string, number>();
  private readonly _boostingIdsScratch: string[] = [];
  private readonly _thrustingIdsScratch: string[] = [];

  constructor(private readonly deps: SnapshotBroadcasterDeps) {}

  // ── Slot-reuse helpers for the per-recipient pools (Phase 5d).

  /** Acquire-or-create the state-entry for a shipInstanceId. The
   *  instance is retained in `_stateEntryPool` across broadcasts and
   *  swept by `_aliveShipInstanceIds` membership at the top of
   *  broadcast(). */
  private acquireStateEntry(shipInstanceId: string): MutableStateEntry {
    let entry = this._stateEntryPool.get(shipInstanceId);
    if (!entry) {
      entry = {
        x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
        playerId: '', isActive: true,
      };
      this._stateEntryPool.set(shipInstanceId, entry);
    }
    return entry;
  }

  /** Acquire a number[] of the requested length from `_mountAnglesPool`.
   *  The same instance is reused across broadcasts; consumers must
   *  treat the array as ephemeral (good only until the next acquire
   *  for the same length). */
  private acquireMountAngles(len: number): number[] {
    let arr = this._mountAnglesPool.get(len);
    if (!arr) {
      arr = new Array<number>(len);
      this._mountAnglesPool.set(len, arr);
    }
    return arr;
  }

  /** Slot-reuse helpers for the per-entity arrays. Mirror the Phase 5b
   *  WeaponMountTicker.writeTargetSlot pattern. */
  private static writeProjectileSlot(
    arr: MutableProjectileEntry[], i: number,
    id: string, x: number, y: number, vx: number, vy: number,
    ownerId: string, weaponId: string,
  ): void {
    const slot = arr[i];
    if (!slot) {
      arr[i] = { id, x, y, vx, vy, ownerId, weaponId };
      return;
    }
    slot.id = id; slot.x = x; slot.y = y; slot.vx = vx; slot.vy = vy;
    slot.ownerId = ownerId; slot.weaponId = weaponId;
  }

  private static writeMissileSlot(
    arr: MutableMissileEntry[], i: number,
    id: number, x: number, y: number, vx: number, vy: number, angle: number,
    ownerId: string, weaponId: 'heat-seeker', lifePct: number,
  ): void {
    const slot = arr[i];
    if (!slot) {
      arr[i] = { id, x, y, vx, vy, angle, ownerId, weaponId, lifePct };
      return;
    }
    slot.id = id; slot.x = x; slot.y = y; slot.vx = vx; slot.vy = vy;
    slot.angle = angle; slot.ownerId = ownerId; slot.weaponId = weaponId;
    slot.lifePct = lifePct;
  }

  private static writeDroneSlot(
    arr: MutableDroneEntry[], i: number,
    id: number, mountAngles: number[] | undefined, shieldDown: boolean,
  ): void {
    const slot = arr[i];
    if (!slot) {
      arr[i] = shieldDown
        ? { id, mountAngles, shieldDown: true }
        : { id, mountAngles };
      return;
    }
    slot.id = id;
    // Always assign; undefined means "drop the field on the wire" via
    // notepack.io's encoder which skips undefined values.
    slot.mountAngles = mountAngles;
    if (shieldDown) slot.shieldDown = true;
    else delete slot.shieldDown;
  }

  private static writeWreckSlot(
    arr: MutableWreckEntry[], i: number,
    id: string, x: number, y: number, vx: number, vy: number,
    angle: number, angvel: number,
  ): void {
    const slot = arr[i];
    if (!slot) {
      arr[i] = { id, x, y, vx, vy, angle, angvel };
      return;
    }
    slot.id = id; slot.x = x; slot.y = y;
    slot.vx = vx; slot.vy = vy; slot.angle = angle; slot.angvel = angvel;
  }

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
    this._aliveShipInstanceIds.clear();
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
      this._aliveShipInstanceIds.add(entry.shipInstanceId);
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
      this._aliveShipInstanceIds.add(shipInstanceId);
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

      // Build per-recipient states map. The Record itself MUST be
      // freshly allocated (notepack.io would encode stale keys from a
      // reused Record). The VALUES inside are pooled in
      // `_stateEntryPool` keyed by shipInstanceId.
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
            mountAnglesArr = this.acquireMountAngles(angles.length);
            for (let i = 0; i < angles.length; i++) {
              mountAnglesArr[i] = Math.round(angles[i]! * 10_000) / 10_000;
            }
          }
        }
        const entry = this.acquireStateEntry(ship.shipInstanceId);
        entry.x = ship.pose.x;
        entry.y = ship.pose.y;
        entry.vx = ship.pose.vx;
        entry.vy = ship.pose.vy;
        entry.angle = ship.pose.angle;
        entry.angvel = ship.pose.angvel ?? 0;
        entry.playerId = ship.playerId;
        entry.isActive = ship.isActive;
        // Always assign — notepack.io's encoder skips undefined values,
        // so this is wire-equivalent to the legacy spread-when-truthy
        // pattern and avoids the per-ship `{ lastInput }` literal alloc.
        entry.lastInput = includeLastInput ? ship.lastInput : undefined;
        entry.mountAngles = mountAnglesArr;
        states[ship.shipInstanceId] = entry;
      }

      // Per-recipient projectiles in the 3×3 cell window. Slot-reuse
      // pattern: the array's slot instances persist across calls;
      // `arr.length = count` truncates the logical view.
      const projectilesScratch = this._projectilesScratch;
      let projectilesCount = 0;
      if (d.liveProjectiles.size > 0) {
        for (const [projId, proj] of d.liveProjectiles) {
          if (Math.abs(proj.x - recipientPose.x) > interestRadius) continue;
          if (Math.abs(proj.y - recipientPose.y) > interestRadius) continue;
          SnapshotBroadcaster.writeProjectileSlot(
            projectilesScratch, projectilesCount,
            projId, proj.x, proj.y, proj.vx, proj.vy,
            proj.ownerId, proj.weaponId,
          );
          projectilesCount++;
        }
      }
      projectilesScratch.length = projectilesCount;

      // Per-recipient missiles in the 3×3 cell window. Same AOI shape as
      // projectiles; missile lifecycle is server-authoritative (no client
      // prediction). The renderer interpolates between consecutive
      // snapshots and pads with the velocity vector for sub-tick smoothness.
      // Pooled scratch (Invariant #14) — mirrors Phase 5d projectile pattern.
      const missilesScratch = this._missilesScratch;
      let missilesCount = 0;
      for (const m of d.missileSim.live()) {
        if (Math.abs(m.x - recipientPose.x) > interestRadius) continue;
        if (Math.abs(m.y - recipientPose.y) > interestRadius) continue;
        const lifePct = m.weaponDef.lifetimeTicks > 0
          ? m.ticksRemaining / m.weaponDef.lifetimeTicks
          : 0;
        SnapshotBroadcaster.writeMissileSlot(
          missilesScratch, missilesCount,
          m.id, m.x, m.y, m.vx, m.vy, m.angle,
          m.ownerId, m.weaponId, lifePct > 0 ? lifePct : 0,
        );
        missilesCount++;
      }
      missilesScratch.length = missilesCount;

      // Slim per-drone turret + shield slice (drone-snapshot-interpolation
      // pivot, 2026-05-18). Drone POSE is on the binary swarm channel
      // only. For every drone in this recipient's 9-cell interest
      // window emit ONLY the non-pose fields: per-mount turret angles +
      // shield-down flag, AND only when there is something to carry.
      const dronesScratch = this._dronesScratch;
      let dronesCount = 0;
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
              droneMountAnglesArr = this.acquireMountAngles(droneAngles.length);
              for (let i = 0; i < droneAngles.length; i++) {
                droneMountAnglesArr[i] = Math.round(droneAngles[i]! * 10_000) / 10_000;
              }
            }
          }
          if (!droneMountAnglesArr && !rec.shieldDown) continue;
          SnapshotBroadcaster.writeDroneSlot(
            dronesScratch, dronesCount,
            eid, droneMountAnglesArr, rec.shieldDown ?? false,
          );
          dronesCount++;
        }
      }
      dronesScratch.length = dronesCount;

      const recipientAcked = this.sabAppliedTicks.get(recipientPlayerId) ?? 0;
      // Phase 4 — wreck poses for every wreck in the sector. No
      // interest filtering: wreck count per sector is bounded (one per
      // abandoned ship; players are 10-capped). Phase 5 can add
      // interest culling if rosters grow.
      const wrecksScratch = this._wrecksScratch;
      let wrecksCount = 0;
      if (d.wreckPoseCache.size > 0) {
        for (const [shipInstanceId, pose] of d.wreckPoseCache) {
          SnapshotBroadcaster.writeWreckSlot(
            wrecksScratch, wrecksCount,
            shipInstanceId, pose.x, pose.y, pose.vx, pose.vy,
            pose.angle, pose.angvel ?? 0,
          );
          wrecksCount++;
        }
      }
      wrecksScratch.length = wrecksCount;

      // Class-field SnapshotMessage scratch — mutated per recipient.
      // notepack.io's encoder skips undefined values, so the
      // conditional `field = cond ? value : undefined` lines below
      // produce a byte-identical wire shape to the legacy spread.
      const snap = this._snapScratch;
      snap.type = 'snapshot';
      snap.serverTick = serverTick;
      snap.states = states;
      snap.ackedTick = recipientAcked;
      snap.boostingIds = boostingIds.length > 0 ? boostingIds : undefined;
      snap.thrustingIds = thrustingIds.length > 0 ? thrustingIds : undefined;
      snap.projectiles = projectilesCount > 0 ? projectilesScratch : undefined;
      snap.missiles = missilesCount > 0 ? missilesScratch : undefined;
      snap.drones = dronesCount > 0 ? dronesScratch : undefined;
      snap.wrecks = wrecksCount > 0 ? wrecksScratch : undefined;
      // plan: imperative-taco-r2 — stamp server-send time so the client
      // can separate network in-transit delay from server-side silence
      // during recv_gap_long events. `performance.now()` is a primitive
      // number; notepack encodes it as 8 bytes. Zero per-tick alloc.
      snap.serverSendPerfNow = performance.now();
      // r2 evidence pass — read the underlying WebSocket bufferedAmount
      // BEFORE send and ship it ON the snapshot itself so the client's
      // diag stream captures the per-snapshot buffer state without
      // needing a separate channel back from the server. Non-zero
      // amount = laptop's WS layer is queueing (TCP send blocked or
      // slow); zero amount during a recv_gap_long = packets left the
      // laptop fine, buffering is downstream. Diagnostic for the
      // "router/AP vs phone WiFi modem" question raised after capture
      // 5vjj4e. Single integer; back-fills to 0 on the client read.
      const sockWithBuffer = (client as unknown as { socket?: { bufferedAmount?: number } }).socket;
      snap.wsBufferedAmountBytes = sockWithBuffer?.bufferedAmount ?? 0;
      client.send('snapshot', snap as SnapshotMessage);
      anySnapshotSent = true;
    }

    // Sweep state-entry pool — drop entries for shipInstanceIds that
    // are no longer alive this broadcast. Without this the pool grows
    // unbounded as players join + leave across the sector's lifetime.
    if (this._stateEntryPool.size > this._aliveShipInstanceIds.size) {
      for (const id of this._stateEntryPool.keys()) {
        if (!this._aliveShipInstanceIds.has(id)) this._stateEntryPool.delete(id);
      }
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
