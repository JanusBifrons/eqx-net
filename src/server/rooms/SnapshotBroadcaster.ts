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
 * filter projectiles + drones. The wire shape is exactly the
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
import { getDroneMaxHealth } from './droneKindHelpers.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipState } from './schema/SectorState.js';
import type { ProjectileRecord } from './ProjectilePipeline.js';

/** Shared empty stat-allocation reference (Phase 4 WS-B2). A frozen singleton so
 *  the per-broadcast scratch initializer + every un-upgraded ship reuse ONE
 *  object (invariant #14 — no per-tick alloc); the real per-instance alloc is a
 *  reference to `ShipState.statAlloc`, replaced only on a discrete upgrade. */
const EMPTY_STAT_ALLOC: Readonly<Record<string, number>> = Object.freeze({});

/** The stat-pool ids (mirrors `STAT_IDS` in core/leveling/shipStats.ts; kept as a
 *  local literal so the broadcaster stays self-contained). Used to test
 *  emptiness WITHOUT `Object.keys` (which would allocate per snapshot — #14). */
const STAT_ALLOC_KEYS = ['hull', 'energy', 'damage', 'topSpeed', 'turnRate', 'shield'] as const;

/** True iff the allocation has at least one positive entry. Alloc-free
 *  (iterates the fixed-length key list, no `Object.keys` array). */
function hasAnyStatAlloc(alloc: Record<string, number>): boolean {
  for (let i = 0; i < STAT_ALLOC_KEYS.length; i++) {
    const v = alloc[STAT_ALLOC_KEYS[i]!];
    if (typeof v === 'number' && v > 0) return true;
  }
  return false;
}

/** Subset of SwarmEntityRecord the drone + asteroid slices read. */
export interface SwarmDroneRec {
  id: string;
  kind: number;
  shieldDown?: boolean;
  /** Ship-kind id — used to resolve max health for the `hp` percent (Part C). */
  shipKind?: string;
  /** WS-4 Phase 6 — asteroid (kind 0) finite mineable pool. Present once a rock
   *  has been mined; drives the slim `asteroids[]` slice (emit-when-mined). */
  resources?: number;
  resourcesMax?: number;
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
    /** Signed angular velocity (rad/s) — drives client curve-aware interp (WS-C #5). */
    angvel: number;
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
  liveProjectiles: Map<string, ProjectileRecord>;
  boostingPlayers: Set<string>;
  thrustingPlayers: Set<string>;
  swarmRegistry: SwarmLookupByEid;
  /** Drone hull health, keyed by swarm id — for the per-drone `hp` percent in
   *  the slice (Part C health-weighted player aim). */
  swarmHealth: Map<string, number>;
  playerMountAngles: Map<string, Float32Array>;
  droneMountAngles: Map<string, Float32Array>;
  /** Missile simulation — per-recipient AOI-filtered missile pose slice. */
  missileSim: MissileBroadcasterView;
  logger: Logger;
  serverLogEvent: (tag: string, data: Record<string, unknown>) => void;
  /**
   * Phase 1 of the swift-otter WebRTC plan — DI seam for per-recipient
   * snapshot delivery. When absent, the broadcaster falls back to the
   * legacy `client.send('snapshot', snap)` path. SectorRoom wires this
   * to `WebRtcChannelManager.sendSnapshot(...)` with WS fallback baked
   * in, so the broadcaster never has to know whether a given client is
   * on DataChannel or WebSocket.
   *
   * Hot-path contract: callback MUST NOT throw into the loop. The
   * broadcaster wraps each call in try/catch as a belt-and-braces
   * guard, but degraded routing is the manager's job.
   */
  sendSnapshot?: (client: Client, snap: SnapshotMessage) => void;
  /** Structures plan, Phase 3 — the cached structures slice (rebuilt at the
   *  1 Hz grid pulse, attached by reference). Undefined ⇒ no structures. */
  getStructuresSlice?: () => SnapshotMessage['structures'];
}

interface AllShipEntry {
  playerId: string;
  shipInstanceId: string;
  isActive: boolean;
  pose: ShipPhysicsState;
  lastInput: ShipInputBits;
  /** Current energy pool (weapons/energy/AI overhaul §3.2). Emitted on the
   *  wire ONLY for the recipient's own active ship. 0 for lingering hulls. */
  energy: number;
  /** WS-12 / R2.32 — shield down (hull exposed). Drives the client shield
   *  aura for both active AND lingering hulls. */
  shieldDown: boolean;
  /** Phase 4 (Leveling & XP, WS-B1) — this hull's PUBLIC level (≥ 1). Emitted
   *  on the wire only when > 1 (un-levelled sectors pay zero bytes). */
  level: number;
  /** Phase 4 (Leveling & XP, WS-B2) — this hull's per-instance spent stat
   *  allocation. A SHARED reference to `ShipState.statAlloc` (replaced only on a
   *  discrete upgrade — never per tick → invariant #14 safe). Emitted on the
   *  wire ONLY for the recipient's own ACTIVE ship AND only when non-empty. */
  statAlloc: StatAllocRef;
  /** Phase 4 (Dynamic weapon mounts, WS-B3) — this hull's ACTIVATED latent
   *  mounts. A SHARED reference to `ShipState.mounts` (replaced only on a
   *  discrete activation — never per tick → invariant #14 safe). PUBLIC: emitted
   *  for every ship (active + lingering) with ≥ 1 activated mount, so others see
   *  the extra turrets. The renderer looks up geometry by `(shipKind, slotId)`. */
  mounts: MountsRef;
}

/** Read-only reference shape for the per-instance stat allocation (mirrors
 *  `ShipState.statAlloc`). Carried by reference, never copied per tick. */
type StatAllocRef = Record<string, number>;

/** Read-only reference shape for the per-instance activated mounts (mirrors
 *  `ShipState.mounts`). Carried by reference, never copied per tick. */
type MountsRef = ReadonlyArray<{ slotId: string; weaponId: string }>;

/** Shared frozen empty mounts reference (WS-B3). Mirrors `EMPTY_STAT_ALLOC` —
 *  every un-upgraded ship reuses ONE array (invariant #14). */
const EMPTY_MOUNTS: MountsRef = Object.freeze([]);

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
  energy?: number;
  shieldDown?: boolean;
  level?: number;
  statAlloc?: Record<string, number>;
  // Typed mutable to match the wire `SnapshotMessage['states'][...].mounts`; the
  // value assigned is a SHARED reference to `ShipState.mounts` (the encoder
  // reads it synchronously and never mutates it).
  mounts?: { slotId: string; weaponId: string }[];
};

type MutableProjectileEntry = {
  id: string; x: number; y: number; vx: number; vy: number;
  ownerId: string;
  weaponId: string;
};

type MutableMissileEntry = {
  id: number; x: number; y: number; vx: number; vy: number; angle: number;
  angvel: number;
  ownerId: string;
  weaponId: 'heat-seeker';
  lifePct: number;
};

type MutableDroneEntry = {
  id: number;
  mountAngles?: number[];
  shieldDown?: boolean;
  hp?: number;
};

type MutableAsteroidEntry = {
  id: number;
  resources?: number;
  resourcesMax?: number;
  mass?: number;
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
  asteroids?: SnapshotMessage['asteroids'];
  structures?: SnapshotMessage['structures'];
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
  //   - `projectiles[]`/`drones[]` arrays   — per recipient
  //   - per-projectile/drone literal        — per entity per recipient
  //   - `snap: {}` SnapshotMessage literal  — 1 per recipient (plus the
  //     spread-empty `...({} : {})` quirk that allocates extra empty
  //     literals for absent optional fields)
  //
  // Post-fix:
  //   - state-entry instances live in `_stateEntryPool` keyed by
  //     shipInstanceId, mutated in place. Sweep stale entries at the
  //     top of broadcast() via `_aliveShipInstanceIds`.
  //   - projectile/drone arrays + entry instances reuse the
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
  private readonly _asteroidsScratch: MutableAsteroidEntry[] = [];
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

  /**
   * Pre-bound per-recipient send. Phase 1 of swift-otter: SectorRoom
   * supplies a WebRtcChannelManager-backed implementation; absence of
   * the dep keeps the pre-Phase-1 `client.send('snapshot', snap)` path.
   * Hoisted to a class field so the per-recipient hot loop pays for one
   * function-call indirection, not a per-tick `??` allocation check.
   */
  private readonly _sendSnapshotFn: (client: Client, snap: SnapshotMessage) => void;

  constructor(private readonly deps: SnapshotBroadcasterDeps) {
    this._sendSnapshotFn =
      deps.sendSnapshot ??
      ((client, snap) => { client.send('snapshot', snap); });
  }

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
    angvel: number, ownerId: string, weaponId: 'heat-seeker', lifePct: number,
  ): void {
    const slot = arr[i];
    if (!slot) {
      arr[i] = { id, x, y, vx, vy, angle, angvel, ownerId, weaponId, lifePct };
      return;
    }
    slot.id = id; slot.x = x; slot.y = y; slot.vx = vx; slot.vy = vy;
    slot.angle = angle; slot.angvel = angvel;
    slot.ownerId = ownerId; slot.weaponId = weaponId;
    slot.lifePct = lifePct;
  }

  private static writeDroneSlot(
    arr: MutableDroneEntry[], i: number,
    id: number, mountAngles: number[] | undefined, shieldDown: boolean,
    hp: number | undefined,
  ): void {
    const slot = arr[i];
    if (!slot) {
      const fresh: MutableDroneEntry = { id, mountAngles };
      if (shieldDown) fresh.shieldDown = true;
      if (hp !== undefined) fresh.hp = hp;
      arr[i] = fresh;
      return;
    }
    slot.id = id;
    // Always assign; undefined means "drop the field on the wire" via
    // notepack.io's encoder which skips undefined values.
    slot.mountAngles = mountAngles;
    if (shieldDown) slot.shieldDown = true;
    else delete slot.shieldDown;
    if (hp !== undefined) slot.hp = hp;
    else delete slot.hp;
  }

  /** WS-4 Phase 6 — write a MINED-asteroid resource slot (pooled, mutate-in-
   *  place, invariant #14). Mirrors `writeDroneSlot`: optional fields are
   *  cleared via `delete` on reuse so a prior occupant can't leak onto the
   *  wire. `mass` is carried but the loop omits it for now (reserved). */
  private static writeAsteroidSlot(
    arr: MutableAsteroidEntry[], i: number,
    id: number, resources: number | undefined, resourcesMax: number | undefined,
    mass: number | undefined,
  ): void {
    const slot = arr[i];
    if (!slot) {
      const fresh: MutableAsteroidEntry = { id };
      if (resources !== undefined) fresh.resources = resources;
      if (resourcesMax !== undefined) fresh.resourcesMax = resourcesMax;
      if (mass !== undefined) fresh.mass = mass;
      arr[i] = fresh;
      return;
    }
    slot.id = id;
    if (resources !== undefined) slot.resources = resources;
    else delete slot.resources;
    if (resourcesMax !== undefined) slot.resourcesMax = resourcesMax;
    else delete slot.resourcesMax;
    if (mass !== undefined) slot.mass = mass;
    else delete slot.mass;
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
        energy: 0,
        shieldDown: false,
        level: 1,
        statAlloc: EMPTY_STAT_ALLOC,
        mounts: EMPTY_MOUNTS,
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
      entry.energy = ship.energy;
      entry.shieldDown = ship.shield <= 0; // R2.32 — hull exposed → render aura off
      entry.level = ship.level; // Phase 4 WS-B1 — public level
      entry.statAlloc = ship.statAlloc ?? EMPTY_STAT_ALLOC; // WS-B2 — shared ref
      entry.mounts = ship.mounts ?? EMPTY_MOUNTS; // WS-B3 — public activated mounts
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
      entry.energy = 0;
      // R2.32 — a lingering hull keeps its at-disconnect shield state so a
      // parked hull whose shield was broken still renders hull-exposed.
      entry.shieldDown = ship.shield <= 0;
      entry.level = ship.level; // Phase 4 WS-B1 — public level (lingering hulls too)
      // Lingering hulls never carry statAlloc on the wire (it's own-active-only
      // below), but keep the scratch coherent.
      entry.statAlloc = ship.statAlloc ?? EMPTY_STAT_ALLOC;
      // WS-B3 — activated mounts ARE public for lingering hulls too (a parked
      // upgraded hull renders its extra turrets to observers).
      entry.mounts = ship.mounts ?? EMPTY_MOUNTS;
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
        // Energy: own ACTIVE ship only (the local player's predicted
        // resource). Always assign — undefined for every other ship and
        // every remote recipient (notepack skips undefined). Integer-
        // quantised. Reused pooled entry → must clear for non-owners.
        entry.energy = (ship.playerId === recipientPlayerId && ship.isActive)
          ? Math.round(ship.energy)
          : undefined;
        // R2.32 — emit shieldDown only when true (notepack skips undefined →
        // zero bytes for an undamaged sector); clear the pooled entry otherwise.
        entry.shieldDown = ship.shieldDown ? true : undefined;
        // Phase 4 WS-B1 — public level. Emit only when > 1 (notepack skips
        // undefined → zero bytes for an un-levelled sector; the client treats
        // absent as level 1). Clear the pooled entry otherwise.
        entry.level = ship.level > 1 ? ship.level : undefined;
        // Phase 4 WS-B2 — per-instance stat allocation. Like energy, emit on the
        // recipient's OWN ACTIVE ship only (the local player's predicted physics
        // multipliers re-anchor from this), AND only when non-empty (un-upgraded
        // ⇒ undefined ⇒ zero bytes; the client treats absent as no upgrade).
        // Shared reference — no per-tick alloc (invariant #14).
        const ownActive = ship.playerId === recipientPlayerId && ship.isActive;
        entry.statAlloc =
          ownActive && hasAnyStatAlloc(ship.statAlloc) ? ship.statAlloc : undefined;
        // WS-B3 — activated mounts are PUBLIC (every recipient, active +
        // lingering), emit-when-non-empty. Shared reference (no per-tick alloc,
        // #14); the renderer looks up geometry by (shipKind, slotId). Clear the
        // pooled entry for un-upgraded ships. The readonly→mutable cast is safe:
        // the encoder reads the array synchronously and never mutates it.
        entry.mounts = ship.mounts.length > 0
          ? (ship.mounts as { slotId: string; weaponId: string }[])
          : undefined;
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
          m.id, m.x, m.y, m.vx, m.vy, m.angle, m.angvel,
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
          // Hull health percent (Part C) — emitted only when DAMAGED so
          // undamaged drones add zero bytes (client treats absent as 100 %).
          let hpPct: number | undefined;
          const maxHp = getDroneMaxHealth(rec.shipKind);
          if (maxHp && maxHp > 0) {
            const cur = d.swarmHealth.get(rec.id);
            if (cur !== undefined && cur < maxHp) {
              let pct = Math.round((cur / maxHp) * 100);
              if (pct < 0) pct = 0;
              else if (pct > 99) pct = 99; // <100 by construction (cur < maxHp)
              hpPct = pct;
            }
          }
          if (!droneMountAnglesArr && !rec.shieldDown && hpPct === undefined) continue;
          SnapshotBroadcaster.writeDroneSlot(
            dronesScratch, dronesCount,
            eid, droneMountAnglesArr, rec.shieldDown ?? false, hpPct,
          );
          dronesCount++;
        }
      }
      dronesScratch.length = dronesCount;

      // WS-4 Phase 6 (R2.23 enabler) — slim resource slice for MINED asteroids
      // in this recipient's interest window. Reuses the SAME `interest` set the
      // drone loop just read (no second query). Emits ONLY rocks with
      // `resources < resourcesMax` (actively mined) so untouched sectors add
      // zero bytes — the emit-when-changed discipline mirroring `drones[].hp`.
      // Pooled scratch, mutate-in-place (invariant #14). NO wire-version bump
      // (JSON slice; pose stays on the binary channel).
      const asteroidsScratch = this._asteroidsScratch;
      let asteroidsCount = 0;
      if (interest && interest.size > 0) {
        for (const eid of interest) {
          const rec = d.swarmRegistry.getByEntityId(eid);
          if (!rec || rec.kind !== 0) continue; // kind 0 === asteroid
          if (rec.resources === undefined || rec.resourcesMax === undefined) continue;
          if (rec.resources >= rec.resourcesMax) continue; // full / untouched → omit
          SnapshotBroadcaster.writeAsteroidSlot(
            asteroidsScratch, asteroidsCount,
            eid, rec.resources, rec.resourcesMax, undefined, // mass reserved (see slice JSDoc)
          );
          asteroidsCount++;
        }
      }
      asteroidsScratch.length = asteroidsCount;

      const recipientAcked = this.sabAppliedTicks.get(recipientPlayerId) ?? 0;

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
      snap.asteroids = asteroidsCount > 0 ? asteroidsScratch : undefined;
      // Structures plan, Phase 3 — the same cached slice array (rebuilt at the
      // 1 Hz pulse, NOT per tick) is attached by reference to every recipient.
      // Undefined when no structures exist (zero cost).
      snap.structures = this.deps.getStructuresSlice?.();
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
      // Phase 1 swift-otter routing seam — _sendSnapshotFn is either the
      // legacy WS-send default or a WebRtcChannelManager-backed router
      // wired in by SectorRoom. Try/catch is a belt-and-braces guard so
      // an exception inside the routing decision (e.g. a malformed PC
      // closing mid-broadcast) doesn't crash the per-tick loop and skip
      // every subsequent recipient.
      try {
        this._sendSnapshotFn(client, snap as SnapshotMessage);
      } catch (err) {
        d.serverLogEvent('snapshot_send_error', {
          sessionId: client.sessionId,
          error: (err as Error).message,
        });
      }
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
