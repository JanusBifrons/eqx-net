import { Room, Client } from 'colyseus';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { aggregateRamming } from '../../core/combat/Ramming.js';
import { clampFireTick } from '../../core/combat/fireTemporal.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { bundleWorker } from '../workers/bundleWorker.js';
import { pino } from 'pino';
import { Bus } from '../../core/events/Bus.js';
import { SimulationClock } from '../../core/clock/SimulationClock.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { SectorState, ShipState, WreckState } from './schema/SectorState.js';
import { shouldHonourResumedCooldown } from './cooldownRestore.js';
import { SwarmEntityRegistry, type SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import { LoadShedder } from '../orchestration/LoadShedder.js';
import { SpatialGrid, CELL_SIZE } from '../interest/SpatialGrid.js';
import { BinarySwarmBroadcast } from '../net/BinarySwarmBroadcast.js';
import {
  shouldBroadcastFar,
  createIdleTracker,
  noteSectorEvent,
  isSectorIdle,
  createLastInputCache,
  shouldIncludeLastInput,
  type LastInputCache,
  type IdleTracker,
  type ShipInputBits,
} from '../net/snapshotScheduler.js';
import { SwarmSpawner, type AsteroidSpec } from '../spawn/SwarmSpawner.js';
import { type Vec2 } from '../../core/swarm/asteroidShape.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import { AiController } from '../../core/ai/AiController.js';
import { HostileDroneBehaviour } from '../../core/ai/HostileDroneBehaviour.js';
import {
  pickTarget,
  rotateMountToward,
  wrapPi,
  type MountTargetView,
} from '../../core/ai/WeaponMountController.js';
import type { AiPlayerView, AiEntity } from '../../core/contracts/IAiBehaviour.js';
import { assignPlayerId } from '../identity/PlayerIdentity.js';
import { InputMessageSchema, FireMessageSchema } from '../../shared-types/messages.js';
import type { WelcomeMessage, SnapshotMessage, HitAckMessage, DamageEvent, DestroyEvent, LaserFiredEvent, RespawnAckMessage, WarpInEvent, WarpOutEvent, ShieldEventMessage, BotAggroEvent } from '../../shared-types/messages.js';
import { DEFAULT_SHIP_KIND, getShipKind, isShipKindId, type ShipKind, type ShipKindId, type WeaponMount } from '../../shared-types/shipKinds.js';
import { applyLayeredDamage, regenStep, type ShieldHullState } from '../../core/combat/ShieldHull.js';
import { shipCollisionTriangles } from '../../core/geometry/triangulate.js';
import type { BotCarry } from '../livingworld/botTypes.js';

/** Resolve a (possibly missing) ship-kind id to the kind's max health, or
 *  null when the id is unknown. Drones use this on spawn so each kind has
 *  its own hull pool. */
function getDroneMaxHealth(kindId: string | undefined): number | null {
  if (!kindId) return null;
  return getShipKind(kindId).maxHealth;
}

/** Per-kind shield pool for a drone (0 when the kind id is unknown). */
function getDroneShieldMax(kindId: string | undefined): number {
  if (!kindId) return 0;
  return getShipKind(kindId).shieldMax;
}
import {
  SEQLOCK_IDX,
  TICK_IDX,
  WORKER_TICK_US_IDX,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  SLOT_APPLIED_TICK_OFF,
  SLOT_FLAGS_OFF,
  FLAG_INPUT_THRUST,
  FLAG_INPUT_TURN_LEFT,
  FLAG_INPUT_TURN_RIGHT,
  FLAG_INPUT_BOOST,
  FLAG_INPUT_REVERSE,
  slotBase,
  SAB_TOTAL_BYTES,
  MAX_ENTITIES,
} from '../../shared-types/sabLayout.js';
import { SnapshotRing } from '../lagcomp/SnapshotRing.js';
import { checkBackpressure } from '../net/Backpressure.js';
import { validateToken, getUser } from '../auth/AuthService.js';
import { recordGameJoin, recordGameLeave, recordKill, saveSnapshot } from '../stats/StatsService.js';
import { db } from '../db/Database.js';
import {
  CURRENT_SCHEMA_VERSION,
  SNAPSHOT_STALENESS_MS,
  parseSnapshot,
  type SectorSnapshotPayload,
} from './SectorSnapshot.js';
import { getLimboStore, getPlayerShipStore } from '../db/PersistenceWorker.js';
import { LIMBO_DISCONNECT_TTL_MS, type LimboPayload } from '../limbo/LimboStore.js';
import { RosterFullError } from '../playerShips/PlayerShipStore.js';
import { TransitOrchestrator } from '../transit/TransitOrchestrator.js';
import { setSession, clearSession } from '../transit/sessionRegistry.js';
import { EngageTransitSchema, CancelTransitSchema } from '../../shared-types/messages.js';
import {
  rayHitsSphere,
  rayHitsConvexPolygon,
  projectileSweepCircle,
  rayHitsShipPolygon,
  sweptSegmentHitsShipPolygon,
  HITSCAN_DAMAGE,
  HITSCAN_RANGE,
  WEAPON_COOLDOWN_TICKS,
  SHIP_COLLISION_RADIUS,
  SHIP_MAX_HEALTH,
} from '../../core/combat/Weapons.js';
import { getWeapon, isWeaponId } from '../../core/combat/WeaponCatalogue.js';
import type { WeaponId, HitscanWeaponDef, ProjectileWeaponDef } from '../../core/combat/WeaponCatalogue.js';

const logger = pino({
  name: 'SectorRoom',
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

const WORKER_TS_PATH = fileURLToPath(
  new URL('../../core/physics/worker.ts', import.meta.url),
);

const JoinOptionsSchema = z
  .object({
    playerId: z.string().nullable().optional(),
    authToken: z.string().optional(),
    spawnX: z.number().optional(),
    spawnY: z.number().optional(),
    /** Test-only initial hull override. Honoured only when the room has
     *  `testMode === true` (engineering rooms like `test-sector`). Lets
     *  E2E specs that just need "do they die when shot?" spawn with
     *  1 HP so the kill resolves in a single beam tick instead of
     *  fighting full 500 HP + shield. Ignored on galaxy rooms. */
    initialHull: z.number().int().min(1).optional(),
    /** Test-only initial shield override; same testMode gate. 0 lets the
     *  first beam hit hull immediately. */
    initialShield: z.number().int().min(0).optional(),
    /** Player-chosen ship kind id (e.g. 'scout' | 'fighter' | 'heavy').
     *  Validated against `isShipKindId` in `onJoin`; unknown / missing values
     *  fall back to `DEFAULT_SHIP_KIND`. Ignored on Limbo rebind paths so a
     *  bad-actor client cannot mid-session swap kind. */
    shipKind: z.string().optional(),
    /** Phase 3 multi-ship roster — the specific roster entry to spawn into.
     *  Validated against `getPlayerShipStore().get(shipId).playerId === playerId`
     *  in `onJoin`; unowned / missing ids fall through to the legacy
     *  Limbo-restore-or-fresh-spawn path. Present ⇒ hydrate from the named
     *  roster row's stored pose / kind / health; ignore Limbo for this join. */
    shipId: z.string().optional(),
    /** Phase 3 multi-ship roster — force fresh creation even when the
     *  player already has entries in their roster. Sent by the galaxy
     *  map's "spawn a new ship in this sector" flow (sector click →
     *  kind picker). Without this flag, the dual-write defaults to
     *  reusing the most-recent roster row, which would mean clicking a
     *  fresh sector silently resumed the player's old ship. */
    isNewShip: z.boolean().optional(),
  })
  .passthrough();

const MAX_INPUTS_PER_TICK = 3;
const LAG_COMP_WINDOW = 12;

/** Stage 5 — sector idle threshold. After this many ticks without any
 *  motion-above-epsilon or projectile-in-flight event, the room
 *  suppresses snapshot broadcasts entirely. 60 ticks = 1 second at
 *  60 Hz physics. */
const IDLE_THRESHOLD_TICKS = 60;

/** Ticks after ANY player join/spawn during which snapshot broadcasts
 *  are forced ON regardless of sector idle state. 300 ticks = 5 s at
 *  60 Hz.
 *
 *  Why: a player who joins a quiet sector (initial join, sector
 *  transit, reconnect) spawns stationary. With no motion the idle
 *  tracker never fires, so after `IDLE_THRESHOLD_TICKS` the broadcast
 *  loop short-circuits — and the freshly-joined client NEVER receives
 *  a snapshot to reconcile its prediction world against the real
 *  spawn pose. It free-runs its (stale, post-transit) prediction,
 *  renders the ship at the wrong place, and the moment the player
 *  moves the sector un-idles, the first snapshot lands, and the
 *  reconciler snaps the ship hundreds of units (the user-reported
 *  "warp in → stay still → move → teleport" bug, capture
 *  2026-05-15T20-35-04-862Z-0ibj77 showed an 803-unit correction
 *  after a 5.25 s snapshot blackout). The grace window guarantees the
 *  new client gets a steady snapshot stream long enough to reconcile;
 *  once reconciled a stationary ship's prediction matches the server
 *  so subsequent idle-suppression is harmless. 5 s also matches the
 *  client's `joinMinimumElapsed` curtain floor. */
const JOIN_BROADCAST_GRACE_TICKS = 300;

/** Stage 5 — motion epsilon. A ship is considered "moving" if its speed
 *  squared exceeds this. 0.05 u/s²  → ~0.22 u/s actual speed; below
 *  that the ship is essentially drifting to a stop and idle suppression
 *  is safe. Squared-comparison saves a sqrt per ship per tick. */
const IDLE_MOTION_EPSILON_SQ = 0.05;

/** Phase 1 AI safety net: drones that drift past this distance from
 *  origin (twice `SECTOR_PLAYABLE_HALF_EXTENT`) get teleported back
 *  in-bounds. Patrol behaviour normally keeps them inside the playable
 *  region — this is the "should never fire" guard for runaway pursuits
 *  and the long-session drift bug captured 2026-05-10 (drones at ~4 M
 *  units). Asteroids are unaffected. */
const DRONE_MAX_BOUNDS = 10000;

type WorkerCmd =
  | { type: 'SPAWN';          slot: number; playerId: string; x: number; y: number; kindId?: string }
  | { type: 'DESPAWN';        slot: number; playerId: string }
  | { type: 'REKEY_SHIP';     oldId: string; newId: string }
  | { type: 'INPUT';          slot: number; inputTick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean }
  | { type: 'SPAWN_OBSTACLE'; slot: number; obstacleId: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number; vertices?: ReadonlyArray<Vec2> }
  | { type: 'AI_INTENT';      slot: number; fx: number; fy: number; torque: number; setAngvel?: number }
  | { type: 'CLOCK_RATE';     rate: number }
  | { type: 'SET_POSITION';   entityId: string; x: number; y: number; angle: number; vx: number; vy: number; angvel: number }
  | { type: 'SET_HULL_EXPOSED'; id: string; exposed: boolean; kindId: string; tick: number };

/** Fixed asteroid roster for the multiplayer diagnostic. Deterministic so the
 *  initial swarm population matches between sessions. Spawned via SwarmSpawner
 *  in onCreate(), then shipped via the binary swarm broadcast — no longer on
 *  Colyseus MapSchema. Mass is omitted — the spawner applies
 *  `ASTEROID_DEFAULT_MASS`. Radii vary so silhouettes read as different. */
const ASTEROIDS: ReadonlyArray<AsteroidSpec> = [
  { id: 'asteroid-0', x:  200, y:    0, vx: 0,   vy: 0,    radius: 32 },
  { id: 'asteroid-1', x: -180, y:  120, vx: 0.3, vy: -0.2, radius: 22 },
  { id: 'asteroid-2', x:   80, y: -220, vx: 0,   vy: 0,    radius: 46 },
];

interface ProjectileRecord {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
  birthTick: number;
  damage: number;
  radius: number;
  maxTicks: number;
  weaponId: WeaponId;
}

export class SectorRoom extends Room<SectorState> {
  private physicsWorker!: Worker;
  private sab!: SharedArrayBuffer;
  private sabU32!: Uint32Array;
  private sabF32!: Float32Array;

  // Slot management — maps playerId ↔ integer SAB slot index.
  private playerToSlot = new Map<string, number>();
  private slotToPlayer = new Map<number, string>();
  private freeSlots: number[] = [];
  private initialSpawnPositions = new Map<string, { x: number; y: number }>();

  /** Phase 6a — `playerId → shipInstanceId` indirection. The schema map
   *  (`state.ships`) and the snapshot wire keys both use shipInstanceId
   *  in 6a. Inbound `input` / `fire` / `engage_transit` handlers receive
   *  a playerId (via `sessionToPlayer`) and translate through this map
   *  before looking up the per-ship surface. Internal slot / pose maps
   *  stay playerId-keyed in 6a (Option A) — the one-active-ship-per-
   *  player invariant still holds, so the 1:1 mapping is preserved.
   *  Phase 6b will rekey the slot maps when lingering hulls need
   *  multiple entries per player. */
  private readonly playerToActiveShipInstance = new Map<string, string>();

  /** Phase 6b — lingering hulls' SAB slots. When a player fresh-spawns
   *  while their previous ship is still in the linger window, that
   *  previous ship's slot moves here so the snapshot loop and physics
   *  bookkeeping continue to iterate it. The fresh ship occupies
   *  `playerToSlot[playerId]` while the lingering ship sits in this
   *  parallel map. Cleaned up by `evictOwnerlessShip` (15-min TTL)
   *  and by `convertShipToWreck` if a lingering hull is destroyed. */
  private readonly lingeringSlots = new Map<string, number>();
  /** Phase 6b — pose mirror for lingering hulls. Mirrors `shipPoseCache`
   *  but keyed by shipInstanceId. Updated once per `update()` from
   *  the SAB so the snapshot can include them. */
  private readonly lingeringPoseCache = new Map<string, ShipPhysicsState>();

  // Phase 4 — abandoned-ship hulls. When a player abandons their ship via
  // the roster panel, the SAB slot is repurposed (slot stays allocated,
  // ownership transfers from a player to a wreck). The physics worker
  // continues to step the slot, so wrecks drift on their final-frame
  // velocity, drag-decay over time, and collide with everything. Damage
  // resolves through the standard `applyDamage` path; health 0 frees the
  // slot back into `freeSlots` and removes the wreck.
  private wreckToSlot = new Map<string, number>();
  private slotToWreck = new Map<number, string>();
  /** Pose mirror for wrecks, parallel to `shipPoseCache`. Updated once
   *  per `update()` from the SAB. Keyed by shipInstanceId. */
  private wreckPoseCache = new Map<string, ShipPhysicsState>();
  /** Counter — increments on every poll-driven conversion so we know
   *  the abandon→wreck rail is firing. */
  private wreckConversions = 0;

  // Phase 5c: swarm entities (asteroids, drones) live in the same SAB slot
  // pool as ships, but their wire-side metadata (kind, radius, last-broadcast
  // pose, sleeping flag) is owned by the swarm registry and shipped via the
  // binary swarm channel — never on MapSchema.
  private readonly swarmRegistry = new SwarmEntityRegistry();
  private readonly swarmEncoder = new BinarySwarmBroadcast();
  /** Phase 5d: per-client interest grid. 2048-unit cells, 3×3 query window. */
  private readonly interestGrid = new SpatialGrid();
  /** Reused per-tick scratch sets so query9 doesn't allocate per call. */
  private readonly interestScratch = new Map<string, Set<number>>();
  private swarmSpawner!: SwarmSpawner;
  private aiController!: AiController;
  /** Reused per-tick view for the AI controller — avoids per-tick allocation. */
  private aiPlayerScratch: AiPlayerView[] = [];

  // ── Phase 4b.3 (multi-mount turret refactor, 2026-05-11) ────────────────
  /** Authoritative per-mount rotation angle (ship-relative, arc-local) for
   *  each alive player ship's active slot. Indexed by mount-order in the
   *  ship-kind catalogue. Computed each `update()` by the server-side
   *  WeaponMountController tick; consumed by `handleFire` for ray geometry
   *  and shipped per-recipient in `SnapshotMessage.states[id].mountAngles`
   *  so remote observers see the same turret rotation the firer's screen
   *  is drawing. */
  private readonly playerMountAngles = new Map<string, Float32Array>();
  /** Sticky target id per player slot, used by `pickTarget` to suppress
   *  oscillation. Cleared on `onLeave` and on death. */
  private readonly playerSlotTargets = new Map<string, string | null>();
  /** Reused per-tick drone candidate list passed to `pickTarget` for each
   *  player slot — avoids per-tick allocation. */
  private readonly mountTargetsScratch: MountTargetView[] = [];

  // ── Phase 4c (drone turret rotation, 2026-05-11) ────────────────────────
  /** Per-drone authoritative mount rotation angles. Indexed by drone id
   *  (`swarm-*`). Only drones whose ship-kind has rotating mounts get an
   *  entry; legacy single-mount drones (zero-arc 'forward' mount) skip
   *  the controller call entirely. Mirrors the player-side
   *  `playerMountAngles` map. Per-recipient snapshot emits these in the
   *  `drones[]` slice for in-interest drones so the client renders the
   *  same rotation the server is computing. */
  private readonly droneMountAngles = new Map<string, Float32Array>();
  /** Sticky target id per drone slot. Cleared on despawn. */
  private readonly droneSlotTargets = new Map<string, string | null>();
  /** Reused per-tick player candidate list for drone turret target picks. */
  private readonly droneMountTargetsScratch: MountTargetView[] = [];

  private bus!: Bus;
  /** Phase 6 — TiDi simulation clock. Owned by the room; the worker reads its
   *  rate via SAB. Named `simClock` to avoid colliding with Colyseus `Room.clock`
   *  (a `ClockTimer` instance for `setInterval` / `setTimeout` helpers). */
  private simClock!: SimulationClock;
  /** Phase 6 — second-lever load shedder. Drops far drones in batches when
   *  the simClock is at its floor and the budget is still overrun. */
  private shedder!: LoadShedder;
  /** Last clockRate value pushed to the worker, used to gate CLOCK_RATE postMessages
   *  to once per RAMP_PER_TICK step (≈ once per ~6 server ticks at most). */
  private lastSentClockRate = 1.0;
  private sessionToPlayer = new Map<string, string>();
  private playerToSession = new Map<string, string>();
  private inputCountThisTick = new Map<string, number>();
  /** PlayerIds currently holding shift-boost AND thrust. Surfaced on every
   *  snapshot so all clients can render an exhaust trail for that ship. */
  private readonly boostingPlayers = new Set<string>();
  /** PlayerIds currently holding thrust (regardless of boost). Surfaced on
   *  every snapshot so observers can see a baseline thrust flame whenever
   *  a ship is accelerating. Strict superset of `boostingPlayers`. */
  private readonly thrustingPlayers = new Set<string>();
  /** Last client input tick the physics worker confirmed it applied, read from SAB. */
  private sabAppliedTicks = new Map<string, number>();
  /** Per-tick mirror of player ship pose, sourced from SAB inside `update()`.
   *  Replaces the previous practice of mirroring pose into `ShipState` (a
   *  Colyseus schema) — that path was emitting a duplicate broadcast on top
   *  of the custom `SnapshotMessage`. The cache is the single in-memory
   *  source for snapshot construction, lag-comp recording, AI player view,
   *  collision math, and LoadShedder anchoring. Records are mutated in-place
   *  per tick to avoid GC churn. Entries are added on spawn/respawn and
   *  removed on player leave. */
  private readonly shipPoseCache = new Map<string, ShipPhysicsState>();
  private serverTick = 0;
  /** Pre-Stage-5: gated the 20 Hz broadcast — fired every 3 update() calls.
   *  Stage 5 replaces this with per-client {@link shouldBroadcastFar} /
   *  {@link shouldBroadcastClose} predicates. Field retained for the
   *  swarm broadcast (binary channel) which still uses the same 60 Hz
   *  cadence with no per-client phasing. */
  private broadcastCounter = 0;
  /** Stage 5 — per-recipient cache of the last lastInput bits sent for
   *  each ship, used by {@link shouldIncludeLastInput} to omit the
   *  field when the bits haven't changed. Keyed by Colyseus sessionId;
   *  cleared in onLeave. */
  private readonly lastInputCaches = new Map<string, LastInputCache>();
  /** Stage 5 — sector-wide idle tracker. Updated each update() with
   *  motion / projectile-in-flight signals; when isSectorIdle returns
   *  true, the snapshot broadcast block short-circuits entirely. */
  private readonly idleTracker: IdleTracker = createIdleTracker();
  /** Server tick until which snapshot broadcasts are forced ON,
   *  bypassing idle-suppression. Set on every player join/spawn — see
   *  `JOIN_BROADCAST_GRACE_TICKS`. */
  private forceBroadcastUntilTick = 0;
  private testMode = false;
  /** Phase 6 synthetic-load knob — extra ms of CPU burn per server update().
   *  Set via the `tickBurnMs` room option to push tick budget over the TiDi
   *  threshold deterministically (4000 real entities only consume ~1.5 ms,
   *  nowhere near the 14 ms `OVER_BUDGET_MS` threshold). */
  private tickBurnMs = 0;
  /** Phase 8 — stable galaxy-sector identity. Set via `roomOpts.sectorKey` for
   *  the 7 galaxy rooms; `null` for engineering rooms (test-sector, swarm-*).
   *  Persistence rows reference this, NOT `this.roomId`, so a sector's history
   *  survives Colyseus's autogenerated room id rotating across restarts. */
  private sectorKey: string | null = null;
  /** Engineering test rooms can pin a default spawn anchor (e.g. origin in
   *  `feel-test`). `null` means use the existing ±200 u random scatter.
   *  URL-param `spawnX`/`spawnY` overrides this — set in `feel-test` so a
   *  player joining without params still lands at the known anchor. */
  private defaultSpawnX: number | null = null;
  private defaultSpawnY: number | null = null;
  /** Phase 8 — counter for the 60-second snapshot cadence (galaxy sectors only). */
  private ticksSinceSnapshot = 0;
  /** Phase 8 sub-phase B — set when an in-flight transit has committed (Limbo
   *  entry written with destination sectorKey, seat reserved, ship about to
   *  leave). The subsequent `onLeave` checks this and skips its own Limbo
   *  put so the destination-keyed entry survives intact. Cleared in onLeave. */
  readonly playerToTransitInFlight = new Set<string>();
  /** Phase 8 sub-phase B — per-room transit driver, set in onCreate. */
  private transitOrchestrator: TransitOrchestrator | null = null;
  /** Phase 8 sub-phase B (lingering ships) — 15-min auto-evict timers for
   *  hulls whose owners have disconnected from a galaxy room but whose ships
   *  remain in the live simulation. The ship keeps its SAB slot, ShipState
   *  entry, and physics body; the worker continues stepping it (drag decays
   *  vx/vy/angvel, so it drifts to a stop). Reconnect within the TTL re-binds
   *  the new session to the existing ship (live pose, not the snapshot). On
   *  TTL expiry `evictOwnerlessShip` runs full cleanup.
   *
   *  Phase 6b cleanup (2026-05-13) — keyed by **shipInstanceId**, not
   *  playerId. The previous playerId keying had a sharp edge: when a player
   *  fresh-spawned WHILE having a lingering hull, the timer (still pointed at
   *  playerId) would fire against the player's NEW active hull. The fix was
   *  to cancel the timer at the fresh-spawn-displace point — but that left
   *  displaced lingering hulls with no auto-evict, leaking them until room
   *  dispose. Now keyed by the hull's stable shipInstanceId, so the displaced
   *  hull's timer keeps firing correctly whether or not the player has
   *  re-bound or fresh-spawned in the meantime. */
  private readonly ownerlessShips = new Map<string, ReturnType<typeof setTimeout>>();

  // Auth — maps playerId → userId (null for anonymous)
  private readonly playerToUser = new Map<string, string | null>();

  // Combat
  private readonly snapshotRing = new SnapshotRing();
  private readonly lastFireClientTick = new Map<string, number>();
  private readonly liveProjectiles = new Map<string, ProjectileRecord>();
  private projectileCounter = 0;
  /** Per-swarm-entity health. Drones are killable; asteroids are not present in this map. */
  private readonly swarmHealth = new Map<string, number>();
  /** Per-drone shield pool (mirrors swarmHealth; cleared together in
   *  evictSwarmEntity). Server-authoritative; not on the wire in Phase 3a
   *  (drone wire bit + collider swap = Phase 6). */
  private readonly swarmShield = new Map<string, number>();
  private readonly swarmShieldLastDmg = new Map<string, number>();

  // Tick-budget telemetry. Accumulated each `update()`; flushed every 60 ticks
  // (≈ 1 s wall-clock) to a single serverLogEvent so a diagnostic capture can
  // see the breakdown without saturating the 500-entry server-event buffer.
  private readonly tickBudgetSums: Record<string, number> = {
    sabRead: 0,
    projectiles: 0,
    swarmEncode: 0,
    swarmBroadcast: 0,
    snapshotBroadcast: 0,
    aiTick: 0,
    aiFire: 0,
    total: 0,
  };
  private tickBudgetSampleCount = 0;
  private tickBudgetMaxTotalMs = 0;
  private tickBudgetOverBudgetCount = 0;

  /** Per-tick phase breakdown for the CURRENT tick, written by `phaseTime`
   *  alongside the cumulative `tickBudgetSums`. Reset to zeros at end of
   *  each tick. Used by the hot-capture branch when `totalMs > TICK_HITCH_THRESHOLD_MS`
   *  to emit a `tick_hitch` event with the per-phase breakdown — answers
   *  the question `tick_budget` averages cannot: WHICH SUBSYSTEM ate the
   *  time on this specific tick. */
  private readonly thisTickPhases: Record<string, number> = {};
  /** 3-tick rolling history of (tick, totalMs, phases) for context around
   *  a hitch event. Push at end of every tick; trim to 3 entries. When a
   *  hitch fires, the event includes these as `recentTicks` so the
   *  consumer can see whether the hitch is isolated or part of a cluster. */
  private readonly tickHistoryRing: Array<{
    tick: number;
    totalMs: number;
    phases: Record<string, number>;
  }> = [];

  /** Hot-capture threshold for `tick_hitch` events. Any tick whose total
   *  wall-clock exceeds this fires a hitch event with phase breakdown.
   *  12 ms is below the 16.67 ms physics budget but well above the
   *  observed steady-state of ~1 ms — so it captures genuine hitches
   *  before they cascade into client-visible stutter (24+ ms ticks
   *  cause ~13 u correction snaps in the diagnostic capture). */
  private static readonly TICK_HITCH_THRESHOLD_MS = 12;
  /** Rate-limit hitch events to avoid flooding the server-event buffer
   *  during a sustained pathology. One per ~250 ms is plenty to reconstruct
   *  the cause; cluster events still get reported via the `recentTicks`
   *  context on the next admitted hitch. */
  private static readonly TICK_HITCH_MIN_INTERVAL_MS = 250;
  private lastTickHitchAtMs = 0;

  override async onCreate(options: unknown): Promise<void> {
    this.setState(new SectorState());
    this.bus = new Bus();
    this.simClock = new SimulationClock(this.bus);
    this.shedder = new LoadShedder({
      registry: this.swarmRegistry,
      getPlayers: () => this.alivePlayerPositions(),
      getPosition: (rec) => {
        const b = slotBase(rec.slot);
        return { x: this.sabF32[b + SLOT_X_OFF]!, y: this.sabF32[b + SLOT_Y_OFF]! };
      },
      evict: (rec) => this.evictSwarmEntity(rec, { broadcast: false, emitDestroyed: false }),
      bus: this.bus,
    });

    // Fill slot pool (push in reverse so slot 0 is popped first).
    for (let i = MAX_ENTITIES - 1; i >= 0; i--) this.freeSlots.push(i);

    // Shared memory buffer for zero-copy physics state transfer.
    this.sab    = new SharedArrayBuffer(SAB_TOTAL_BYTES);
    this.sabU32 = new Uint32Array(this.sab);
    this.sabF32 = new Float32Array(this.sab);

    await this.spawnWorker();

    // gameServer.define()'s 3rd arg flows into onCreate(options). test-sector
    // passes { testMode: true, asteroidConfig: [] } to run with no obstacles.
    const roomOpts = (options ?? {}) as {
      testMode?: boolean;
      asteroidConfig?: typeof ASTEROIDS;
      /** How many drones to seed at room start. 0 to skip. Defaults to 30 for non-test rooms. */
      droneCount?: number;
      /** Spawn-ring radius for the drone wave (legacy small-seed path —
       *  ignored when `swarmCount` is set). Defaults to 150 u so a player
       *  spawning at origin can engage immediately. Earlier the default was
       *  350 u, but smoke testing the network-feel roadmap repeatedly
       *  needed enemies in range without a long drive — this is the knob. */
      droneRadius?: number;
      /**
       * Phase 5e: bulk-seed N entities (asteroids + drones in `swarmRatio`
       * mix) instead of using `asteroidConfig` + `droneCount`. When set,
       * suppresses both legacy paths so we don't double-spawn.
       */
      swarmCount?: number;
      swarmRatio?: number; // asteroid fraction; default 0.8
      swarmRadius?: number; // spawn disc radius; default 18 000
      /** Deterministic ship-kind sequence for drone spawns. When set, each
       *  successive drone takes the next kind in this array (round-robin
       *  past the end). Used by engineering rooms (`mount-test`) that need
       *  a known mix of multi-mount drones for Phase 4c smoke testing.
       *  When undefined, the spawner falls back to uniform-random
       *  `pickRandomShipKind`. */
      droneKinds?: ShipKindId[];
      /**
       * Phase 5e sleep handshake test mode. Spawns exactly one stationary
       * asteroid at a known position so the test can observe its sleep
       * transition. Suppresses every other seed path.
       */
      singleAsteroid?: boolean;
      /**
       * Phase 6 — synthetic per-tick CPU burn (in ms) injected into the
       * server `update()`. Used to deterministically push the tick budget
       * past `OVER_BUDGET_MS` so the SimulationClock ramps to its 0.7×
       * floor without needing tens of thousands of entities (which would
       * crash the Rapier WASM pool). 0 / undefined = disabled.
       */
      tickBurnMs?: number;
      /**
       * Phase 8 — stable galaxy sector key (e.g. 'sol-prime'). Set for the
       * 7 galaxy rooms registered at boot from GALAXY_SECTORS; left undefined
       * for engineering rooms (test-sector, swarm-*) which have no persistent
       * identity. Drives persistence-row scoping, the `welcome.sectorKey`
       * field, and (sub-phase B) Limbo / transit eligibility.
       */
      sectorKey?: string;
      /**
       * Engineering test rooms (e.g. `feel-test`) want every player to spawn
       * at a known anchor, not the default ±200 u random scatter. When set,
       * these are used instead of the random fallback at `onJoin`. URL-param
       * `spawnX`/`spawnY` (in the join schema) still wins if a test client
       * passes them explicitly — so individual specs can override the room
       * default for adversarial scenarios.
       */
      defaultSpawnX?: number;
      defaultSpawnY?: number;
    };
    this.testMode = roomOpts.testMode ?? false;
    this.sectorKey = roomOpts.sectorKey ?? null;
    this.tickBurnMs = Math.max(0, Math.min(50, roomOpts.tickBurnMs ?? 0));
    this.defaultSpawnX = roomOpts.defaultSpawnX ?? null;
    this.defaultSpawnY = roomOpts.defaultSpawnY ?? null;

    // Phase 8 sub-phase B — galaxy rooms are permanent. Without this,
    // Colyseus's default `autoDispose: true` tears the room down the moment
    // the last client leaves: physics worker terminated, swarm registry
    // wiped, lingering ships destroyed. The next join lazy-creates a fresh
    // room with seed-position drones — observable as "drones reset every
    // time I log in." Engineering rooms keep the default (auto-dispose)
    // because their state is ephemeral by design.
    if (this.sectorKey !== null) {
      this.autoDispose = false;
    }
    if (this.tickBurnMs > 0) {
      logger.info({ tickBurnMs: this.tickBurnMs }, 'Phase 6 synthetic tick burn enabled — TiDi will ramp to floor');
    }
    const useBulkSeed = typeof roomOpts.swarmCount === 'number' && roomOpts.swarmCount > 0;
    const useSingleAsteroid = roomOpts.singleAsteroid === true;
    const asteroidRoster = (useBulkSeed || useSingleAsteroid) ? [] : (roomOpts.asteroidConfig ?? ASTEROIDS);

    // Phase 5c: seed swarm via the spawner, which owns slot allocation,
    // SAB priming, registry registration, and the worker spawn-obstacle
    // command. Asteroids and drones share the same physics body shape
    // (dynamic Rapier ball with damping=0); the AI behaviour determines
    // whether they drift passively or steer toward players.
    this.aiController = new AiController({
      postIntent: (slot, fx, fy, torque, setAngvel) => {
        this.postToWorker({
          type: 'AI_INTENT',
          slot, fx, fy, torque,
          ...(setAngvel !== undefined ? { setAngvel } : {}),
        });
      },
    });

    // Deterministic per-room ship-kind sequence. When `roomOpts.droneKinds`
    // is set, the spawner advances through this array round-robin instead
    // of pickRandomShipKind, so the `mount-test` engineering room can
    // guarantee a known mix of interceptor + gunship drones for Phase 4c
    // smoke testing.
    const kindSeq = roomOpts.droneKinds;
    let kindCursor = 0;
    const pickDroneKind = kindSeq && kindSeq.length > 0
      ? (): ShipKindId => {
          const k = kindSeq[kindCursor % kindSeq.length]!;
          kindCursor++;
          return k;
        }
      : undefined;
    this.swarmSpawner = new SwarmSpawner(this.swarmRegistry, {
      takeSlot: () => this.freeSlots.pop(),
      postSpawnObstacle: (slot, id, x, y, vx, vy, radius, mass, vertices) =>
        this.postToWorker({ type: 'SPAWN_OBSTACLE', slot, obstacleId: id, x, y, vx, vy, radius, mass, vertices }),
      sabF32: this.sabF32,
      sabU32: this.sabU32,
      registerAi: (id, slot, behaviour) => this.aiController.register(id, slot, behaviour),
      droneBehaviour: (kind) => new HostileDroneBehaviour(kind),
      interestGrid: this.interestGrid,
      registerLagComp: (id) => this.snapshotRing.registerEntity(id),
      ...(pickDroneKind ? { pickDroneKind } : {}),
    });
    const seeded = this.swarmSpawner.seedAsteroids(asteroidRoster);
    if (seeded < asteroidRoster.length) {
      logger.error({ requested: asteroidRoster.length, seeded }, 'swarm spawner: not all asteroids seeded (slot pool exhausted)');
    }

    if (useSingleAsteroid) {
      // Stationary asteroid 600 u from spawn — far enough that the worker's
      // sleep hysteresis (12 ticks at v ≈ 0) trips quickly without the
      // player accidentally bumping it. No drone, no AI behaviour wired.
      this.swarmSpawner.spawnAsteroid({ id: 'sleep-rock', x: 600, y: 0, vx: 0, vy: 0, radius: 24, mass: 1 });
      logger.info('Phase 5e single-asteroid sleep test seed');
    } else if (useBulkSeed) {
      // Phase 5e bulk seed. Replaces both the legacy ASTEROIDS list and the
      // small drone ring with a sunflower-spiral spread across a disc, sized
      // by `swarmCount`. Used by the bandwidth E2E and the dev-machine soak.
      const requested = roomOpts.swarmCount ?? 0;
      const bulk = this.swarmSpawner.seed(requested, roomOpts.swarmRatio, roomOpts.swarmRadius);
      if (bulk < requested) {
        logger.error({ requested, spawned: bulk }, 'bulk seed truncated (slot pool exhausted)');
      }
      // Per-drone health is sourced from the chosen ship-kind's `maxHealth`
      // — Heavy drones eat more hits than Scout drones, mirroring the player
      // matrix. Falls back to 40 for back-compat when the registry record
      // doesn't carry a kind (very old codepaths or test stubs).
      for (const rec of this.swarmRegistry.all()) {
        if (rec.kind === 1) {
          this.swarmHealth.set(rec.id, getDroneMaxHealth(rec.shipKind) ?? 40);
          this.swarmShield.set(rec.id, getDroneShieldMax(rec.shipKind));
          this.swarmShieldLastDmg.set(rec.id, this.serverTick);
        }
      }
      logger.info({ requested, spawned: bulk }, 'Phase 5e bulk seed');
    } else {
      // Seed a small drone wave for early manual testing. Drones ring the
      // spawn area at a configurable distance (default 150u) so the player
      // can engage them immediately for smoke testing without a long drive.
      // Bump `droneRadius` per-room for less-frantic scenarios.
      const droneCount = roomOpts.droneCount ?? (this.testMode ? 0 : 30);
      const droneRadius = roomOpts.droneRadius ?? 150;
      for (let i = 0; i < droneCount; i++) {
        const angle = (i / droneCount) * Math.PI * 2;
        const r = droneRadius;
        const id = `drone-${i}`;
        const ok = this.swarmSpawner.spawnDrone({ id, x: Math.cos(angle) * r, y: Math.sin(angle) * r });
        if (!ok) { logger.warn({ requested: droneCount, spawned: i }, 'drone wave truncated (slot pool full)'); break; }
        // Read the kind back from the registry record after spawn — the
        // spawner picks it randomly and stamps it onto the record.
        const rec = this.swarmRegistry.get(id);
        this.swarmHealth.set(id, getDroneMaxHealth(rec?.shipKind) ?? 40);
        this.swarmShield.set(id, getDroneShieldMax(rec?.shipKind));
        this.swarmShieldLastDmg.set(id, this.serverTick);
      }
    }

    // Phase 8 — hydrate from the most recent on-disk snapshot for this sector.
    // No-op for engineering rooms (sectorKey === null). Restores swarm health
    // only; positions are deterministic from the seed and are not persisted.
    if (this.sectorKey !== null) {
      this.hydrateFromSnapshot();
    }

    // Phase 8 sub-phase B — explicit 15s seat-reservation TTL for incoming
    // hyperspace travellers. Default is already 15 in Colyseus 0.16; making
    // it explicit guards against a future default change silently breaking
    // the contract.
    this.setSeatReservationTime(15);

    // Phase 8 sub-phase B — per-room transit driver. Engineering rooms get
    // an orchestrator too, but it'll always reject `engage_transit` because
    // sectorKey is null (the orchestrator validates and sends back DOCKED).
    //
    // Phase 5 — the orchestrator gets `PlayerShipStore` so it can validate
    // ownership when `engage_transit` carries a `shipId`. Without the store
    // a shipId-carrying request rejects as unknown, which is safe-by-default.
    this.transitOrchestrator = new TransitOrchestrator(
      this.asTransitHost(),
      getLimboStore(),
      undefined,
      getPlayerShipStore(),
    );

    this.onMessage('engage_transit', (client: Client, raw: unknown) => {
      const playerId = this.sessionToPlayer.get(client.sessionId);
      if (!playerId || !this.transitOrchestrator) return;
      const parsed = EngageTransitSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed engage_transit message');
        return;
      }
      this.transitOrchestrator.beginTransit(
        playerId,
        parsed.data.targetSectorKey,
        parsed.data.arrival,
        parsed.data.shipId,
      );
    });

    this.onMessage('cancel_transit', (client: Client, raw: unknown) => {
      const playerId = this.sessionToPlayer.get(client.sessionId);
      if (!playerId || !this.transitOrchestrator) return;
      const parsed = CancelTransitSchema.safeParse(raw);
      if (!parsed.success) return;
      this.transitOrchestrator.cancelTransit(playerId, 'manual');
    });

    this.onMessage('input', (client: Client, raw: unknown) => {
      const playerId = this.sessionToPlayer.get(client.sessionId);
      if (!playerId) return;

      const count = this.inputCountThisTick.get(playerId) ?? 0;
      if (count >= MAX_INPUTS_PER_TICK) return;
      this.inputCountThisTick.set(playerId, count + 1);

      const result = InputMessageSchema.safeParse(raw);
      if (!result.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed input message');
        return;
      }
      const { tick, thrust, turnLeft, turnRight } = result.data;
      const boost = result.data.boost ?? false;
      const reverse = result.data.reverse ?? false;
      const slot = this.playerToSlot.get(playerId);
      if (slot !== undefined) {
        this.postToWorker({ type: 'INPUT', slot, inputTick: tick, thrust, turnLeft, turnRight, boost, reverse });
      }
      // Track per-player boost state so the snapshot can broadcast it to all
      // observers for the visual exhaust trail. Only "active" while boosting
      // AND thrusting — shift alone doesn't visually do anything.
      if (boost && thrust) this.boostingPlayers.add(playerId);
      else this.boostingPlayers.delete(playerId);
      // Parallel track: any thrust at all gets a baseline flame. Superset of
      // `boostingPlayers` (boost ⇒ thrust). Renderer layers boost on top.
      if (thrust) this.thrustingPlayers.add(playerId);
      else this.thrustingPlayers.delete(playerId);
      // Diagnostic: log every 30th input plus any input whose claimed tick is
      // far from the current server tick (indicates clock drift). The delta
      // tells us how the client's tick numbering relates to the server's.
      const tickDelta = tick - this.serverTick;
      if ((tick % 30) === 0 || Math.abs(tickDelta) > 5) {
        serverLogEvent('input_received', {
          playerId,
          claimedTick: tick,
          serverTick: this.serverTick,
          tickDelta,
          thrust,
          turnLeft,
          turnRight,
        });
      }
    });

    this.onMessage('fire', (client: Client, raw: unknown) => {
      this.handleFire(client, raw);
    });

    this.onMessage('respawn', (client: Client) => {
      this.handleRespawn(client);
    });

    this.bus.on('SHIP_DESTROYED', (evt) => {
      // Phase 6b — `evt.targetId` has mixed semantics:
      //   - active-hull case (applyDamage line ~1553): a playerId (the
      //     applyDamage path looked up the ship via getActiveShip(playerId)).
      //   - lingering-hull case (applyDamage line ~1525): a shipInstanceId
      //     (looked up directly via state.ships.get).
      // Disambiguate by trying the active-hull lookup first; if it fails,
      // treat the target as a shipInstanceId.
      const activeHull = this.getActiveShip(evt.targetId);
      const destroyedShip = activeHull ?? this.state.ships.get(evt.targetId);
      const victimPlayerId = activeHull ? evt.targetId : destroyedShip?.playerId;

      const killerUser = this.playerToUser.get(evt.shooterId) ?? null;
      const victimUser = victimPlayerId !== undefined
        ? (this.playerToUser.get(victimPlayerId) ?? null)
        : null;
      recordKill(killerUser, victimUser, 'hitscan', this.sectorKey ?? this.roomId);
      // Phase 3 dual-write — drop the destroyed ship from the roster.
      if (destroyedShip !== undefined) {
        this.deleteRosterRow(destroyedShip.shipInstanceId);
      }
      // Phase 8 sub-phase B (lingering ships) — if a hull was destroyed
      // while ownerless (lingering or actively-disconnected-with-timer),
      // evict immediately. Skipping the 15-min wait keeps the room cleaner
      // and lets the player fresh-spawn from the galaxy map.
      // Phase 6b cleanup — ownerlessShips is shipInstanceId-keyed. Look up
      // by the destroyed ship's id, not by playerId.
      if (destroyedShip !== undefined && this.ownerlessShips.has(destroyedShip.shipInstanceId)) {
        this.evictOwnerlessShip(destroyedShip.shipInstanceId);
      }
    });

    // Hi-res tick loop. Colyseus's `setSimulationInterval` uses `setInterval`,
    // which on Windows quantises to the ~15.6 ms multimedia-clock granularity
    // and fires only ~32–46 times/sec instead of 60 (root cause of the May
    // 2026 mobile-corr capture's 46 Hz server rate). setImmediate has ~1 ms
    // granularity and lets us hit 60 Hz reliably across platforms.
    const TICK_MS_HR = 1000 / 60;
    let nextTickAt = performance.now();
    const loop = (): void => {
      if (this.simLoopStopped) return;
      const now = performance.now();
      if (now >= nextTickAt) {
        this.update();
        nextTickAt += TICK_MS_HR;
        // Catch-up cap: if we're more than 5 ticks behind (e.g. GC pause),
        // jump forward so we don't spiral.
        if (now > nextTickAt + 5 * TICK_MS_HR) nextTickAt = now + TICK_MS_HR;
      }
      setImmediate(loop);
    };
    loop();
    logger.info('SectorRoom created');
  }

  /** Set in onDispose() so the setImmediate loop exits cleanly. */
  private simLoopStopped = false;

  // ── Phase 6a — playerId → shipInstanceId indirection ──────────────────────

  /**
   * Translate a player id to the shipInstanceId of the hull THAT PLAYER
   * is currently piloting in THIS room. Returns `undefined` when the
   * player isn't bound (engineering room with no roster, fresh spawn
   * mid-flight, post-leave). Callers that hit this should treat undefined
   * as "no active ship" and bail out cleanly.
   *
   * NO `?? playerId` fallback — engineering rooms now generate a synthetic
   * shipInstanceId at join time, so a non-empty entry exists for every
   * bound player. Falling back to playerId would mask a real wiring bug
   * elsewhere.
   */
  private resolveActiveShipKey(playerId: string): string | undefined {
    return this.playerToActiveShipInstance.get(playerId);
  }

  /**
   * Phase 6b — convenience reader. Look up the active ShipState for a
   * given playerId. Internally translates playerId → shipInstanceId
   * via the indirection map and reads the schema. Returns `undefined`
   * for unknown players or players whose only hulls are lingering
   * (isActive=false). Use this everywhere a Phase 6a callsite did
   * `state.ships.get(playerId)`.
   */
  private getActiveShip(playerId: string): ShipState | undefined {
    const shipKey = this.resolveActiveShipKey(playerId);
    if (shipKey === undefined) return undefined;
    return this.state.ships.get(shipKey);
  }

  // ── Combat ──────────────────────────────────────────────────────────────

  /**
   * Resolve the firing slot's mount list for a given ship-kind.
   *
   * Phase 2a (mount-iteration refactor): every catalogue ship-kind now carries
   * `mounts` + `slots`. The fire path resolves the named slot (or the first
   * slot when no name is given — today's only path, since FireMessage doesn't
   * yet carry `slotId`) and returns its mount records in the slot's declared
   * order. Returns an empty array when the ship-kind has no mounts/slots
   * (defensive — every shipped kind has them, but a malformed catalogue
   * shouldn't crash the room).
   */
  private resolveSlotMounts(kind: ShipKind, slotId?: string): ReadonlyArray<WeaponMount> {
    const mounts = kind.mounts;
    const slots = kind.slots;
    if (!mounts || !slots || slots.length === 0) return [];
    const slot = slotId ? slots.find((s) => s.id === slotId) ?? slots[0]! : slots[0]!;
    const out: WeaponMount[] = [];
    for (const mid of slot.mountIds) {
      const m = mounts.find((mm) => mm.id === mid);
      if (m) out.push(m);
    }
    return out;
  }

  /**
   * Compute the per-mount world origin given a ship's pose and the mount's
   * ship-local offset. The ship's `angle` rotates the mount's local coords
   * into world space; the result is the world position of the mount's pivot
   * (before the 20 u / 16 u barrel offset applied by callers along the
   * mount's fire direction).
   */
  private mountWorldOrigin(
    shipX: number,
    shipY: number,
    shipAngle: number,
    mount: WeaponMount,
  ): { x: number; y: number } {
    const cosA = Math.cos(shipAngle);
    const sinA = Math.sin(shipAngle);
    return {
      x: shipX + (mount.localX * cosA - mount.localY * sinA),
      y: shipY + (mount.localX * sinA + mount.localY * cosA),
    };
  }

  /**
   * Phase 4b.3 — compute each alive player ship's per-mount rotation
   * angles for this tick and store them in `playerMountAngles`. Mirrors
   * the client's `ColyseusClient.tickLocalMountAim` so both sides
   * produce identical (lockstep) angles when given the same poses;
   * the server's output is authoritative, shipped through
   * `SnapshotMessage.states[id].mountAngles`, and used in
   * `handleFire` for ray geometry.
   *
   * Out-of-range drones (beyond `HITSCAN_RANGE`) are filtered by
   * `pickTarget`'s `maxDistance` option, so a ship with no target in
   * reach slews its mounts back to forward (the `target === null`
   * branch below).
   *
   * Drones don't run this path in 4b.3 — their mounts stay at
   * `baseAngle`. Phase 4c adds the same compute for drones with the
   * matching `SnapshotMessage.drones[].mountAngles` anchor.
   */
  private tickPlayerMounts(): void {
    if (this.playerToSlot.size === 0) return;
    const dtSec = 1 / 60;

    // Build the drone candidate list once per tick — same list re-used for
    // every player's pickTarget call.
    const targets = this.mountTargetsScratch;
    targets.length = 0;
    for (const rec of this.swarmRegistry.all()) {
      if (rec.kind !== 1) continue;
      const b = slotBase(rec.slot);
      targets.push({
        id: rec.id,
        x: this.sabF32[b + SLOT_X_OFF]!,
        y: this.sabF32[b + SLOT_Y_OFF]!,
        vx: this.sabF32[b + SLOT_VX_OFF]!,
        vy: this.sabF32[b + SLOT_VY_OFF]!,
      });
    }

    for (const [playerId] of this.playerToSlot) {
      const ship = this.getActiveShip(playerId);
      if (!ship?.alive) continue;
      const pose = this.shipPoseCache.get(playerId);
      if (!pose) continue;
      const kind = getShipKind(ship.kind);
      const mounts = this.resolveSlotMounts(kind);
      if (mounts.length === 0) continue;

      const prevTargetId = this.playerSlotTargets.get(playerId) ?? null;
      const target = pickTarget(pose.x, pose.y, targets, prevTargetId, () => true, {
        maxDistance: HITSCAN_RANGE,
      });
      this.playerSlotTargets.set(playerId, target?.id ?? null);

      let angles = this.playerMountAngles.get(playerId);
      if (!angles || angles.length !== mounts.length) {
        angles = new Float32Array(mounts.length);
        this.playerMountAngles.set(playerId, angles);
      }

      if (target === null) {
        // No target in range — slew every mount back to forward (0 in
        // arc-local frame). Matches user-requested behaviour: "return the
        // weapons to aiming forwards when an enemy ship is out of range".
        for (let i = 0; i < mounts.length; i++) {
          angles[i] = rotateMountToward(angles[i]!, 0, mounts[i]!, dtSec);
        }
        continue;
      }

      const cosA = Math.cos(pose.angle);
      const sinA = Math.sin(pose.angle);
      for (let i = 0; i < mounts.length; i++) {
        const mount = mounts[i]!;
        const mountWorldX = pose.x + (mount.localX * cosA - mount.localY * sinA);
        const mountWorldY = pose.y + (mount.localX * sinA + mount.localY * cosA);
        const dx = target.x - mountWorldX;
        const dy = target.y - mountWorldY;
        const worldBearing = Math.atan2(-dx, dy);
        const mountLocalBearing = wrapPi(worldBearing - pose.angle - mount.baseAngle);
        angles[i] = rotateMountToward(angles[i]!, mountLocalBearing, mount, dtSec);
      }
    }
  }

  /**
   * Phase 4c (2026-05-11) — drone turret rotation. Mirrors `tickPlayerMounts`
   * but iterates the swarm registry: each drone whose ship-kind has at
   * least one rotating mount runs `pickTarget` (with player ships as
   * candidates, filtered through the drone's `hostileTo` set), then slews
   * each mount toward the picked bearing via `rotateMountToward`. The
   * result is stored in `droneMountAngles` for `handleAiFire` to read and
   * for the snapshot serialisation to ship to clients.
   *
   * Drones whose kind has no rotating mounts (legacy fighter/scout/heavy
   * — single 'forward' mount with zero arc) are skipped entirely; their
   * `droneMountAngles` map entry is never allocated, saving both compute
   * and snapshot bytes (the wire field is omitted for empty arrays).
   *
   * Hostility model: same as the existing `HostileDroneBehaviour` — only
   * players the drone has been damaged by are in view. A drone with no
   * hostile players slews its mounts back toward 0 (forward).
   */
  private tickDroneMounts(): void {
    if (this.swarmRegistry.size() === 0) return;
    const dtSec = 1 / 60;

    // Build the player candidate list once per tick (shared across all
    // drones). Players are `shipPoseCache` rows for alive players.
    const targets = this.droneMountTargetsScratch;
    targets.length = 0;
    for (const [pid] of this.playerToSlot) {
      const ship = this.getActiveShip(pid);
      if (!ship?.alive) continue;
      const pose = this.shipPoseCache.get(pid);
      if (!pose) continue;
      targets.push({ id: pid, x: pose.x, y: pose.y, vx: pose.vx, vy: pose.vy });
    }

    for (const rec of this.swarmRegistry.all()) {
      if (rec.kind !== 1) continue; // asteroids: no turrets
      const kindId = rec.shipKind ?? DEFAULT_SHIP_KIND;
      const kind = getShipKind(kindId);
      const mounts = this.resolveSlotMounts(kind);
      // Skip drones whose mounts are all static — they have nothing to
      // slew. This is the common case (fighter/scout/heavy drones), so
      // the early bail is the hot path.
      let hasRotatingMount = false;
      for (const m of mounts) {
        if (m.rotationSpeed > 0 && m.arcMax > m.arcMin) {
          hasRotatingMount = true;
          break;
        }
      }
      if (!hasRotatingMount) {
        // Defensive cleanup if a drone's kind ever loses its rotation
        // (e.g. catalogue change mid-life — currently impossible).
        if (this.droneMountAngles.has(rec.id)) this.droneMountAngles.delete(rec.id);
        if (this.droneSlotTargets.has(rec.id)) this.droneSlotTargets.delete(rec.id);
        continue;
      }

      const b = slotBase(rec.slot);
      const droneX = this.sabF32[b + SLOT_X_OFF]!;
      const droneY = this.sabF32[b + SLOT_Y_OFF]!;
      const droneAngle = this.sabF32[b + SLOT_ANGLE_OFF]!;

      // Hostility filter — same source of truth as HostileDroneBehaviour.
      // The behaviour instance lives inside `AiController`; we query it
      // via the controller's accessor.
      const behaviour = this.aiController.getBehaviour(rec.id);
      const isHostile = (playerId: string): boolean => {
        if (!behaviour) return false;
        // `markHostile`/`purgeHostility` mutate the same set the drone
        // behaviour uses for combat targeting; mirror that here so the
        // turret AI and the body AI agree on who's a threat.
        const ho = (behaviour as unknown as { hostileTo?: Set<string> }).hostileTo;
        return ho ? ho.has(playerId) : false;
      };

      const prevTargetId = this.droneSlotTargets.get(rec.id) ?? null;
      const target = pickTarget(droneX, droneY, targets, prevTargetId, isHostile, {
        maxDistance: HITSCAN_RANGE,
      });
      this.droneSlotTargets.set(rec.id, target?.id ?? null);

      let angles = this.droneMountAngles.get(rec.id);
      if (!angles || angles.length !== mounts.length) {
        angles = new Float32Array(mounts.length);
        this.droneMountAngles.set(rec.id, angles);
      }

      if (target === null) {
        for (let i = 0; i < mounts.length; i++) {
          angles[i] = rotateMountToward(angles[i]!, 0, mounts[i]!, dtSec);
        }
        continue;
      }

      const cosA = Math.cos(droneAngle);
      const sinA = Math.sin(droneAngle);
      for (let i = 0; i < mounts.length; i++) {
        const mount = mounts[i]!;
        const mountWorldX = droneX + (mount.localX * cosA - mount.localY * sinA);
        const mountWorldY = droneY + (mount.localX * sinA + mount.localY * cosA);
        const dx = target.x - mountWorldX;
        const dy = target.y - mountWorldY;
        const worldBearing = Math.atan2(-dx, dy);
        const mountLocalBearing = wrapPi(worldBearing - droneAngle - mount.baseAngle);
        angles[i] = rotateMountToward(angles[i]!, mountLocalBearing, mount, dtSec);
      }
    }
  }

  private handleFire(client: Client, raw: unknown): void {
    const parsed = FireMessageSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ sessionId: client.sessionId }, 'malformed fire message');
      return;
    }
    const { tick, clientShotId, weapon, dirAngle, slotId } = parsed.data;

    const shooterId = this.sessionToPlayer.get(client.sessionId);
    if (!shooterId) return;

    const ship = this.getActiveShip(shooterId);
    if (!ship || !ship.alive) return;

    // Temporal resolution. We USED to hard-reject claims older than
    // LAG_COMP_WINDOW — that silently dropped ~37% of a laggy client's
    // shots: after a main-thread stall the wall-clock-anchored inputTick
    // falls behind serverTick and recovers slowly (capped catch-up), so a
    // long run of legitimate held-fires is timestamped stale (diagnostic
    // capture 2026-05-19T11-22-22-628Z-uf0o8g; the felt "shot rejected").
    // Instead CLAMP a stale claim to the window floor and resolve the
    // shot against the OLDEST available SnapshotRing pose. The rewind is
    // bounded identically to a legitimate edge-of-window claim
    // (≤ LAG_COMP_WINDOW), so there is no abuse advantage and no extra
    // rewind cost; the per-shooter cooldown below (raw client-tick
    // spacing) is the unchanged anti-rapid-fire guard. Future claims
    // (client running ahead — the steady state under this prediction
    // model) pass through untouched (getPoseAt(future) → live-pose
    // fallback, exactly as before).
    const effTick = clampFireTick(tick, this.serverTick, LAG_COMP_WINDOW);

    // Weapon cooldown rate limit. Compare client tick values (not serverTick) so
    // RTT jitter between consecutive messages doesn't cause false rejections.
    const lastFireCt = this.lastFireClientTick.get(shooterId) ?? -999;
    if (tick - lastFireCt < WEAPON_COOLDOWN_TICKS) {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false, rejected: true };
      client.send('hit_ack', ack);
      return;
    }
    this.lastFireClientTick.set(shooterId, tick);

    // Slim-fire payload (network-discipline P5): the client sends only
    // `dirAngle`. The ray origin is reconstructed from the shooter's
    // lag-compensated pose at `tick` plus the per-mount local offset (rotated
    // by the ship's authoritative angle at the fire tick) plus the standard
    // 20 u barrel offset along the mount's fire direction. SnapshotRing pose
    // is preferred (matches what the client predicted); shipPoseCache is the
    // fallback for ticks outside the lag-comp window (rare, since temporal
    // plausibility above already rejects anything beyond 12 ticks).
    const rewoundShooter = this.snapshotRing.getPoseAt(shooterId, effTick);
    const fallbackShooter = this.shipPoseCache.get(shooterId);
    const sx = rewoundShooter?.x ?? fallbackShooter?.x;
    const sy = rewoundShooter?.y ?? fallbackShooter?.y;
    if (sx === undefined || sy === undefined) return;
    const shooterVx = rewoundShooter?.vx ?? fallbackShooter?.vx ?? 0;
    const shooterVy = rewoundShooter?.vy ?? fallbackShooter?.vy ?? 0;
    // Ship orientation at fire-tick. Used to rotate each mount's ship-local
    // offset into world space. For legacy single-mount ships the offset is
    // (0, 0) so this value never matters; for Phase-3+ multi-mount ships it
    // determines wing/rear-turret world positions.
    const shipAngleAtFireTick = rewoundShooter?.angle ?? fallbackShooter?.angle ?? dirAngle;

    // Phase 2a: resolve the firing ship's mount list. Today every shipped
    // kind has exactly one mount in one slot — the loop below iterates once
    // and behaves identically to the pre-refactor single-fire path. The
    // structural plumbing is the deliverable.
    //
    // Phase 2b.1: `slotId` from FireMessage (optional) selects which slot's
    // mounts fire. `resolveSlotMounts` silently falls back to the first slot
    // when `slotId` is absent or doesn't resolve, so a pre-2b client (no
    // slotId field) is still served correctly.
    const shipKind = getShipKind(ship.kind);
    const slotMounts = this.resolveSlotMounts(shipKind, slotId);
    if (slotMounts.length === 0) {
      // Defensive: no mounts configured. Bail without hit_ack to mirror the
      // current behaviour of "shooter has no ship/kind" — the client's ghost
      // projectile will time out on its own.
      return;
    }

    // FireMessage.weapon is still authoritative in Phase 2a (legacy
    // 1/2/Q-driven weapon-select UI). Phase 2b drops the field and uses
    // each `mount.weaponId` instead. Until then, every mount in the slot
    // resolves to the same weapon — a no-op for legacy single-mount ships,
    // and the multi-mount kinds that land in Phase 3 still all use
    // 'hitscan' so the iteration is observably equivalent.
    const weaponId: WeaponId = isWeaponId(weapon) ? weapon : 'hitscan';
    const weaponDef = getWeapon(weaponId);

    // Per-mount fire result accumulator. The closest hit across all mounts
    // is what hit_ack reports (mirroring the legacy "one fire = one hit_ack"
    // contract); each mount's beam is broadcast independently so the client
    // can render every barrel's flash.
    let bestHitId: string | null = null;
    let bestHitDist = Infinity;
    let bestHitIsObstacle = false;
    let bestHitX = 0;
    let bestHitY = 0;
    // weapon-hit-prediction Phase 0 — the closest mount-hit's applied
    // damage, tracked in lockstep with `bestHitId` so the aggregate
    // `hit_ack` carries the exact value `applyDamage()` used for that
    // target. That is also what the imminent `DamageEvent` carries, which
    // lets the client de-dupe a confirmed prediction. Captured per-mount
    // (not from the loop-scoped `hitscanDef` after the loop) so it stays
    // correct for the Phase-2b multi-weapon future — today every mount in
    // a salvo shares one `weaponDef`, so this equals that single value.
    let bestHitDamage = 0;
    // weapon-hit-prediction Phase 3 — the closest mount-hit's WIRE id
    // (`wireTargetId`), tracked in lockstep with `bestHitId`. The internal
    // `bestHitId`/`mountHitId` for a swarm target is the registry key
    // (`swarm-drone-<i>` / `lwbot-<n>`), but `DamageEvent.targetId` and
    // `laser_fired.targetId` both use the dense wire id `swarm-<entityId>`
    // — which is also the only id space the client knows (its predWorld
    // drone bodies are keyed `swarm-<entityId>`). Acking the internal id
    // made the client's hitscan reconcile mis-compare EVERY drone hit as
    // `corrected`. The `hit_ack` must speak the same wire id as every
    // other client-facing combat message; `wireTargetId` already is that
    // id (it's what `laser_fired` broadcasts). Player / wreck / lingering
    // targets are unaffected (their `wireTargetId === mountHitId`).
    let bestHitWireId: string | undefined;

    const playerAngles = this.playerMountAngles.get(shooterId);
    for (let mIdx = 0; mIdx < slotMounts.length; mIdx++) {
      const mount = slotMounts[mIdx]!;
      const mountWorld = this.mountWorldOrigin(sx, sy, shipAngleAtFireTick, mount);
      // Per-mount fire direction. Phase 4b.3 (2026-05-11): the server now
      // computes per-mount rotation each tick (`tickPlayerMounts`) and
      // uses the authoritative angle here instead of trusting the
      // client's legacy `dirAngle`. Legacy single-mount ships have
      // mountAngles[i] = 0 (their mount has zero arc) so the fire
      // direction collapses to `dirAngle + mount.baseAngle = dirAngle`,
      // identical to the pre-rotation path. Multi-mount ships fire each
      // barrel along its server-authoritative slewed direction, so
      // lag-comp hit-tests and the laser_fired broadcast both reflect
      // the visible rotation.
      //
      // Note we still anchor the fire to `ship.angle@tickN` (read from
      // SnapshotRing) for the BODY orientation, then add the mount's
      // current angle on top — small mismatch under heavy lag since the
      // mountAngles snapshot we use is the CURRENT one, not the
      // tick-N one. A future MountAngleRing would close that gap; for
      // now the precision is bounded by RTT × rotationSpeed (50 ms × 4
      // rad/s ≈ 0.2 rad of rotation, well inside the aim tolerance for
      // anything not pixel-perfect).
      const currentMountAngle = playerAngles?.[mIdx] ?? 0;
      const mountFireAngle = shipAngleAtFireTick + mount.baseAngle + currentMountAngle;
      const ndx = -Math.sin(mountFireAngle);
      const ndy = Math.cos(mountFireAngle);
      const rayFromX = mountWorld.x + ndx * 20;
      const rayFromY = mountWorld.y + ndy * 20;

      serverLogEvent('fire_received', {
        shooterId,
        mountId: mount.id,
        clientTick: tick,
        serverTick: this.serverTick,
        tickDelta: this.serverTick - tick,
        // weapon-hit-prediction shot-rejected fix (capture uf0o8g): the
        // tick actually used for lag-comp rewind. When != clientTick the
        // claim was stale and got clamped to the window floor (resolved,
        // NOT dropped). Lets on-device captures confirm the fix.
        effTick,
        weapon,
        rewoundFromRing: rewoundShooter !== undefined,
        shooter: { x: parseFloat(sx.toFixed(3)), y: parseFloat(sy.toFixed(3)) },
        ray: {
          fromX: parseFloat(rayFromX.toFixed(3)),
          fromY: parseFloat(rayFromY.toFixed(3)),
          dirX: parseFloat(ndx.toFixed(4)),
          dirY: parseFloat(ndy.toFixed(4)),
        },
      });

      if (weaponDef.mode === 'projectile') {
        const projDef = weaponDef as ProjectileWeaponDef;
        this.spawnServerProjectile(
          shooterId,
          rayFromX,
          rayFromY,
          shooterVx + ndx * projDef.speed,
          shooterVy + ndy * projDef.speed,
          projDef.damage,
          projDef.radius,
          projDef.maxTicks,
          weaponId,
        );
        // No laser_fired broadcast for projectiles; the projectile is shipped
        // on the next snapshot's `projectiles[]` slice. Continue to next mount.
        continue;
      }

      // Hitscan: lag-comp check against rewound positions of all other ships
      // and swarm entities for this mount's ray.
      const hitscanDef = weaponDef as HitscanWeaponDef;
      let mountHitId: string | null = null;
      let mountHitDist = Infinity;
      let mountHitIsObstacle = false;

      for (const [targetId] of this.playerToSlot) {
        if (targetId === shooterId) continue;
        const targetShip = this.getActiveShip(targetId);
        if (!targetShip || !targetShip.alive) continue;
        const rewound = this.snapshotRing.getPoseAt(targetId, effTick);
        const fallback = this.shipPoseCache.get(targetId);
        const cx = rewound?.x ?? fallback?.x;
        const cy = rewound?.y ?? fallback?.y;
        if (cx === undefined || cy === undefined) continue;
        const dist = this.playerHitscanDist(targetShip, rayFromX, rayFromY, ndx, ndy, hitscanDef.range, cx, cy, rewound?.angle ?? fallback?.angle ?? 0);
        if (dist !== null && dist < mountHitDist) {
          mountHitDist = dist;
          mountHitId = targetId;
          mountHitIsObstacle = false;
        }
      }

      // Phase 6b — hitscan against lingering hulls. Targets the
      // shipInstanceId; applyDamage routes to the schema directly.
      // No lag-comp rewind (SnapshotRing isn't keyed by shipInstanceId);
      // we use the live pose mirror. Acceptable because lingering
      // hulls drift slowly (drag-decay), so the few-ms rewind delta
      // wouldn't change the hit decision meaningfully.
      for (const [shipInstanceId] of this.lingeringSlots) {
        const lingeringPose = this.lingeringPoseCache.get(shipInstanceId);
        if (!lingeringPose) continue;
        const dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, hitscanDef.range, lingeringPose.x, lingeringPose.y, SHIP_COLLISION_RADIUS);
        if (dist !== null && dist < mountHitDist) {
          mountHitDist = dist;
          mountHitId = shipInstanceId;
          mountHitIsObstacle = false;
        }
      }

      for (const rec of this.swarmRegistry.all()) {
        const rewound = this.snapshotRing.getPoseAt(rec.id, effTick);
        const b = slotBase(rec.slot);
        const cx = rewound?.x ?? this.sabF32[b + SLOT_X_OFF]!;
        const cy = rewound?.y ?? this.sabF32[b + SLOT_Y_OFF]!;
        const ca = rewound?.angle ?? this.sabF32[b + SLOT_ANGLE_OFF]!;
        let dist: number | null;
        if (rec.kind === 0 && rec.vertices) {
          dist = rayHitsConvexPolygon(rayFromX, rayFromY, ndx, ndy, hitscanDef.range, cx, cy, ca, rec.vertices);
        } else {
          dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, hitscanDef.range, cx, cy, rec.radius);
        }
        if (dist !== null && dist < mountHitDist) {
          mountHitDist = dist;
          mountHitId = rec.id;
          mountHitIsObstacle = true;
        }
      }

      // Phase 4 — wrecks are sphere-shootable. Same SHIP_COLLISION_RADIUS
      // as live ships since their hull occupies the same shape. Targeted
      // via `wreck-<shipInstanceId>` on the wire so `applyDamage` can
      // route to `state.wrecks`.
      for (const [shipInstanceId, slot] of this.wreckToSlot) {
        const b = slotBase(slot);
        const cx = this.sabF32[b + SLOT_X_OFF]!;
        const cy = this.sabF32[b + SLOT_Y_OFF]!;
        const dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, hitscanDef.range, cx, cy, SHIP_COLLISION_RADIUS);
        if (dist !== null && dist < mountHitDist) {
          mountHitDist = dist;
          mountHitId = `wreck-${shipInstanceId}`;
          mountHitIsObstacle = false;
        }
      }

      // Resolve wire target id for the laser_fired broadcast (swarm hits use
      // the 'swarm-${entityId}' wire convention).
      let wireTargetId: string | undefined = mountHitId ?? undefined;
      if (mountHitId && mountHitIsObstacle) {
        const rec = this.swarmRegistry.get(mountHitId);
        if (rec) wireTargetId = `swarm-${rec.entityId}`;
      }

      if (mountHitId) {
        if (Math.random() < 0.01) {
          logger.info({ shooterId, mountId: mount.id, hitId: mountHitId, hitIsObstacle: mountHitIsObstacle }, 'LASER_FIRED (1% sample)');
        }
        const hitX = rayFromX + ndx * mountHitDist;
        const hitY = rayFromY + ndy * mountHitDist;
        this.applyDamage(mountHitId, shooterId, hitscanDef.damage, hitX, hitY);
        // Track best (closest) hit across mounts for the aggregate hit_ack.
        if (mountHitDist < bestHitDist) {
          bestHitDist = mountHitDist;
          bestHitId = mountHitId;
          bestHitIsObstacle = mountHitIsObstacle;
          bestHitX = hitX;
          bestHitY = hitY;
          bestHitDamage = hitscanDef.damage;
          // wire id (== mountHitId for player/wreck/lingering; the dense
          // `swarm-<entityId>` for drones/asteroids) — see the bestHitWireId
          // declaration. This is what every other client-facing combat
          // message already uses, so the client's hit-prediction reconcile
          // compares like-for-like.
          bestHitWireId = wireTargetId;
        }
      }

      const beamEndX = rayFromX + ndx * (mountHitDist === Infinity ? hitscanDef.range : mountHitDist);
      const beamEndY = rayFromY + ndy * (mountHitDist === Infinity ? hitscanDef.range : mountHitDist);
      this.broadcast('laser_fired', {
        type: 'laser_fired',
        shooterId,
        mountId: mount.id,
        fromX: rayFromX,
        fromY: rayFromY,
        toX: beamEndX,
        toY: beamEndY,
        hit: !!mountHitId,
        targetId: wireTargetId,
      } satisfies LaserFiredEvent);
    }

    // Aggregate hit_ack: any mount hit → hit:true with the closest target.
    // For projectile fires no mount produces a synchronous hit, so the
    // ack is always { hit:false } in that case — matching the pre-refactor
    // contract where projectile fires acked false and the client's ghost
    // resolved later via the snapshot's `projectiles[]` slice.
    void bestHitX; void bestHitY; void bestHitIsObstacle; // reserved for future hit-pos in hit_ack
    if (bestHitId) {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: true, targetId: bestHitWireId, damage: bestHitDamage };
      client.send('hit_ack', ack);
    } else {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false };
      client.send('hit_ack', ack);
    }
  }

  /**
   * Build a read-only AiEntity snapshot for the given swarm id by reading SAB.
   * Used by AiController to feed live poses to behaviours each tick.
   */
  private swarmEntitySnapshot(id: string): AiEntity | null {
    const rec = this.swarmRegistry.get(id);
    if (!rec) return null;
    const b = slotBase(rec.slot);
    return {
      id,
      x: this.sabF32[b + SLOT_X_OFF]!,
      y: this.sabF32[b + SLOT_Y_OFF]!,
      vx: this.sabF32[b + SLOT_VX_OFF]!,
      vy: this.sabF32[b + SLOT_VY_OFF]!,
      angle: this.sabF32[b + SLOT_ANGLE_OFF]!,
      angvel: this.sabF32[b + SLOT_ANGVEL_OFF]!,
    };
  }

  /**
   * AI fire path. Mirrors the player hitscan logic but skips the message
   * parser, the per-session hit_ack, and the temporal-plausibility window
   * (AI fires at the current tick by definition). Cooldown is enforced via
   * the same `lastFireClientTick` map keyed by AI shooter id.
   *
   * Phase 5e will refactor handleFire to share the hit-resolution + damage +
   * broadcast tail with this method, eliminating the duplication. For 5c+
   * preview the duplication is contained to this single method.
   */
  private handleAiFire(shooterId: string, dirX: number, dirY: number, tick: number): void {
    const lastFireCt = this.lastFireClientTick.get(shooterId) ?? -999;
    if (tick - lastFireCt < WEAPON_COOLDOWN_TICKS) return;
    this.lastFireClientTick.set(shooterId, tick);

    const len = Math.hypot(dirX, dirY);
    if (len < 0.001) return;
    const dirNdx = dirX / len;
    const dirNdy = dirY / len;

    // Drone fires from its own pose, offset 16u along the firing direction so
    // it doesn't self-hit on the next-tick ray. Phase 2a: iterate mounts in
    // the drone's primary slot — for legacy single-mount drones this loops
    // once and produces identical behaviour to the pre-refactor path.
    const self = this.swarmEntitySnapshot(shooterId);
    if (!self) return;
    const shooterRec = this.swarmRegistry.get(shooterId);
    const droneKindId = shooterRec?.shipKind ?? DEFAULT_SHIP_KIND;
    const droneKind = getShipKind(droneKindId);
    const slotMounts = this.resolveSlotMounts(droneKind);
    if (slotMounts.length === 0) return;

    // The fire direction the AI computed (`dirX, dirY`) is the drone's body
    // intent. Re-express as an angle so mount.baseAngle can be added per
    // mount (mirroring the player path's `dirAngle + mount.baseAngle`).
    // Phase 4c: for drones with rotating mounts, also add the per-mount
    // slewed angle from `droneMountAngles` so hits land where the visible
    // barrel points (and so the broadcast `laser_fired` carries the same
    // direction observers see the turret aimed at). Legacy single-mount
    // drones have `droneMountAngles` un-entry → currentMountAngle = 0,
    // preserving the pre-4c behaviour bit-for-bit.
    const fireAngle = Math.atan2(-dirNdx, dirNdy);
    const wireShooterId = shooterRec ? `swarm-${shooterRec.entityId}` : shooterId;
    const droneAngles = this.droneMountAngles.get(shooterId);

    for (let mIdx = 0; mIdx < slotMounts.length; mIdx++) {
      const mount = slotMounts[mIdx]!;
      const mountWorld = this.mountWorldOrigin(self.x, self.y, self.angle, mount);
      const currentMountAngle = droneAngles?.[mIdx] ?? 0;
      const mountFireAngle = fireAngle + mount.baseAngle + currentMountAngle;
      const ndx = -Math.sin(mountFireAngle);
      const ndy = Math.cos(mountFireAngle);
      const rayFromX = mountWorld.x + ndx * 16;
      const rayFromY = mountWorld.y + ndy * 16;

      let hitId: string | null = null;
      let hitDist = Infinity;
      for (const [targetId] of this.playerToSlot) {
        const targetShip = this.getActiveShip(targetId);
        if (!targetShip || !targetShip.alive) continue;
        const pose = this.shipPoseCache.get(targetId);
        if (!pose) continue;
        const dist = this.playerHitscanDist(targetShip, rayFromX, rayFromY, ndx, ndy, HITSCAN_RANGE, pose.x, pose.y, pose.angle);
        if (dist !== null && dist < hitDist) {
          hitDist = dist;
          hitId = targetId;
        }
      }

      if (hitId) {
        this.applyDamage(hitId, shooterId, HITSCAN_DAMAGE);
      }

      const beamEndX = rayFromX + ndx * (hitDist === Infinity ? HITSCAN_RANGE : hitDist);
      const beamEndY = rayFromY + ndy * (hitDist === Infinity ? HITSCAN_RANGE : hitDist);

      this.broadcast('laser_fired', {
        type: 'laser_fired',
        shooterId: wireShooterId,
        mountId: mount.id,
        fromX: rayFromX,
        fromY: rayFromY,
        toX: beamEndX,
        toY: beamEndY,
        hit: !!hitId,
        targetId: hitId ?? undefined,
      } satisfies LaserFiredEvent);
    }
  }

  private spawnServerProjectile(ownerId: string, x: number, y: number, vx: number, vy: number, damage: number, radius: number, maxTicks: number, weaponId: WeaponId): void {
    const projId = `proj-${this.projectileCounter++}`;
    this.liveProjectiles.set(projId, { x, y, vx, vy, ownerId, birthTick: this.serverTick, damage, radius, maxTicks, weaponId });
    // Wire-discipline P3: projectiles no longer ride MapSchema. Per-recipient
    // interest-filtered list is folded into the snapshot in the broadcast loop.
  }

  /**
   * Shield->hull layered damage for a schema ShipState (active or
   * lingering). Mutates ship.health (hull) + ship.shield +
   * ship.shieldLastDamageTick. On the shield 0-cross emits SHIELD_BROKEN
   * and, when a worker body id is given, posts SET_HULL_EXPOSED so Rapier
   * swaps the body to its hull polygon. workerBodyId is null where the
   * collider swap is deferred (lingering hulls: dual body-id cases).
   */
  private damageShipLayered(
    ship: ShipState,
    damage: number,
    workerBodyId: string | null,
  ): { newShield: number; shieldMax: number; hullMax: number; hitLayer: 'shield' | 'hull' } {
    const kind = getShipKind(ship.kind);
    const state: ShieldHullState = {
      shield: ship.shield,
      hull: ship.health,
      lastDamageTick: ship.shieldLastDamageTick,
    };
    const r = applyLayeredDamage(state, damage, this.serverTick);
    ship.shield = state.shield;
    ship.health = state.hull;
    ship.shieldLastDamageTick = state.lastDamageTick;
    if (r.brokeThisHit) {
      this.bus.emit('SHIELD_BROKEN', { type: 'SHIELD_BROKEN', entityId: ship.shipInstanceId });
      serverLogEvent('shield_broken', { entityId: ship.shipInstanceId, kindId: ship.kind, tick: this.serverTick });
      if (workerBodyId !== null) {
        this.postToWorker({ type: 'SET_HULL_EXPOSED', id: workerBodyId, exposed: true, kindId: ship.kind, tick: this.serverTick });
      }
    }
    // hullMax stays ship.maxHealth (schema): hull behaves exactly as today
    // ("hull works as health does currently"); shield is the new layer.
    return { newShield: state.shield, shieldMax: kind.shieldMax, hullMax: ship.maxHealth, hitLayer: r.hitLayer };
  }

  /**
   * Shield->hull layered damage for a swarm drone (state in swarmShield/
   * swarmShieldLastDmg, hull in swarmHealth). Returns null for asteroids
   * (immune - no swarmHealth entry). Drone collider swap + wire = Phase 6,
   * so no SET_HULL_EXPOSED is posted here (drones still collide circle).
   */
  private damageSwarmLayered(
    rec: { id: string; entityId: number; shipKind?: string; shieldDown?: boolean },
    damage: number,
  ): { newShield: number; shieldMax: number; hullMax: number; hitLayer: 'shield' | 'hull' } | null {
    const hull0 = this.swarmHealth.get(rec.id);
    if (hull0 === undefined) return null;
    const shieldMax = getDroneShieldMax(rec.shipKind);
    const state: ShieldHullState = {
      shield: this.swarmShield.get(rec.id) ?? shieldMax,
      hull: hull0,
      lastDamageTick: this.swarmShieldLastDmg.get(rec.id) ?? this.serverTick,
    };
    const r = applyLayeredDamage(state, damage, this.serverTick);
    this.swarmShield.set(rec.id, state.shield);
    this.swarmShieldLastDmg.set(rec.id, state.lastDamageTick);
    this.swarmHealth.set(rec.id, state.hull);
    if (r.brokeThisHit) {
      this.bus.emit('SHIELD_BROKEN', { type: 'SHIELD_BROKEN', entityId: `swarm-${rec.entityId}` });
      serverLogEvent('shield_broken', { entityId: `swarm-${rec.entityId}`, tick: this.serverTick });
      // Phase 6 — flip the wire bit + swap the drone worker body to its
      // hull polygon (worker body id == rec.id; kind from rec.shipKind).
      rec.shieldDown = true;
      this.postToWorker({ type: 'SET_HULL_EXPOSED', id: rec.id, exposed: true, kindId: rec.shipKind ?? DEFAULT_SHIP_KIND, tick: this.serverTick });
    }
    return { newShield: state.shield, shieldMax, hullMax: getDroneMaxHealth(rec.shipKind) ?? 40, hitLayer: r.hitLayer };
  }

  /**
   * Halo shield regen - one cheap pass per update(). Full-shield entities
   * skip with two comparisons (no allocation). On the 0-cross-up an active
   * player ship swaps its collider back to the cheap circle and
   * SHIELD_RESTORED fires. Drone regen is server-side only here (collider
   * swap + wire = Phase 6); the discrete regen-ramp broadcast is Phase 3b.
   */
  private tickShieldRegen(): void {
    const t = this.serverTick;
    for (const [, ship] of this.state.ships) {
      if (!ship.alive) continue;
      const kind = getShipKind(ship.kind);
      if (ship.shield >= kind.shieldMax) continue;
      if (t - ship.shieldLastDamageTick < kind.shieldRegenDelayTicks) continue;
      const state: ShieldHullState = {
        shield: ship.shield,
        hull: ship.health,
        lastDamageTick: ship.shieldLastDamageTick,
      };
      const r = regenStep(state, kind, t);
      if (!r.regenerated) continue;
      ship.shield = state.shield;
      if (r.restoredThisStep) {
        this.bus.emit('SHIELD_RESTORED', { type: 'SHIELD_RESTORED', entityId: ship.shipInstanceId });
        serverLogEvent('shield_restored', { entityId: ship.shipInstanceId, tick: t });
        if (ship.isActive) {
          this.postToWorker({ type: 'SET_HULL_EXPOSED', id: ship.playerId, exposed: false, kindId: ship.kind, tick: t });
          // Discrete client anchor: regen began. The client tweens the
          // bar from here to shieldMax over the known regen duration —
          // the ramp itself is never streamed (locked: no continuous
          // shield traffic). Lingering hulls' owners aren't connected,
          // so only active player ships broadcast.
          this.broadcast('shield', { type: 'shield', targetId: ship.playerId, shield: ship.shield, shieldMax: kind.shieldMax, phase: 'restored', tick: t } satisfies ShieldEventMessage);
        }
      }
      if (r.regenComplete && ship.isActive) {
        this.broadcast('shield', { type: 'shield', targetId: ship.playerId, shield: kind.shieldMax, shieldMax: kind.shieldMax, phase: 'regen_complete', tick: t } satisfies ShieldEventMessage);
      }
    }
    for (const [id, shieldVal] of this.swarmShield) {
      const rec = this.swarmRegistry.get(id);
      if (!rec) continue;
      const sMax = getDroneShieldMax(rec.shipKind);
      if (shieldVal >= sMax) continue;
      const hull = this.swarmHealth.get(id);
      if (hull === undefined || hull <= 0) continue;
      const dkind = getShipKind(rec.shipKind);
      if (t - (this.swarmShieldLastDmg.get(id) ?? t) < dkind.shieldRegenDelayTicks) continue;
      const state: ShieldHullState = { shield: shieldVal, hull, lastDamageTick: this.swarmShieldLastDmg.get(id) ?? t };
      const r = regenStep(state, dkind, t);
      if (r.regenerated) this.swarmShield.set(id, state.shield);
      if (r.restoredThisStep) {
        serverLogEvent('shield_restored', { entityId: `swarm-${rec.entityId}`, tick: t });
        rec.shieldDown = false;
        this.postToWorker({ type: 'SET_HULL_EXPOSED', id: rec.id, exposed: false, kindId: rec.shipKind ?? DEFAULT_SHIP_KIND, tick: t });
      }
    }
  }

  private applyDamage(targetId: string, shooterId: string, damage: number, hitX?: number, hitY?: number): void {
    // Phase 4 — wreck damage. Wire id has the `wreck-` prefix; the rest
    // is the shipInstanceId UUID. Route to `state.wrecks` and tear down
    // on health 0.
    if (targetId.startsWith('wreck-')) {
      const shipInstanceId = targetId.slice('wreck-'.length);
      const wreck = this.state.wrecks.get(shipInstanceId);
      if (!wreck) return;
      wreck.health = Math.max(0, wreck.health - damage);
      const pose = this.wreckPoseCache.get(shipInstanceId);
      this.broadcast('damage', {
        type: 'damage',
        targetId,
        damage,
        newHealth: wreck.health,
        shooterId,
        hitX: hitX ?? pose?.x,
        hitY: hitY ?? pose?.y,
        newShield: 0,
        shieldMax: 0,
        hullMax: wreck.maxHealth,
        hitLayer: 'hull',
      } satisfies DamageEvent);
      if (wreck.health <= 0) {
        const destroyEvent: DestroyEvent = { type: 'destroy', targetId, shooterId };
        this.broadcast('destroy', destroyEvent);
        this.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId, shooterId });
        this.destroyWreck(shipInstanceId);
        logger.info({ shipInstanceId, shooterId }, 'wreck destroyed');
      }
      return;
    }

    // Phase 6b — when targetId is a shipInstanceId (a lingering hull, hit
    // by a projectile sweep that iterates lingeringSlots), route through
    // the schema directly. Otherwise fall back to the active-ship path
    // (targetId is a playerId, resolved via the indirection map).
    const directLingering = this.state.ships.get(targetId);
    if (directLingering && !directLingering.isActive) {
      if (!directLingering.alive) return;
      // Lingering hulls keep shield + regen. Collider swap deferred
      // (workerBodyId null): the lingering worker body id has two cases
      // (playerId vs linger-<id>) resolved in a Phase-6 follow-up.
      const f = this.damageShipLayered(directLingering, damage, null);
      const pose = this.lingeringPoseCache.get(targetId);
      const dmgEvent: DamageEvent = {
        type: 'damage',
        targetId,
        damage,
        newHealth: directLingering.health,
        shooterId,
        hitX: hitX ?? pose?.x,
        hitY: hitY ?? pose?.y,
        newShield: f.newShield,
        shieldMax: f.shieldMax,
        hullMax: f.hullMax,
        hitLayer: f.hitLayer,
      };
      this.broadcast('damage', dmgEvent);
      if (directLingering.health <= 0) {
        directLingering.alive = false;
        const destroyEvent: DestroyEvent = { type: 'destroy', targetId, shooterId };
        this.broadcast('destroy', destroyEvent);
        // Free the lingering slot and clear schema bookkeeping. The
        // roster row deletion happens via the SHIP_DESTROYED bus
        // handler's deleteRosterRow call below.
        const slot = this.lingeringSlots.get(targetId);
        if (slot !== undefined) {
          this.lingeringSlots.delete(targetId);
          this.lingeringPoseCache.delete(targetId);
          this.freeSlots.push(slot);
          // After the fresh-spawn-displaces rekey, the worker's body
          // for this hull is keyed by `linger-${shipInstanceId}`,
          // NOT by playerId (which now points at the player's active
          // ship). Despawn the correct body.
          this.postToWorker({ type: 'DESPAWN', slot, playerId: `linger-${targetId}` });
        }
        this.state.ships.delete(targetId);
        this.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId, shooterId });
        logger.info({ shipInstanceId: targetId, shooterId }, 'lingering hull destroyed');
      }
      return;
    }

    const ship = this.getActiveShip(targetId);
    if (ship) {
      if (!ship.alive) return;
      // Active branch: targetId is the playerId, which is exactly the
      // worker body id for the player ship (SPAWN used playerId).
      const f = this.damageShipLayered(ship, damage, targetId);

      const pose = this.shipPoseCache.get(targetId);
      const dmgEvent: DamageEvent = {
        type: 'damage',
        targetId,
        damage,
        newHealth: ship.health,
        shooterId,
        hitX: hitX ?? pose?.x,
        hitY: hitY ?? pose?.y,
        newShield: f.newShield,
        shieldMax: f.shieldMax,
        hullMax: f.hullMax,
        hitLayer: f.hitLayer,
      };
      this.broadcast('damage', dmgEvent);
      this.bus.emit('PLAYER_DAMAGED', { type: 'PLAYER_DAMAGED', targetId, damage, newHealth: ship.health });

      if (ship.health <= 0) {
        ship.alive = false;
        const destroyEvent: DestroyEvent = { type: 'destroy', targetId, shooterId };
        this.broadcast('destroy', destroyEvent);
        this.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId, shooterId });
        logger.info({ targetId, shooterId }, 'ship destroyed');
      }
      return;
    }

    // Swarm target. Asteroids (kind=0) have no `swarmHealth` entry and are
    // immune; drones (kind=1) take damage and despawn at zero health.
    const rec = this.swarmRegistry.get(targetId);
    if (!rec) return;
    const sf = this.damageSwarmLayered(rec, damage);
    if (sf === null) return; // immune (asteroid - no swarmHealth entry)
    const newHealth = this.swarmHealth.get(targetId) ?? 0;

    // Broadcast damage event keyed by the wire id (`swarm-${entityId}`) so the
    // client can flash the right sprite. Damage event reuses the player shape
    // — clients that key `mirror.damagedShips` by the same id will pick it up.
    const wireTargetId = `swarm-${rec.entityId}`;
    const b = slotBase(rec.slot);
    const swarmHitX = hitX ?? this.sabF32[b + SLOT_X_OFF]!;
    const swarmHitY = hitY ?? this.sabF32[b + SLOT_Y_OFF]!;
    this.broadcast('damage', {
      type: 'damage',
      targetId: wireTargetId,
      damage,
      newHealth,
      shooterId,
      hitX: swarmHitX,
      hitY: swarmHitY,
      newShield: sf.newShield,
      shieldMax: sf.shieldMax,
      hullMax: sf.hullMax,
      hitLayer: sf.hitLayer,
    } satisfies DamageEvent);

    // Phase 1 AI: a hit flips the drone's behaviour state to COMBAT and
    // adds the shooter to its hostile set. Same call goes to the client
    // from its damage-event handler — both sides converge on the same
    // hostility state without a wire-format bump.
    if (shooterId) {
      this.aiController.markHostile(rec.id, shooterId, this.serverTick);
    }

    if (newHealth <= 0) {
      this.evictSwarmEntity(rec, { broadcast: true, emitDestroyed: true, shooterId });
    }
  }

  /** Iterates positions of currently-alive players, for the LoadShedder.
   *  Skips dead ships so a corpse doesn't anchor far drones in place. Pose
   *  comes from `shipPoseCache` (the SAB mirror) — the schema no longer
   *  carries spatial fields. */
  private *alivePlayerPositions(): IterableIterator<{ x: number; y: number }> {
    // Phase 6b — schema key is shipInstanceId, but shipPoseCache is still
    // playerId-keyed (Option A residual), so we read pose via ship.playerId.
    for (const [, ship] of this.state.ships) {
      if (!ship.alive) continue;
      if (!ship.isActive) continue;
      const pose = this.shipPoseCache.get(ship.playerId);
      if (!pose) continue;
      yield { x: pose.x, y: pose.y };
    }
  }

  /**
   * Tear down a swarm entity. Combat kills pass `broadcast: true` so the client
   * flashes destruction and the kill-feed/SFX path runs. Phase 6 LoadShedder
   * passes `broadcast: false` so eviction for budget is invisible to players —
   * an explosion on a 5000-unit-distant drone would be confusing diegetically.
   * The `ENTITY_SHED` bus channel (separate from `ENTITY_DESTROYED`) lets
   * persistence/telemetry distinguish the two.
   */
  private evictSwarmEntity(
    rec: SwarmEntityRecord,
    opts: { broadcast: boolean; emitDestroyed: boolean; shooterId?: string },
  ): void {
    if (opts.broadcast) {
      const wireTargetId = `swarm-${rec.entityId}`;
      this.broadcast('destroy', {
        type: 'destroy',
        targetId: wireTargetId,
        shooterId: opts.shooterId ?? '',
      } satisfies DestroyEvent);
    }
    if (opts.emitDestroyed) {
      this.bus.emit('ENTITY_DESTROYED', { type: 'ENTITY_DESTROYED', entityId: rec.id });
    }

    this.postToWorker({ type: 'DESPAWN', slot: rec.slot, playerId: rec.id });
    this.interestGrid.remove(rec.entityId);
    this.swarmRegistry.unregister(rec.id);
    this.aiController.unregister(rec.id);
    this.swarmHealth.delete(rec.id);
    this.swarmShield.delete(rec.id);
    this.swarmShieldLastDmg.delete(rec.id);
    this.snapshotRing.unregisterEntity(rec.id);
    // Phase 4c — clean up drone turret state alongside the body.
    this.droneMountAngles.delete(rec.id);
    this.droneSlotTargets.delete(rec.id);
    this.freeSlots.push(rec.slot);
    if (opts.broadcast) {
      logger.info({ targetId: rec.id, shooterId: opts.shooterId }, 'drone destroyed');
    }
  }

  // ── Living World Director hooks ─────────────────────────────────────────
  // Thin, data-level surface the process-global LivingWorldDirector drives.
  // Everything here REUSES existing swarm machinery (swarmSpawner /
  // evictSwarmEntity / aiController). Bots are server-internal swarm
  // entities, NOT Colyseus clients — they never touch onJoin / Limbo /
  // reserveSeatFor; the director performs the cross-room hop directly.

  /** Active, alive, non-lingering players in this sector — the same
   *  filter the AI view-rebuild uses (one ownership site for "who counts
   *  as present"). The director feeds this into the desired-distribution
   *  computation. */
  playerCount(): number {
    let n = 0;
    for (const [pid] of this.playerToSlot) {
      const ship = this.getActiveShip(pid);
      if (ship?.alive && ship.isActive) n++;
    }
    return n;
  }

  /** Whether a SAB slot is free for one more swarm entity. The director
   *  pre-checks this on the DESTINATION before despawning a bot from the
   *  source room, so a transit can't lose a bot to slot exhaustion. */
  hasFreeSlot(): boolean {
    return this.freeSlots.length > 0;
  }

  /** Narrow read accessor onto this room's per-process event bus, so the
   *  process-global LivingWorldDirector can subscribe to `ENTITY_DESTROYED`
   *  (combat kill → respawn) / `ENTITY_SHED` (load-shed → pause) for its
   *  bots without the room exposing its whole surface. */
  eventBus(): Bus {
    return this.bus;
  }

  /**
   * Spawn a Living World bot into this sector. Reuses the standard swarm
   * spawn path (slot alloc, SAB prime, worker SPAWN_OBSTACLE, registry,
   * AI register) with a forced kind, primes drone health, opens the
   * join-broadcast grace window so the just-warped-in body streams
   * snapshots for client reconciliation (same rationale as a player
   * join — see JOIN_BROADCAST_GRACE_TICKS), and emits the warp-in visual
   * + discrete bus event. Returns false WITHOUT mutating when the slot
   * pool is exhausted (the director retries elsewhere next tick).
   */
  spawnLivingWorldBot(spec: {
    botId: string;
    kind: ShipKindId;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    health?: number;
  }): boolean {
    const ok = this.swarmSpawner.spawnDrone({
      id: spec.botId,
      x: spec.x,
      y: spec.y,
      vx: spec.vx ?? 0,
      vy: spec.vy ?? 0,
      kind: spec.kind,
    });
    if (!ok) return false;
    const maxHp = getDroneMaxHealth(spec.kind) ?? 40;
    this.swarmHealth.set(spec.botId, spec.health ?? maxHp);
    // Stream snapshots regardless of motion so a freshly-arrived client
    // reconciles the new body (mirrors the player-join grace; see the
    // warp/transit join-broadcast-grace lesson in src/server/CLAUDE.md).
    this.forceBroadcastUntilTick = this.serverTick + JOIN_BROADCAST_GRACE_TICKS;
    this.broadcast('warp_in', {
      type: 'warp_in',
      playerId: spec.botId,
      x: spec.x,
      y: spec.y,
    } satisfies WarpInEvent);
    this.bus.emit('BOT_SPAWNED', {
      type: 'BOT_SPAWNED',
      botId: spec.botId,
      sectorKey: this.sectorKey,
      x: spec.x,
      y: spec.y,
    });
    return true;
  }

  /**
   * Quietly remove a Living World bot for an inter-sector warp, returning
   * its carry-state for the destination room. Broadcasts warp-out so
   * occupants see it leave, then reuses the LoadShedder's proven quiet
   * teardown (`evictSwarmEntity { broadcast:false, emitDestroyed:false }`):
   * no `destroy` message and — critically — NO `ENTITY_DESTROYED` (that
   * bus event is the director's respawn trigger; a transit must not look
   * like a kill). Returns null if the bot isn't registered here.
   */
  despawnLivingWorldBot(botId: string): BotCarry | null {
    const rec = this.swarmRegistry.get(botId);
    if (!rec) return null;
    const b = slotBase(rec.slot);
    const carry: BotCarry = {
      kind: (rec.shipKind as ShipKindId | undefined) ?? DEFAULT_SHIP_KIND,
      health: this.swarmHealth.get(botId) ?? getDroneMaxHealth(rec.shipKind) ?? 40,
      vx: this.sabF32[b + SLOT_VX_OFF]!,
      vy: this.sabF32[b + SLOT_VY_OFF]!,
      angle: this.sabF32[b + SLOT_ANGLE_OFF]!,
      angvel: this.sabF32[b + SLOT_ANGVEL_OFF]!,
    };
    const x = this.sabF32[b + SLOT_X_OFF]!;
    const y = this.sabF32[b + SLOT_Y_OFF]!;
    this.broadcast('warp_out', {
      type: 'warp_out',
      playerId: botId,
      x,
      y,
    } satisfies WarpOutEvent);
    this.evictSwarmEntity(rec, { broadcast: false, emitDestroyed: false });
    this.bus.emit('BOT_DESPAWNED', {
      type: 'BOT_DESPAWNED',
      botId,
      sectorKey: this.sectorKey,
      reason: 'transit',
    });
    return carry;
  }

  /**
   * Make a Living World bot proactively hostile to every active player in
   * this sector via the EXISTING, lockstep-proven `markHostile` channel
   * (the same call `applyDamage` makes), and broadcast a discrete
   * `bot_aggro` the client applies through its own
   * `_aiController.markHostile` — the server→client twin of the
   * damage→markHostile mirror. The drone's existing COMBAT branch then
   * pursues + fires the nearest hostile. Re-called by the director each
   * control tick so the 30 s hostility decay never trips while a player
   * is present (a lost packet self-heals on the next pass). No-op if the
   * bot isn't registered here or no players are present.
   */
  markBotHostile(botId: string): void {
    const rec = this.swarmRegistry.get(botId);
    if (!rec) return;
    const wireId = `swarm-${rec.entityId}`;
    for (const [pid] of this.playerToSlot) {
      const ship = this.getActiveShip(pid);
      if (!ship?.alive || !ship.isActive) continue;
      this.aiController.markHostile(botId, pid, this.serverTick);
      this.broadcast('bot_aggro', {
        type: 'bot_aggro',
        botEntityId: wireId,
        targetPlayerId: pid,
        tick: this.serverTick,
      } satisfies BotAggroEvent);
    }
  }

  private handleRespawn(client: Client): void {
    const playerId = this.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;

    const ship = this.getActiveShip(playerId);
    if (!ship || ship.alive) return; // only dead ships may respawn

    const slot = this.playerToSlot.get(playerId);
    if (slot === undefined) return;

    const storedPos = this.initialSpawnPositions.get(playerId);
    // testMode preserves the originally-joined position so respawn doesn't
    // teleport mid-test. Else: the room-level default anchor (engineering
    // test rooms) wins over random scatter, matching `onJoin`'s fallback.
    const spawnX = (this.testMode && storedPos)
      ? storedPos.x
      : (this.defaultSpawnX ?? (Math.random() - 0.5) * 400);
    const spawnY = (this.testMode && storedPos)
      ? storedPos.y
      : (this.defaultSpawnY ?? (Math.random() - 0.5) * 400);

    // Reset physics body in worker to new spawn position. Preserve the ship's
    // existing `kind` — respawn keeps the same vehicle the player was flying.
    this.postToWorker({ type: 'DESPAWN', slot, playerId });
    this.postToWorker({ type: 'SPAWN', slot, playerId, x: spawnX, y: spawnY, kindId: ship.kind });

    // Pre-populate SAB so update() reads a sane position before the worker responds.
    const base = slotBase(slot);
    this.sabF32[base + SLOT_X_OFF]  = spawnX;
    this.sabF32[base + SLOT_Y_OFF]  = spawnY;
    this.sabF32[base + SLOT_VX_OFF] = 0;
    this.sabF32[base + SLOT_VY_OFF] = 0;

    // Reset authoritative ship state.
    ship.health = SHIP_MAX_HEALTH;
    ship.alive  = true;
    // Shield refills on respawn; force the body back to its cheap circle
    // collider (SET_HULL_EXPOSED is idempotent - no-op if already circle).
    ship.shield = getShipKind(ship.kind).shieldMax;
    ship.shieldLastDamageTick = this.serverTick;
    this.postToWorker({ type: 'SET_HULL_EXPOSED', id: playerId, exposed: false, kindId: ship.kind, tick: this.serverTick });
    // Seed the pose cache so any consumer that runs before the next update()
    // tick (e.g. an in-flight fire request resolved on this same client.send
    // turn) sees the respawn position rather than the corpse pose.
    const pose = this.shipPoseCache.get(playerId);
    if (pose) {
      pose.x = spawnX; pose.y = spawnY;
      pose.vx = 0; pose.vy = 0;
      // angle/angvel left as-is — the worker will overwrite both before the
      // next SAB→cache mirror.
    } else {
      this.shipPoseCache.set(playerId, { x: spawnX, y: spawnY, vx: 0, vy: 0, angle: 0, angvel: 0 });
    }

    // Clear fire cooldown so first shot after respawn isn't rejected.
    this.lastFireClientTick.delete(playerId);
    this.playerMountAngles.delete(playerId);
    this.playerSlotTargets.delete(playerId);

    const currentServerTick = Atomics.load(this.sabU32, TICK_IDX);
    const ack: RespawnAckMessage = { type: 'respawn_ack', x: spawnX, y: spawnY, serverTick: currentServerTick };
    client.send('respawn_ack', ack);

    logger.info({ playerId, spawnX, spawnY }, 'player respawned');
  }

  /**
   * Player hitscan distance with the PERF GUARANTEE: the cheap
   * bounding-circle test runs FIRST. If it misses, return null (the
   * hull polygon is strictly inside the circle, so a circle miss is a
   * polygon miss). If the shield is up, return the circle distance —
   * byte-identical to the legacy single rayHitsSphere call. Only when
   * the circle WOULD hit AND the shield is down (=== 0) do we pay for
   * the exact hull-polygon refinement.
   */
  private playerHitscanDist(
    ship: ShipState,
    fx: number, fy: number, dx: number, dy: number, maxDist: number,
    cx: number, cy: number, angle: number,
  ): number | null {
    const circle = rayHitsSphere(fx, fy, dx, dy, maxDist, cx, cy, SHIP_COLLISION_RADIUS);
    if (circle === null || ship.shield > 0) return circle;
    return rayHitsShipPolygon(fx, fy, dx, dy, maxDist, cx, cy, angle, shipCollisionTriangles(ship.kind));
  }

  /** Projectile sweep counterpart of playerHitscanDist — same cheap-
   *  circle-first / shield-down-refine perf profile. */
  private playerProjectileSweep(
    ship: ShipState,
    fromX: number, fromY: number, stepX: number, stepY: number, projRadius: number,
    cx: number, cy: number, angle: number,
  ): { entry: number; hitX: number; hitY: number } | null {
    const circle = projectileSweepCircle(fromX, fromY, stepX, stepY, projRadius, cx, cy, SHIP_COLLISION_RADIUS);
    if (circle === null || ship.shield > 0) return circle;
    return sweptSegmentHitsShipPolygon(fromX, fromY, stepX, stepY, cx, cy, angle, shipCollisionTriangles(ship.kind));
  }

  private advanceProjectiles(): void {
    const DT = 1 / 60;
    for (const [projId, proj] of this.liveProjectiles) {
      // Swept collision: test the segment from the current position to the
      // would-be next position, not just the next-position point. At 1600 u/s
      // a bolt advances ~26 units per tick, well over typical target radii;
      // a per-tick point-sample would tunnel through targets that sit between
      // consecutive samples. `projectileSweepCircle` returns the earliest
      // entry distance plus the exact hit point, which lets us pick the
      // closest target when the segment crosses multiple of them.
      const stepX = proj.vx * DT;
      const stepY = proj.vy * DT;

      let bestEntry = Infinity;
      let bestTargetId: string | null = null;
      let bestHitX = proj.x;
      let bestHitY = proj.y;

      for (const [targetId] of this.playerToSlot) {
        if (targetId === proj.ownerId) continue;
        const targetShip = this.getActiveShip(targetId);
        if (!targetShip || !targetShip.alive) continue;
        const targetPose = this.shipPoseCache.get(targetId);
        if (!targetPose) continue;
        const sweep = this.playerProjectileSweep(targetShip, proj.x, proj.y, stepX, stepY, proj.radius, targetPose.x, targetPose.y, targetPose.angle);
        if (sweep && sweep.entry < bestEntry) {
          bestEntry = sweep.entry;
          bestTargetId = targetId;
          bestHitX = sweep.hitX;
          bestHitY = sweep.hitY;
        }
      }

      for (const rec of this.swarmRegistry.all()) {
        const b = slotBase(rec.slot);
        const cx = this.sabF32[b + SLOT_X_OFF]!;
        const cy = this.sabF32[b + SLOT_Y_OFF]!;
        const sweep = projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, rec.radius);
        if (sweep && sweep.entry < bestEntry) {
          bestEntry = sweep.entry;
          bestTargetId = rec.id;
          bestHitX = sweep.hitX;
          bestHitY = sweep.hitY;
        }
      }

      // Phase 4 — projectile sweep against wrecks. Same sphere geometry
      // as live ships; targetId carries the `wreck-` prefix so
      // applyDamage routes to state.wrecks.
      for (const [shipInstanceId, slot] of this.wreckToSlot) {
        const b = slotBase(slot);
        const cx = this.sabF32[b + SLOT_X_OFF]!;
        const cy = this.sabF32[b + SLOT_Y_OFF]!;
        const sweep = projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, SHIP_COLLISION_RADIUS);
        if (sweep && sweep.entry < bestEntry) {
          bestEntry = sweep.entry;
          bestTargetId = `wreck-${shipInstanceId}`;
          bestHitX = sweep.hitX;
          bestHitY = sweep.hitY;
        }
      }

      // Phase 6b — projectile sweep against lingering hulls. The schema
      // `state.ships` entry stays live with `isActive=false`; we want
      // shots to land like they would on an active ship (damage applies
      // through the standard player-ship branch in `applyDamage`). The
      // targetId we surface is the shipInstanceId so `applyDamage` can
      // route through the schema map. We pull pose from `lingeringSlots`
      // (parallel to `playerToSlot` for active ships).
      for (const [shipInstanceId, slot] of this.lingeringSlots) {
        if (shipInstanceId === proj.ownerId) continue;
        const b = slotBase(slot);
        const cx = this.sabF32[b + SLOT_X_OFF]!;
        const cy = this.sabF32[b + SLOT_Y_OFF]!;
        const sweep = projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, cx, cy, SHIP_COLLISION_RADIUS);
        if (sweep && sweep.entry < bestEntry) {
          bestEntry = sweep.entry;
          bestTargetId = shipInstanceId;
          bestHitX = sweep.hitX;
          bestHitY = sweep.hitY;
        }
      }

      if (bestTargetId !== null) {
        this.applyDamage(bestTargetId, proj.ownerId, proj.damage, bestHitX, bestHitY);
        this.liveProjectiles.delete(projId);
        continue;
      }

      // No hit — commit the integration and run the lifetime check.
      proj.x += stepX;
      proj.y += stepY;
      if (this.serverTick - proj.birthTick >= proj.maxTicks) {
        this.liveProjectiles.delete(projId);
      }
    }
  }

  // ── Worker lifecycle ────────────────────────────────────────────────────

  private async spawnWorker(): Promise<void> {
    const workerCode = await bundleWorker({
      entryPoint: WORKER_TS_PATH,
      // Rapier ships a pre-built WASM binary; keep it external so the worker
      // accesses the same copy as the main thread (avoids double-init).
      external: ['@dimforge/rapier2d-compat'],
    });
    return new Promise<void>((resolve, reject) => {
      this.physicsWorker = new Worker(workerCode, {
        eval: true,
        workerData: { sab: this.sab },
      });

      let ready = false;

      this.physicsWorker.on('message', (msg: {
        type: string;
        entityId?: string;
        sleeping?: boolean;
        tick?: number;
        contacts?: Array<{
          aId: string; bId: string;
          vAxPost: number; vAyPost: number;
          vBxPost: number; vByPost: number;
          forceMagnitude: number;
        }>;
      }) => {
        if (!ready && msg.type === 'READY') {
          ready = true;
          resolve();
          return;
        }
        if (msg.type === 'SLEEP_TRANSITION' && typeof msg.entityId === 'string' && typeof msg.sleeping === 'boolean') {
          // Re-emit on the local bus as a discrete event. Phase 5 subscribers
          // (binary swarm broadcast in 5c, audio/UI in later phases) consume
          // these to freeze interpolation / play wake SFX. Pino sampling rule
          // for high-frequency events applies — log at 1% if needed.
          if (msg.sleeping) {
            this.bus.emit('ENTITY_SLEPT', { type: 'ENTITY_SLEPT', entityId: msg.entityId });
          } else {
            this.bus.emit('ENTITY_WOKE', { type: 'ENTITY_WOKE', entityId: msg.entityId });
          }
        }
        // Filter exposed for unit testing (see filterSelfCollisions.test.ts).
        // Inline here for clarity in the original handler.
        if (msg.type === 'CONTACT_BATCH' && Array.isArray(msg.contacts) && typeof msg.tick === 'number') {
          // Stage 2 of the network-feel roadmap: each contact above the
          // worker's CONTACT_FORCE_FLOOR is broadcast to all clients in the
          // room as `collision_resolved`. AOI filter is deferred — the
          // typical 1–4 player room's per-tick contact volume is low, and
          // the client's `applyCollisionResolved` already silently no-ops
          // on bodies its predWorld doesn't track (drone-vs-drone events).
          // Bus emission lets persistence/telemetry subscribe.
          // Aggregate per unordered {aId,bId} pair FIRST. A hull-polygon
          // body is a compound of N triangle colliders, so one physical
          // ram emits up to N contact-force sub-events sharing aId/bId.
          // Summing before floor/damage/broadcast prevents N-multiplied
          // damage, sub-floor splitting, and one broadcast per triangle.
          // See src/core/combat/Ramming.ts.
          for (const p of aggregateRamming(msg.contacts)) {
            // Phase 6b self-collision filter (aId === bId): the active +
            // lingering hulls of one player share the playerId identity.
            // See ./contactFilter.ts for the rationale + its unit test.
            if (p.aId === p.bId) {
              serverLogEvent('collision_self_filtered', {
                aId: p.aId,
                tick: msg.tick,
                impulse: parseFloat(p.force.toFixed(3)),
              });
              continue;
            }
            this.bus.emit('COLLISION_RESOLVED', {
              type: 'COLLISION_RESOLVED',
              aId: p.aId,
              bId: p.bId,
              vA: p.vA,
              vB: p.vB,
              impulse: p.force,
              tick: msg.tick,
            });
            this.broadcast('collision_resolved', {
              type: 'collision_resolved',
              aId: p.aId,
              bId: p.bId,
              vA: p.vA,
              vB: p.vB,
              impulse: p.force,
              tick: msg.tick,
            });
            serverLogEvent('collision_resolved', {
              aId: p.aId,
              bId: p.bId,
              impulse: parseFloat(p.force.toFixed(3)),
              tick: msg.tick,
            });
            // Ramming damage (Phase 4). Symmetric: each side takes the
            // damage; the OTHER id is the "shooter" (kill-feed +
            // hostility attribution). applyDamage already no-ops on
            // asteroids (immune - no swarmHealth entry) while still
            // damaging the ship they hit, so "asteroids deal but do not
            // take" falls out for free. Applied once per pair per tick.
            if (p.damage > 0) {
              serverLogEvent('ram_damage', {
                aId: p.aId,
                bId: p.bId,
                force: parseFloat(p.force.toFixed(1)),
                damage: parseFloat(p.damage.toFixed(2)),
                tick: msg.tick,
              });
              this.applyDamage(p.aId, p.bId, p.damage);
              this.applyDamage(p.bId, p.aId, p.damage);
            }
          }
        }
      });

      this.physicsWorker.on('error', (err) => {
        // Surface the full error — message, stack, name, code — so OOM /
        // assertion failures from Rapier WASM are diagnostic rather than
        // mute. Without `err.stack`, pino's serializer may drop the underlying
        // crash site. Phase 6 risk #2 (exercising the spawner past the prior
        // 500-entity ceiling) hits this path.
        const errAny = err as Error & { code?: string };
        logger.error(
          {
            err,
            errMessage: errAny?.message,
            errStack: errAny?.stack,
            errName: errAny?.name,
            errCode: errAny?.code,
            playerCount: this.playerToSlot.size,
            swarmCount: this.swarmRegistry.size(),
          },
          'physics worker error',
        );
        if (!ready) reject(err);
      });

      this.physicsWorker.on('exit', (code) => {
        if (code !== 0) {
          logger.error(
            { code, playerCount: this.playerToSlot.size, swarmCount: this.swarmRegistry.size() },
            'physics worker exited unexpectedly',
          );
          if (!ready) reject(new Error(`physics worker exited with code ${code}`));
        }
      });

      setTimeout(() => {
        if (!ready) reject(new Error('physics worker did not become READY within 10 s'));
      }, 10_000);
    });
  }

  private postToWorker(cmd: WorkerCmd): void {
    this.physicsWorker.postMessage(cmd);
  }

  // ── Colyseus room hooks ─────────────────────────────────────────────────

  override async onJoin(client: Client, options: unknown): Promise<void> {
    logger.info({ sessionId: client.sessionId, options }, 'onJoin called');
    const parsed = JoinOptionsSchema.safeParse(options);
    const requestedId = parsed.success ? parsed.data.playerId : null;
    let playerId = assignPlayerId(requestedId);

    const authToken = parsed.success ? parsed.data.authToken : undefined;
    const userId = authToken ? await validateToken(authToken) : null;

    // Validated ship-kind id from JoinOptions, or the catalogue default. Used
    // by the fresh-spawn and Limbo paths below; explicitly NOT consulted on
    // the rebind path (a bad-actor client must not be able to mid-session
    // swap kind by reconnecting — the existing ShipState.kind is preserved).
    const requestedKind = parsed.success
        && typeof parsed.data.shipKind === 'string'
        && isShipKindId(parsed.data.shipKind)
      ? parsed.data.shipKind
      : DEFAULT_SHIP_KIND;

    // If the requested ID is already held by an active session (e.g. two tabs
    // sharing the same localStorage), assign a fresh UUID.
    if (this.playerToSession.has(playerId)) {
      playerId = assignPlayerId(null);
    }

    // ── Phase 8 sub-phase B — REBIND PATH ──────────────────────────────────
    // If this player has an ownerless ship still drifting in the sector
    // (disconnected within the TTL window), reattach the new session to
    // the existing ship instead of fresh-spawning. The ship's pose / vel /
    // angle / health reflect what happened during the offline window
    // (drift decayed by drag, possibly damage from passing drones).
    //
    // Phase 3 multi-ship: the player can intentionally bypass rebind by
    // (a) sending `isNewShip:true` (sector-click → kind picker → fresh
    // spawn), or (b) sending a `shipId` that doesn't match the lingering
    // ship's `shipInstanceId` (roster card → resume a DIFFERENT stored
    // ship). When either is set, evict the lingering ship to stored
    // state (it stays in the roster, the slot is freed) and fall
    // through to the fresh-spawn path below.
    // Phase 6b cleanup — ownerlessShips is now keyed by the lingering hull's
    // shipInstanceId. Resolve via the playerToActiveShipInstance indirection
    // that was set up at original spawn and preserved through onLeave's
    // linger branch.
    const lingeringShipId = this.resolveActiveShipKey(playerId);
    const ownerlessTimer = lingeringShipId !== undefined
      ? this.ownerlessShips.get(lingeringShipId)
      : undefined;
    if (this.sectorKey !== null && ownerlessTimer !== undefined) {
      const existingShip = this.getActiveShip(playerId);
      const wantsNewShip = parsed.success && parsed.data.isNewShip === true;
      const requestedShipIdForRebindCheck = parsed.success && typeof parsed.data.shipId === 'string'
        ? parsed.data.shipId
        : '';
      const wantsDifferentShip = requestedShipIdForRebindCheck !== ''
        && existingShip !== undefined
        && existingShip.shipInstanceId !== ''
        && existingShip.shipInstanceId !== requestedShipIdForRebindCheck;
      if (wantsNewShip || wantsDifferentShip) {
        logger.info(
          { playerId, wantsNewShip, wantsDifferentShip, existingShipId: existingShip?.shipInstanceId, requestedShipId: requestedShipIdForRebindCheck },
          'rebind skipped — player picked a different / new ship; keeping lingering hull in sector',
        );
        // Phase 6b — DON'T evict the lingering hull. Promote it to the
        // lingeringSlots map so the snapshot loop continues to broadcast
        // it; clear the active indirection so the fresh ship can take
        // playerToActiveShipInstance[playerId] in its onJoin path.
        //
        // Phase 6b cleanup (2026-05-13) — the ownerlessShips timer is now
        // keyed by the lingering hull's shipInstanceId (not playerId), so
        // we DO NOT cancel it here. The timer keeps pointing at the
        // displaced hull's id and will correctly fire `evictOwnerlessShip`
        // for THAT hull at the 15-min mark — independent of whatever fresh
        // hull the player has bound in the meantime. This closes the
        // "displaced lingering hulls have no auto-evict" leak.
        const lingeringSlot = this.playerToSlot.get(playerId);
        if (lingeringSlot !== undefined && existingShip && existingShip.shipInstanceId !== '') {
          this.lingeringSlots.set(existingShip.shipInstanceId, lingeringSlot);
          // The hull is no longer "the player's active hull"; the fresh
          // spawn will overwrite playerToActiveShipInstance below.
          this.playerToActiveShipInstance.delete(playerId);
          // existingShip.isActive was already false from the original
          // onLeave linger branch — leave it false so the client
          // continues to render with the lingering tint.

          // Phase 6b push-fix (2026-05-13, diag
          // 2026-05-13T19-33-59-440Z-04j2mm — the "fly into the
          // abandoned ship, moves then snaps back" smoke-test bug).
          //
          // Rekey the worker's Rapier body identity from `playerId` to
          // a unique `linger-${shipInstanceId}`. Without this, the
          // imminent fresh-spawn `SPAWN { playerId, slot: newSlot }`
          // calls `World.spawnShip(playerId, ...)` which does
          // `bodies.set(playerId, newBody)` and ORPHANS the old body —
          // it remains alive in Rapier (still collidable, still
          // pushable) but its pose is no longer iterated by
          // `getAllShipStates()`, so the worker stops writing its
          // updated pose to SAB. The main thread reads the lingering
          // slot's SAB cells (stale forever) and broadcasts the
          // original abandon-point pose to clients every snapshot.
          // Visible bug: client predicts the hull moving on collision
          // → snapshot pulls it back to the stale pose → repeat.
          //
          // Same shape as the Phase 4 wreck rekey at line ~2840.
          // playerToSlot in the worker also gets remapped to the new
          // key, so SAB writes continue to land in the correct (now-
          // lingering) slot.
          this.postToWorker({
            type: 'REKEY_SHIP',
            oldId: playerId,
            newId: `linger-${existingShip.shipInstanceId}`,
          });
        }
        // Fall through to the fresh-spawn / shipId-restore path below.
        // The fresh spawn will allocate a NEW slot from freeSlots
        // (the lingering slot stays allocated, tracked by lingeringSlots).
        // playerToSlot[playerId] gets overwritten with the new slot.
      } else {
        // Original rebind behaviour: reattach to the existing slot.
        // Phase 6b cleanup — ownerlessShips keyed by shipInstanceId.
        clearTimeout(ownerlessTimer);
        if (lingeringShipId !== undefined) this.ownerlessShips.delete(lingeringShipId);
        const existingSlot = this.playerToSlot.get(playerId);
        if (existingSlot !== undefined && existingShip) {
        // Phase 6b — flip the lingering flag back. The hull is being
        // re-bound to a live session; isActive=true means the snapshot
        // anchor + render tint + (Phase 6c) drone targeting all treat
        // it as fully alive again.
        existingShip.isActive = true;
        this.sessionToPlayer.set(client.sessionId, playerId);
        this.playerToSession.set(playerId, client.sessionId);

        // Take the Limbo entry to clear the active-Limbo UI gate. The
        // payload is irrelevant on this path — the live ShipState/SAB is
        // the source of truth — but the userId carried in Limbo is the
        // anonymous-reconnect fallback for `playerToUser`.
        const limbo = getLimboStore().take(playerId);
        const resumedUserId = limbo?.payload.userId ?? null;
        const effectiveUserId = userId ?? resumedUserId;
        this.playerToUser.set(playerId, effectiveUserId);

        // lastFireClientTick is already retained from the original session;
        // do NOT reset — preserves cooldown across reconnect.

        const b = slotBase(existingSlot);
        const liveX = this.sabF32[b + SLOT_X_OFF]!;
        const liveY = this.sabF32[b + SLOT_Y_OFF]!;

        const tickAtRebind = Atomics.load(this.sabU32, TICK_IDX);
        const welcome: WelcomeMessage = {
          type: 'welcome',
          playerId,
          serverTick: tickAtRebind,
          sectorKey: this.sectorKey,
          shipInstanceId: existingShip?.shipInstanceId ?? '',
        };
        client.send('welcome', welcome);

        setSession(client.sessionId, {
          roomId: this.roomId,
          playerId,
          sectorKey: this.sectorKey,
        });

        // Note: we do NOT call recordGameJoin again — the original
        // session's joined_at remains canonical. From a stats perspective
        // a disconnect+reconnect is one continuous play session.

        this.bus.emit('SHIP_SPAWNED', {
          type: 'SHIP_SPAWNED' as const,
          playerId,
          x: liveX,
          y: liveY,
        });
        // Reconnect-restore path: force snapshot broadcasts so the
        // returning client reconciles its prediction before
        // idle-suppression can kick in. See JOIN_BROADCAST_GRACE_TICKS.
        this.forceBroadcastUntilTick =
          Atomics.load(this.sabU32, TICK_IDX) + JOIN_BROADCAST_GRACE_TICKS;
        serverLogEvent('player_rebind', {
          playerId,
          sessionId: client.sessionId,
          x: liveX,
          y: liveY,
          health: existingShip.health,
        });
        logger.info(
          { playerId, sessionId: client.sessionId, x: liveX, y: liveY, health: existingShip.health, alive: existingShip.alive },
          'player rebound to lingering ship',
        );
        return;
      }
        // Stale entry: ownerlessShips had this player but the slot/ShipState
        // is gone (e.g. a race we didn't anticipate). Fall through to
        // fresh-spawn — better to recover than throw.
        logger.warn({ playerId }, 'stale ownerless entry — falling through to fresh spawn');
      }
    }

    // ── FRESH SPAWN PATH ───────────────────────────────────────────────────
    this.sessionToPlayer.set(client.sessionId, playerId);
    this.playerToSession.set(playerId, client.sessionId);

    const slot = this.freeSlots.pop();
    if (slot === undefined) {
      logger.error({ playerId }, 'no free SAB slots — room is full');
      client.leave(1001);
      return;
    }
    this.playerToSlot.set(playerId, slot);
    this.slotToPlayer.set(slot, playerId);
    this.snapshotRing.registerEntity(playerId);

    // URL-param wins; else room-level `defaultSpawnX/Y` (engineering test
    // rooms anchor at a known point); else legacy ±200 u random scatter.
    let spawnX = parsed.success && parsed.data.spawnX !== undefined
      ? parsed.data.spawnX
      : (this.defaultSpawnX ?? (Math.random() - 0.5) * 400);
    let spawnY = parsed.success && parsed.data.spawnY !== undefined
      ? parsed.data.spawnY
      : (this.defaultSpawnY ?? (Math.random() - 0.5) * 400);
    let resumedHealth: number | null = null;
    let resumedUserId: string | null = null;
    let resumedLastFireTick: number | null = null;
    let resumedVx = 0;
    let resumedVy = 0;
    let resumedAngle = 0;
    let resumedAngvel = 0;
    let resumedFromLimbo = false;
    /** Phase 3 — when the client supplied a valid `shipId` in JoinOptions,
     *  the bindRosterEntry call resolves to this exact row instead of the
     *  most-recent-updated default. Empty string means "no preference". */
    let preferredShipId = '';
    /** Kind to spawn with. Defaults to the requested kind; Limbo or
     *  shipId-restore override. */
    let chosenKind: string = requestedKind;

    // Phase 3 multi-ship roster — shipId-based restore. The client picked a
    // specific roster entry from the galaxy-map panel; hydrate from that row
    // and skip the Limbo path entirely. Owned-by-this-player check guards
    // against a malicious client claiming someone else's roster row.
    const requestedShipId = parsed.success && typeof parsed.data.shipId === 'string'
      ? parsed.data.shipId
      : '';
    if (this.sectorKey !== null && requestedShipId !== '') {
      const rec = getPlayerShipStore().get(requestedShipId);
      if (rec !== null && rec.playerId === playerId && rec.lastSectorKey === this.sectorKey) {
        spawnX = rec.lastX;
        spawnY = rec.lastY;
        // Defensive: a stored health <= 0 should be impossible (the
        // ship would have been destroyed and the roster row deleted),
        // but we observed it 2026-05-13 after a 15-min lingering ship
        // was spawned back as 0/maxHealth. Most likely a race in the
        // linger-eviction path where ship.health was driven to 0 by
        // drones but SHIP_DESTROYED didn't propagate before the
        // evictOwnerlessShip call. Treat 0 as "give the user a fresh
        // hull" and log so we can find the underlying gap.
        const kind = getShipKind(rec.kind);
        if (rec.health <= 0) {
          logger.warn(
            { playerId, shipId: rec.shipId, storedHealth: rec.health, kind: rec.kind },
            'roster row has non-positive health on spawn — issuing fresh hull (root-cause TBD)',
          );
          resumedHealth = kind.maxHealth;
        } else {
          resumedHealth = rec.health;
        }
        resumedUserId = rec.userId;
        resumedLastFireTick = rec.lastFireClientTick;
        resumedVx = rec.lastVx;
        resumedVy = rec.lastVy;
        resumedAngle = rec.lastAngle;
        resumedAngvel = rec.lastAngvel;
        resumedFromLimbo = true;
        chosenKind = rec.kind;
        preferredShipId = rec.shipId;
        // Drop any stale Limbo entry (we're binding by shipId, not by limbo).
        try { getLimboStore().take(playerId); } catch { /* best-effort */ }
        logger.info(
          { playerId, shipId: rec.shipId, sectorKey: this.sectorKey, x: spawnX, y: spawnY, health: resumedHealth },
          'restored from roster shipId',
        );
      } else if (rec === null) {
        logger.warn({ playerId, shipId: requestedShipId }, 'JoinOptions.shipId not found; falling back to limbo');
      } else if (rec.playerId !== playerId) {
        logger.warn({ playerId, shipOwner: rec.playerId }, 'JoinOptions.shipId not owned by caller; falling back');
      } else {
        logger.warn(
          { playerId, shipId: requestedShipId, shipSector: rec.lastSectorKey, joinSector: this.sectorKey },
          'JoinOptions.shipId is in a different sector; falling back',
        );
      }
    }

    // Phase 8 sub-phase B — Limbo restore. Only galaxy rooms participate
    // in Limbo; engineering rooms continue to fresh-spawn on every join.
    // The destination's `onJoin` consumes the entry whether it was created
    // by a disconnect (5 min TTL) or by a transit commit (30 s TTL); the
    // sectorKey gate ensures we only consume entries destined for THIS room.
    // Skipped when a valid shipId already hydrated above. Also skipped when
    // `isNewShip` is set — Phase 3 multi-ship: clicking a sector on the
    // galaxy map to spawn a *fresh* ship must NOT silently restore a
    // lingering ship from Limbo; the player can resume that one via the
    // roster panel separately.
    const isNewShipRequest = parsed.success && parsed.data.isNewShip === true;
    if (this.sectorKey !== null && !resumedFromLimbo && !isNewShipRequest) {
      const limbo = getLimboStore().take(playerId);
      if (limbo && limbo.payload.sectorKey === this.sectorKey) {
        spawnX = limbo.payload.x;
        spawnY = limbo.payload.y;
        resumedHealth = limbo.payload.health;
        resumedUserId = limbo.payload.userId;
        resumedLastFireTick = limbo.payload.lastFireClientTick;
        resumedVx = limbo.payload.vx;
        resumedVy = limbo.payload.vy;
        resumedAngle = limbo.payload.angle;
        resumedAngvel = limbo.payload.angvel;
        resumedFromLimbo = true;
        // Resumed kind dominates the requested kind on Limbo paths — a player
        // who disconnected mid-session must come back in the same ship. Tolerant
        // decode for Limbo entries written by older builds (no kind field).
        if (typeof limbo.payload.kind === 'string' && isShipKindId(limbo.payload.kind)) {
          chosenKind = limbo.payload.kind;
        }
        logger.info(
          { playerId, sectorKey: this.sectorKey, x: spawnX, y: spawnY, health: resumedHealth },
          'restored from Limbo',
        );
      } else if (limbo) {
        // Entry exists but for a different sector — put it back. This is
        // unusual (the landing screen restricts the player to the entry's
        // sector) but defensive: if a player navigates by raw URL to a
        // sector they don't belong in, we don't want to silently discard
        // their existing-ship state.
        getLimboStore().put(playerId, limbo.payload, limbo.expiresAt - Date.now());
      }
    }

    this.initialSpawnPositions.set(playerId, { x: spawnX, y: spawnY });

    // Pre-populate the SAB slot so the update() loop sees a sane position
    // immediately, before the worker processes the SPAWN command.
    const base = slotBase(slot);
    this.sabF32[base + SLOT_X_OFF] = spawnX;
    this.sabF32[base + SLOT_Y_OFF] = spawnY;
    if (resumedFromLimbo) {
      this.sabF32[base + SLOT_VX_OFF]     = resumedVx;
      this.sabF32[base + SLOT_VY_OFF]     = resumedVy;
      this.sabF32[base + SLOT_ANGLE_OFF]  = resumedAngle;
      this.sabF32[base + SLOT_ANGVEL_OFF] = resumedAngvel;
    }

    // Create Colyseus schema entry. The schema only carries identity +
    // health/alive + kind — pose lives in `shipPoseCache` (see field doc).
    const ship = new ShipState();
    ship.playerId = playerId;
    ship.kind = chosenKind;
    if (resumedHealth !== null) ship.health = resumedHealth;
    // Phase 3 dual-write — pick or create a `player_ships` row for this
    // ship and stamp its UUID onto the schema. Engineering rooms skip
    // persistence and leave shipInstanceId empty. When the client supplied
    // a valid `shipId`, that row is the one we bind; when `isNewShip`
    // is set, we force a fresh row (subject to 10-cap); otherwise we
    // pick the most-recently-updated row (or create a fresh one).
    const forceFreshCreate = parsed.success && parsed.data.isNewShip === true;
    ship.shipInstanceId = this.bindRosterEntry(playerId, userId ?? resumedUserId, chosenKind, {
      x: spawnX,
      y: spawnY,
      vx: resumedFromLimbo ? resumedVx : 0,
      vy: resumedFromLimbo ? resumedVy : 0,
      angle: resumedFromLimbo ? resumedAngle : 0,
      angvel: resumedFromLimbo ? resumedAngvel : 0,
      health: resumedHealth ?? ship.health,
      lastFireClientTick: resumedLastFireTick ?? 0,
    }, preferredShipId, forceFreshCreate);
    // Phase 6a — engineering rooms (`sectorKey === null`) bypass the
    // roster entirely, so `bindRosterEntry` returns ''. Generate a
    // synthetic UUID so the snapshot wire key + downstream lookups
    // (PlayerShipStore.get etc.) never see an empty id. Two players in
    // the same engineering room each get a unique synthetic id, so
    // there's no collision.
    //
    // 2026-05-13 fix: scope to engineering rooms ONLY. A previous
    // version of this fallback fired unconditionally when
    // shipInstanceId was '', which also caught the GALAXY-room
    // roster-full case (bindRosterEntry returns '' on RosterFullError).
    // The synthetic UUID then had no roster row, so the 30-tick
    // abandon-detection sweep saw `store.get(syntheticUUID) === null`
    // and immediately reaped the ship as a wreck — 18 ms after spawn.
    // Regression test:
    // `tests/integration/sectorRoom/rosterFullWreck.test.ts`.
    if (ship.shipInstanceId === '' && this.sectorKey === null) {
      ship.shipInstanceId = randomUUID();
    }
    ship.isActive = true;
    // Populate the indirection map BEFORE setting the schema entry so
    // any synchronous observer (e.g. a re-entrant fire-handler) can
    // already resolve the player's active hull.
    this.playerToActiveShipInstance.set(playerId, ship.shipInstanceId);
    // Phase 6b — schema map is keyed by shipInstanceId. This supports
    // multiple entries per player (active + lingering hulls). All the
    // `state.ships.get(playerId)` callsites have been migrated to the
    // `getActiveShip(playerId)` helper which translates via
    // resolveActiveShipKey. The Colyseus diff broadcast now carries
    // ship records keyed by shipInstanceId; the snapshot wire format
    // already matched this since Phase 6a.
    this.state.ships.set(ship.shipInstanceId, ship);
    // Shield seeds full on spawn (transient - never persisted; only hull
    // persists). Body spawns circle (exposed:false in spawnShip).
    ship.shield = getShipKind(ship.kind).shieldMax;
    // Test-only initialHull / initialShield overrides. Gated to testMode
    // rooms (engineering, never galaxy) so live gameplay can't be nerfed
    // via the wire. Applied AFTER the kind-default hull/shield are
    // installed so the test spec gets the exact override it asked for.
    // E2E specs that just need "do they die when shot?" spawn with
    // initialHull=1, initialShield=0 → one beam tick kills.
    if (this.testMode && parsed.success) {
      if (typeof parsed.data.initialHull === 'number') {
        ship.health = Math.max(1, parsed.data.initialHull);
      }
      if (typeof parsed.data.initialShield === 'number') {
        ship.shield = Math.max(0, parsed.data.initialShield);
      }
    }
    ship.shieldLastDamageTick = this.serverTick;

    // Seed the pose cache with the spawn pose so any pre-update read sees a
    // sane value (e.g. a fire request resolved on this same client.send turn).
    this.shipPoseCache.set(playerId, {
      x: spawnX,
      y: spawnY,
      vx: resumedFromLimbo ? resumedVx : 0,
      vy: resumedFromLimbo ? resumedVy : 0,
      angle: resumedFromLimbo ? resumedAngle : 0,
      angvel: resumedFromLimbo ? resumedAngvel : 0,
    });

    this.postToWorker({ type: 'SPAWN', slot, playerId, x: spawnX, y: spawnY, kindId: chosenKind });

    const currentServerTick = Atomics.load(this.sabU32, TICK_IDX);

    if (resumedLastFireTick !== null && shouldHonourResumedCooldown(resumedLastFireTick, currentServerTick)) {
      this.lastFireClientTick.set(playerId, resumedLastFireTick);
    }
    const welcome: WelcomeMessage = {
      type: 'welcome',
      playerId,
      serverTick: currentServerTick,
      sectorKey: this.sectorKey,
      shipInstanceId: ship.shipInstanceId,
    };
    client.send('welcome', welcome);

    // Prefer the auth-validated userId from this connect; fall back to the
    // Limbo-resumed value when this connect was anonymous (covers the
    // "close-tab, reopen-without-relogging" path on the same browser).
    const effectiveUserId = userId ?? resumedUserId;
    this.playerToUser.set(playerId, effectiveUserId);
    recordGameJoin(effectiveUserId, playerId, this.sectorKey ?? this.roomId);

    // Phase 1 — propagate the player's display label so other clients can
    // render a name above their ship. `displayName` is preferred; the
    // email is the documented fallback (see plan). Anonymous players
    // leave an empty string and the client falls back to `Pilot ${id}`.
    if (effectiveUserId) {
      const user = getUser(effectiveUserId);
      if (user) ship.displayName = user.displayName ?? user.email ?? '';
    }

    // Phase 8 sub-phase B — register session for diag inspection and future
    // multi-VM transit routing.
    setSession(client.sessionId, {
      roomId: this.roomId,
      playerId,
      sectorKey: this.sectorKey,
    });

    this.bus.emit('SHIP_SPAWNED', { type: 'SHIP_SPAWNED' as const, playerId, x: spawnX, y: spawnY });
    // Fresh-spawn path: force snapshot broadcasts for a grace window so
    // the new client receives a steady stream to reconcile its
    // prediction world against the spawn pose BEFORE idle-suppression
    // short-circuits the broadcast loop. Without this, a stationary
    // freshly-spawned ship in an otherwise-quiet sector gets zero
    // snapshots until the player moves — then the first snapshot snaps
    // the (stale, free-run) prediction hundreds of units. See
    // JOIN_BROADCAST_GRACE_TICKS.
    this.forceBroadcastUntilTick = currentServerTick + JOIN_BROADCAST_GRACE_TICKS;
    serverLogEvent('player_join', { playerId, sessionId: client.sessionId, spawnX, spawnY });
    logger.info(
      { playerId, sessionId: client.sessionId, userId: effectiveUserId, resumedFromLimbo },
      'player joined',
    );

    // Broadcast the arrival to existing room occupants so their renderer
    // fires a one-shot flash + burst ripple at the spawn point. The
    // joiner is excluded — their own welcome / first-snapshot flow drives
    // their local-arrival visual through different machinery.
    this.broadcast(
      'warp_in',
      { type: 'warp_in', playerId, x: spawnX, y: spawnY },
      { except: client },
    );
  }

  override onLeave(client: Client, _consented: boolean): void {
    const playerId = this.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;

    // Phase 6b — capture the active ship's shipInstanceId now, before
    // any cleanup clears the indirection map. We need it to delete from
    // the schema (which is now shipInstanceId-keyed) at the end of the
    // despawn path. May be undefined if the player never finished
    // joining; downstream guards handle that case.
    const onLeaveShipKey = this.resolveActiveShipKey(playerId);

    // Phase 1 AI: drop this player from every drone's hostile set so that
    // when (or if) they return to the sector — or another player engages —
    // the drones aren't still gunning for someone who's no longer here.
    this.aiController.purgeHostility(playerId);

    // Always clear session-bound state. Boost is held — drop it on
    // disconnect (no key is held during the offline window so the ship
    // shouldn't keep boosting).
    this.sessionToPlayer.delete(client.sessionId);
    this.playerToSession.delete(playerId);
    this.interestScratch.delete(client.sessionId);
    this.sabAppliedTicks.delete(playerId);
    this.boostingPlayers.delete(playerId);
    this.thrustingPlayers.delete(playerId);
    // Stage 5 — drop per-recipient scheduler state.
    this.lastInputCaches.delete(client.sessionId);
    clearSession(client.sessionId);

    const slot = this.playerToSlot.get(playerId);
    const ship = this.getActiveShip(playerId);
    const transitInFlight = this.playerToTransitInFlight.has(playerId);
    this.playerToTransitInFlight.delete(playerId);

    // Cancel any in-flight orchestrator entry for this player (e.g. they
    // disconnected during SPOOLING). Idempotent if there's no entry.
    this.transitOrchestrator?.cancelTransit(playerId, 'manual');

    // Phase 8 sub-phase B (lingering ships) — for galaxy rooms, keep an
    // ALIVE ship in the simulation when the player disconnects (not
    // transiting, not dead). The physics worker continues stepping it; drag
    // decays vx/vy/angvel and the ship drifts to a stop. Other clients
    // continue to see it via the snapshot broadcast. Reconnect within
    // LIMBO_DISCONNECT_TTL_MS rebinds the new session to the existing
    // ship; on TTL expiry `evictOwnerlessShip` runs full cleanup.
    //
    // We still write a Limbo entry — but it serves a different purpose
    // now: (a) the active-Limbo UI gate on the landing screen reads it
    // via `/dev/limbo`, (b) on a server crash it's the only way to know
    // where this player's ship was (live drift state is lost on restart).
    const shouldLinger =
      this.sectorKey !== null
      && slot !== undefined
      && ship?.alive === true
      && !transitInFlight;

    if (shouldLinger) {
      const b = slotBase(slot!);
      const payload: LimboPayload = {
        x:      this.sabF32[b + SLOT_X_OFF]!,
        y:      this.sabF32[b + SLOT_Y_OFF]!,
        vx:     this.sabF32[b + SLOT_VX_OFF]!,
        vy:     this.sabF32[b + SLOT_VY_OFF]!,
        angle:  this.sabF32[b + SLOT_ANGLE_OFF]!,
        angvel: this.sabF32[b + SLOT_ANGVEL_OFF]!,
        health: ship!.health,
        lastFireClientTick: this.lastFireClientTick.get(playerId) ?? 0,
        userId: this.playerToUser.get(playerId) ?? null,
        sectorKey: this.sectorKey!,
        kind: ship!.kind,
      };
      try {
        getLimboStore().put(playerId, payload, LIMBO_DISCONNECT_TTL_MS);
      } catch (err) {
        logger.warn({ err, playerId }, 'Limbo put on leave failed');
      }

      // Phase 3 dual-write — mirror linger pose into the roster row so the
      // /dev/player-ships endpoint shows the player's ship at its current
      // resting place after disconnect.
      this.markRosterLinger(ship!.shipInstanceId, {
        x: payload.x, y: payload.y, vx: payload.vx, vy: payload.vy,
        angle: payload.angle, angvel: payload.angvel,
        health: payload.health, lastFireClientTick: payload.lastFireClientTick,
      });

      // Phase 6b cleanup — keyed by shipInstanceId, not playerId. See the
      // ownerlessShips field doc for the displaced-hull-leak history.
      const shipInstanceId = ship!.shipInstanceId;
      const evictTimer = setTimeout(() => {
        this.evictOwnerlessShip(shipInstanceId);
      }, LIMBO_DISCONNECT_TTL_MS);
      if (typeof evictTimer === 'object' && evictTimer !== null && 'unref' in evictTimer) {
        (evictTimer as { unref: () => void }).unref();
      }
      this.ownerlessShips.set(shipInstanceId, evictTimer);

      // Phase 6b — flip the schema's `isActive` flag to false so the
      // client renderer can tint lingering hulls (grey-ish, no thrust
      // flame) and Phase 6c's drone retargeting can ignore them. The
      // schema field mutation propagates via the Colyseus diff broadcast
      // automatically. Indirection map (playerToActiveShipInstance)
      // INTENTIONALLY KEPT — on rebind we look it up to find the
      // shipInstanceId to flip back to active.
      ship.isActive = false;
      // NOTE: We do NOT add to lingeringSlots here. The ship's slot
      // stays in playerToSlot[playerId] — that's the canonical place
      // for "this player's hull in this room" while the player might
      // still reconnect. lingeringSlots only fills when a DIFFERENT
      // ship (fresh-spawn / different shipId) displaces this one from
      // playerToSlot — see the rebind branch in onJoin.

      serverLogEvent('player_lingered', { playerId });
      logger.info(
        { playerId, sectorKey: this.sectorKey, health: ship.health },
        'player left, ship lingering in sector',
      );
      return;
    }

    // Despawn path — engineering room, dead ship, or transit-in-flight
    // (the destination's onJoin will restore from the transit Limbo entry).
    this.lastFireClientTick.delete(playerId);
    this.playerMountAngles.delete(playerId);
    this.playerSlotTargets.delete(playerId);
    this.initialSpawnPositions.delete(playerId);
    this.snapshotRing.unregisterEntity(playerId);
    // Phase 6a — drop the playerId → shipInstanceId indirection. The
    // schema entry is being deleted below; resolveActiveShipKey would
    // return a stale id otherwise.
    this.playerToActiveShipInstance.delete(playerId);

    if (slot !== undefined) {
      this.playerToSlot.delete(playerId);
      this.slotToPlayer.delete(slot);
      this.freeSlots.push(slot);
      this.postToWorker({ type: 'DESPAWN', slot, playerId });
    }

    if (onLeaveShipKey !== undefined) this.state.ships.delete(onLeaveShipKey);
    this.shipPoseCache.delete(playerId);
    recordGameLeave(playerId);
    this.playerToUser.delete(playerId);
    this.bus.emit('SHIP_DESPAWNED', { type: 'SHIP_DESPAWNED' as const, playerId });
    serverLogEvent('player_leave', { playerId });
    logger.info({ playerId }, 'player left');
  }

  /**
   * Phase 8 sub-phase B (lingering ships) — full despawn for an ownerless
   * ship. Called when (a) the eviction timer fires after the disconnect
   * TTL elapses without reconnect, (b) the ship is destroyed mid-offline,
   * or (c) the room is disposed. Same teardown as the despawn branch of
   * `onLeave`, plus clears the Limbo entry so the active-Limbo UI doesn't
   * keep showing a sector the player can no longer enter.
   */
  private evictOwnerlessShip(shipInstanceId: string): void {
    const timer = this.ownerlessShips.get(shipInstanceId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.ownerlessShips.delete(shipInstanceId);
    }

    const ship = this.state.ships.get(shipInstanceId);
    if (ship === undefined) {
      // Already cleaned up by another path (e.g. applyDamage destroyed the
      // lingering hull and ran the lingeringSlots cleanup inline).
      return;
    }
    const playerId = ship.playerId;

    // Phase 6b cleanup — differentiate active-hull eviction (the player has
    // a live session that just expired its 15-min TTL) from lingering-hull
    // eviction (the hull was displaced by a fresh spawn; the player is
    // currently piloting a DIFFERENT hull). The two need different cleanup:
    //   active: free playerToSlot, drop all player-keyed maps, delete Limbo
    //   lingering: free lingeringSlots ONLY; leave player-keyed maps alone
    //              (those refer to the player's CURRENT active hull, not
    //              this displaced one).
    const isLingeringHull = this.lingeringSlots.has(shipInstanceId);
    const slot = isLingeringHull
      ? this.lingeringSlots.get(shipInstanceId)
      : this.playerToSlot.get(playerId);

    // Capture the ship's final pose for the roster mirror BEFORE freeing
    // the schema entry.
    let rosterPose: {
      x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
      health: number; lastFireClientTick: number;
    } | null = null;
    if (slot !== undefined) {
      const b = slotBase(slot);
      if (ship.alive && ship.health <= 0) {
        logger.warn(
          { playerId, shipId: shipInstanceId, shipHealth: ship.health, sectorKey: this.sectorKey, isLingeringHull },
          'evicting lingering ship with non-positive health — applyDamage race?',
        );
      }
      rosterPose = {
        x:      this.sabF32[b + SLOT_X_OFF]!,
        y:      this.sabF32[b + SLOT_Y_OFF]!,
        vx:     this.sabF32[b + SLOT_VX_OFF]!,
        vy:     this.sabF32[b + SLOT_VY_OFF]!,
        angle:  this.sabF32[b + SLOT_ANGLE_OFF]!,
        angvel: this.sabF32[b + SLOT_ANGVEL_OFF]!,
        health: Math.max(1, ship.health),
        lastFireClientTick: isLingeringHull ? 0 : (this.lastFireClientTick.get(playerId) ?? 0),
      };
    }

    if (isLingeringHull) {
      // Free only the lingering-hull side of bookkeeping. The player's
      // active hull (if any) keeps all of its playerId-keyed entries.
      this.lingeringSlots.delete(shipInstanceId);
      this.lingeringPoseCache.delete(shipInstanceId);
      if (slot !== undefined) {
        this.freeSlots.push(slot);
        // The worker rekeyed this body to `linger-${shipInstanceId}` at
        // the fresh-spawn-displaces point; DESPAWN must use the same key
        // or it'd despawn the player's active ship.
        this.postToWorker({ type: 'DESPAWN', slot, playerId: `linger-${shipInstanceId}` });
      }
    } else {
      // Active-hull eviction — full player-scope teardown.
      this.lastFireClientTick.delete(playerId);
      this.playerMountAngles.delete(playerId);
      this.playerSlotTargets.delete(playerId);
      this.initialSpawnPositions.delete(playerId);
      this.snapshotRing.unregisterEntity(playerId);
      this.playerToActiveShipInstance.delete(playerId);
      if (slot !== undefined) {
        this.playerToSlot.delete(playerId);
        this.slotToPlayer.delete(slot);
        this.freeSlots.push(slot);
        this.postToWorker({ type: 'DESPAWN', slot, playerId });
      }
      this.shipPoseCache.delete(playerId);
      this.playerToUser.delete(playerId);

      // Clear the active-Limbo UI gate. Without this, the landing screen
      // would keep pointing at a sector this player no longer has a ship in.
      try {
        getLimboStore().delete(playerId);
      } catch (err) {
        logger.warn({ err, playerId }, 'Limbo delete on eviction failed');
      }

      recordGameLeave(playerId);
    }

    // Schema entry removal applies to both cases.
    this.state.ships.delete(shipInstanceId);

    // Phase 3 dual-write — flip the roster row to stored state with the
    // ship's last pose frozen in place. The row persists indefinitely so
    // the player can pick it back up on a future visit.
    if (rosterPose !== null) {
      this.markRosterStored(shipInstanceId, rosterPose);
    }

    this.bus.emit('SHIP_DESPAWNED', { type: 'SHIP_DESPAWNED' as const, playerId });
    serverLogEvent('ownerless_evicted', { playerId, shipInstanceId, isLingeringHull });
    logger.info(
      { playerId, shipInstanceId, sectorKey: this.sectorKey, isLingeringHull },
      'ownerless ship evicted',
    );
  }

  // ── Phase 3 multi-ship roster (dual-write) ─────────────────────────────
  //
  // The room mirrors every spawn / linger / evict / destroy into
  // `PlayerShipStore`. LimboStore continues to drive the spawn-restore
  // logic; PlayerShipStore is the source of truth for the per-player
  // roster card list shown by the galaxy-map UI. Phase 4 plans to fold
  // these into one path with shipId-based join binding.
  //
  // Galaxy rooms only (sectorKey !== null). Engineering rooms have no
  // persistent identity and skip the dual-write entirely.

  /**
   * Upsert a `player_ships` row for the newly-bound ship. Looks up
   * existing roster entries for the player and reuses the most-recent;
   * creates a fresh row if none exists. Returns the row's `shipId` so
   * the caller can stamp it onto `ShipState.shipInstanceId`. Returns
   * empty string for engineering rooms or when the operation fails
   * (e.g. roster cap on a fresh-spawn fallback — caller continues; the
   * ship still spawns, just without a roster row).
   */
  private bindRosterEntry(
    playerId: string,
    userId: string | null,
    kind: string,
    pose: {
      x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
      health: number; lastFireClientTick: number;
    },
    /** When set, bind this specific roster row rather than picking the
     *  most-recent. Caller is responsible for verifying ownership; here
     *  we only mark-active. Falls back to the most-recent path on miss. */
    preferredShipId: string = '',
    /** Phase 3 — when true, skip the most-recent-row fallback and
     *  always create a fresh roster entry. Used by the galaxy-map
     *  sector-click → kind-picker flow so clicking a sector spawns a
     *  *new* ship rather than silently resuming the player's last
     *  ride. Subject to 10-cap; on RosterFullError the ship still
     *  spawns but without a roster row (logged warning). */
    forceFreshCreate: boolean = false,
  ): string {
    if (this.sectorKey === null) return '';
    const store = getPlayerShipStore();
    if (preferredShipId !== '') {
      const next = store.markActive(preferredShipId, this.roomId, pose);
      if (next !== null) {
        logger.info({ playerId, shipId: next.shipId, path: 'preferred' }, 'roster bind');
        return next.shipId;
      }
      // Fell through — caller's preferred id didn't exist. Continue with
      // the legacy most-recent path so the player still spawns into
      // something rather than getting a roster-less ship.
    }
    const existing = store.listByPlayer(playerId);
    if (existing.length > 0 && !forceFreshCreate) {
      // Most-recently-updated first. Pre-Phase-4 multi-ship UX uses the
      // most recent entry as the implicit "current" ship.
      existing.sort((a, b) => b.updatedAt - a.updatedAt);
      const chosen = existing[0]!;
      const next = store.markActive(chosen.shipId, this.roomId, pose);
      logger.info({ playerId, shipId: next?.shipId, path: 'reuse-recent', existingCount: existing.length }, 'roster bind');
      return next?.shipId ?? '';
    }
    try {
      const rec = store.create({
        playerId,
        userId,
        kind,
        sectorKey: this.sectorKey,
        x: pose.x,
        y: pose.y,
        health: pose.health,
      });
      store.markActive(rec.shipId, this.roomId, pose);
      logger.info({ playerId, shipId: rec.shipId, path: 'fresh-create', forceFresh: forceFreshCreate }, 'roster bind');
      return rec.shipId;
    } catch (err) {
      if (err instanceof RosterFullError) {
        logger.warn({ playerId }, 'Roster full — ship spawned without a roster row');
      } else {
        logger.warn({ err, playerId }, 'Failed to create roster row');
      }
      return '';
    }
  }

  /**
   * Mirror the linger state into the roster row — pose freeze at
   * disconnect, expiresAt = now + 15 min. The room schedules the eviction
   * timer separately (see onLeave); this is the persistence side.
   */
  private markRosterLinger(
    shipInstanceId: string,
    pose: {
      x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
      health: number; lastFireClientTick: number;
    },
  ): void {
    if (this.sectorKey === null || shipInstanceId === '') return;
    const store = getPlayerShipStore();
    if (store.get(shipInstanceId) === null) return;
    store.markActive(shipInstanceId, this.roomId, pose, Date.now() + LIMBO_DISCONNECT_TTL_MS);
  }

  /**
   * Phase 4 — promote a player's ship to an ownerless wreck in this
   * sector. Called by the abandon-detection poll in `update()` when a
   * ship's roster row has been deleted while still alive in the room.
   *
   * Critical invariants:
   *  - The SAB slot is RETAINED (the worker keeps stepping the body).
   *    We re-key it under `slotToWreck` and pull it out of
   *    `slotToPlayer`. `freeSlots` only ever takes the slot back when
   *    the wreck is destroyed by damage.
   *  - All player-keyed maps for this slot are torn down so no stray
   *    snapshot path serialises the ship after conversion.
   *  - The player's session is force-leave'd. Their next galaxy-map
   *    visit shows their (now smaller) roster minus the abandoned row.
   */
  private convertShipToWreck(playerId: string): void {
    const ship = this.getActiveShip(playerId);
    const slot = this.playerToSlot.get(playerId);
    if (ship === undefined || slot === undefined || ship.shipInstanceId === '') return;
    if (!ship.alive) {
      // Already destroyed — the standard despawn path handles cleanup.
      // Don't leave a destroyed-but-orphaned wreck.
      return;
    }
    const shipInstanceId = ship.shipInstanceId;
    const b = slotBase(slot);
    const pose = this.shipPoseCache.get(playerId) ?? {
      x:      this.sabF32[b + SLOT_X_OFF]!,
      y:      this.sabF32[b + SLOT_Y_OFF]!,
      vx:     this.sabF32[b + SLOT_VX_OFF]!,
      vy:     this.sabF32[b + SLOT_VY_OFF]!,
      angle:  this.sabF32[b + SLOT_ANGLE_OFF]!,
      angvel: this.sabF32[b + SLOT_ANGVEL_OFF]!,
    };

    // 1) Build the wreck schema entry.
    const wreck = new WreckState();
    wreck.shipInstanceId = shipInstanceId;
    wreck.kind = ship.kind;
    wreck.health = ship.health;
    wreck.maxHealth = ship.maxHealth;
    this.state.wrecks.set(shipInstanceId, wreck);
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
    this.postToWorker({ type: 'REKEY_SHIP', oldId: playerId, newId: `wreck-${shipInstanceId}` });

    // 3) Tear down player-keyed bookkeeping. Slot is NOT pushed onto
    //    freeSlots — the wreck still owns it.
    this.playerToSlot.delete(playerId);
    this.slotToPlayer.delete(slot);
    this.lastFireClientTick.delete(playerId);
    this.playerMountAngles.delete(playerId);
    this.playerSlotTargets.delete(playerId);
    this.initialSpawnPositions.delete(playerId);
    this.shipPoseCache.delete(playerId);
    this.snapshotRing.unregisterEntity(playerId);
    // Phase 6b — schema is shipInstanceId-keyed; the local already
    // captured `shipInstanceId` from the ship reference earlier.
    this.state.ships.delete(shipInstanceId);
    // Phase 6a — drop the playerId → shipInstanceId indirection. The
    // hull is now a wreck (keyed by shipInstanceId in `state.wrecks`);
    // the player no longer has an active ship in this room.
    this.playerToActiveShipInstance.delete(playerId);

    // 4) Force the owning session to leave (if connected). The player
    //    sees their roster missing this ship on the next galaxy-map
    //    visit. The Limbo path is bypassed — the row is already gone.
    const sessionId = this.playerToSession.get(playerId);
    if (sessionId !== undefined) {
      const client = this.clients.find((c) => c.sessionId === sessionId);
      if (client !== undefined) {
        try { client.send('ship_abandoned', { shipInstanceId }); } catch { /* socket already closed */ }
        try { client.leave(1000); } catch { /* already gone */ }
      }
      this.playerToSession.delete(playerId);
    }
    this.sessionToPlayer.forEach((pid, sid) => {
      if (pid === playerId) this.sessionToPlayer.delete(sid);
    });
    this.playerToUser.delete(playerId);

    this.wreckConversions++;
    serverLogEvent('ship_abandoned', { playerId, shipInstanceId, sectorKey: this.sectorKey });
    logger.info({ playerId, shipInstanceId, sectorKey: this.sectorKey }, 'ship abandoned → wreck');
  }

  /**
   * Phase 4 — drop a wreck and release its SAB slot. Called from
   * `applyDamage` when a wreck's health reaches 0, and from
   * `onDispose` so we don't leak slots on room teardown.
   */
  private destroyWreck(shipInstanceId: string): void {
    const slot = this.wreckToSlot.get(shipInstanceId);
    if (slot !== undefined) {
      this.wreckToSlot.delete(shipInstanceId);
      this.slotToWreck.delete(slot);
      this.freeSlots.push(slot);
      this.postToWorker({ type: 'DESPAWN', slot, playerId: `wreck-${shipInstanceId}` });
    }
    this.state.wrecks.delete(shipInstanceId);
    this.wreckPoseCache.delete(shipInstanceId);
  }

  /**
   * Mirror an eviction into the roster — the ship transitions from
   * `is_active=true` to `is_active=false` with frozen pose. The row
   * stays in the table (forever, modulo the 10-cap) so the player can
   * pick it on a future visit.
   */
  private markRosterStored(
    shipInstanceId: string,
    pose: {
      x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
      health: number; lastFireClientTick: number;
    },
  ): void {
    if (this.sectorKey === null || shipInstanceId === '') return;
    const store = getPlayerShipStore();
    if (store.get(shipInstanceId) === null) return;
    store.markStored(shipInstanceId, { ...pose, sectorKey: this.sectorKey });
  }

  /**
   * Mirror a destruction into the roster — the row is deleted. The
   * Phase 4 wreck flow will replace this with "leave a wreck behind"
   * semantics, but for Phase 3 we just remove from the roster.
   */
  private deleteRosterRow(shipInstanceId: string): void {
    if (this.sectorKey === null || shipInstanceId === '') return;
    getPlayerShipStore().delete(shipInstanceId);
  }

  override onDispose(): void {
    this.simLoopStopped = true;
    // Phase 8 sub-phase B — abort any in-flight transits so no orphan timers
    // or seat reservations linger past room teardown.
    this.transitOrchestrator?.cancelAll('manual');
    // Clear lingering-ship eviction timers — the room is being torn down,
    // so the timers would fire against a dead `this`. The ships' Limbo
    // entries stay on disk so a server-restart restore can find them.
    for (const timer of this.ownerlessShips.values()) clearTimeout(timer);
    this.ownerlessShips.clear();
    // Phase 8 — final snapshot before tear-down so swarm health survives
    // a graceful shutdown. `persistence.shutdown` (called from index.ts on
    // SIGINT/SIGTERM) drains the CRITICAL queue afterwards.
    if (this.sectorKey !== null) {
      try { this.persistSectorSnapshot(); } catch { /* non-critical */ }
    }
    this.physicsWorker?.terminate();
    logger.info({ sectorKey: this.sectorKey }, 'SectorRoom disposed');
  }

  // ── Phase 8 sub-phase B — TransitOrchestrator host adapter ──────────────

  /**
   * Adapts this room to the narrow `TransitHostRoom` contract the
   * orchestrator depends on. Keeps the orchestrator decoupled from the
   * full SectorRoom surface so its tests can mock just these members.
   */
  private asTransitHost(): import('../transit/TransitOrchestrator.js').TransitHostRoom {
    return {
      sectorKey: this.sectorKey,
      bus: this.bus,
      sabF32: this.sabF32,
      playerToSlot: this.playerToSlot,
      playerToUser: this.playerToUser,
      lastFireClientTick: this.lastFireClientTick,
      getShipHealth: (playerId: string): number => {
        const ship = this.getActiveShip(playerId);
        return ship?.health ?? SHIP_MAX_HEALTH;
      },
      getShipKind: (playerId: string): string => {
        const ship = this.getActiveShip(playerId);
        return ship?.kind ?? DEFAULT_SHIP_KIND;
      },
      playerToTransitInFlight: this.playerToTransitInFlight,
      clientForPlayer: (playerId: string): Client | null => {
        const sessionId = this.playerToSession.get(playerId);
        if (!sessionId) return null;
        const c = this.clients.find((x) => x.sessionId === sessionId);
        return c ?? null;
      },
      broadcast: (type: string, message: unknown, options?: { except?: Client | Client[] }): void => {
        this.broadcast(type, message, options);
      },
    };
  }

  // ── Phase 8 — sector snapshot persistence ───────────────────────────────

  /**
   * Build a `SectorSnapshotPayload` from the live registry + health map and
   * enqueue it through the persistence sink. CRITICAL lane — survives drain.
   */
  private persistSectorSnapshot(): void {
    if (this.sectorKey === null) return;
    const swarm: SectorSnapshotPayload['swarm'] = [];
    for (const rec of this.swarmRegistry.all()) {
      // Asteroids aren't tracked in swarmHealth; default them to 0 (unused on
      // restore because asteroids aren't kill-tracked).
      const health = this.swarmHealth.get(rec.id) ?? 0;
      const b = slotBase(rec.slot);
      swarm.push({
        entityId: rec.id,
        kind: rec.kind,
        x: this.sabF32[b + SLOT_X_OFF]!,
        y: this.sabF32[b + SLOT_Y_OFF]!,
        health,
      });
    }
    const payload: SectorSnapshotPayload = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sectorKey: this.sectorKey,
      savedAtMs: Date.now(),
      swarm,
    };
    try {
      saveSnapshot(this.sectorKey, payload);
    } catch (err) {
      logger.warn({ err, sectorKey: this.sectorKey }, 'sector snapshot enqueue failed');
    }
  }

  /**
   * Look up the most recent on-disk snapshot for this sector and restore
   * swarm health (positions are deterministic from the seed — not restored).
   * Discards snapshots whose schemaVersion mismatches CURRENT_SCHEMA_VERSION
   * or whose age exceeds SNAPSHOT_STALENESS_MS, falling through to fresh-spawn.
   */
  private hydrateFromSnapshot(): void {
    if (this.sectorKey === null) return;
    let row: { snapshot: string; created_at: number } | undefined;
    try {
      row = db.prepare(
        'SELECT snapshot, created_at FROM game_snapshots WHERE sector_id = ? ORDER BY created_at DESC LIMIT 1',
      ).get(this.sectorKey) as { snapshot: string; created_at: number } | undefined;
    } catch (err) {
      logger.warn({ err, sectorKey: this.sectorKey }, 'snapshot hydrate query failed — fresh spawn');
      return;
    }
    if (!row) {
      logger.info({ sectorKey: this.sectorKey }, 'no prior snapshot — fresh sector spawn');
      return;
    }
    const ageMs = Date.now() - row.created_at;
    if (ageMs > SNAPSHOT_STALENESS_MS) {
      logger.info({ sectorKey: this.sectorKey, ageMs }, 'snapshot stale — fresh sector spawn');
      return;
    }
    let payload: SectorSnapshotPayload;
    try {
      payload = parseSnapshot(JSON.parse(row.snapshot));
    } catch (err) {
      logger.warn({ err, sectorKey: this.sectorKey }, 'snapshot parse/version mismatch — fresh sector spawn');
      return;
    }
    let restored = 0;
    for (const e of payload.swarm) {
      // Drones only — asteroids aren't health-tracked.
      if (e.kind !== 1) continue;
      if (this.swarmRegistry.has(e.entityId)) {
        this.swarmHealth.set(e.entityId, e.health);
        restored += 1;
      }
    }
    logger.info({ sectorKey: this.sectorKey, ageMs, restored }, 'sector hydrated from snapshot');
  }

  // ── Simulation loop (main thread — reads SAB, updates Colyseus schema) ──

  private update(): void {
    this.inputCountThisTick.clear();
    // Phase 8 — galaxy sectors always run the simulation step regardless of
    // player count, so the world feels alive (drones patrol, asteroids drift,
    // sleep transitions fire) even when nobody's logged in. Engineering rooms
    // keep the dual-zero short-circuit because their state is ephemeral and
    // there's no reason to burn CPU on them when idle.
    if (
      this.sectorKey === null
      && this.playerToSlot.size === 0
      && this.swarmRegistry.size() === 0
    ) return;

    const tStart = performance.now();

    // Phase 6 synthetic load: busy-wait `tickBurnMs` so the budget tracker
    // measures it as real work and TiDi engages. Only enabled when the
    // `tickBurnMs` room option is set (default 0). Always before the phase
    // timer starts so it counts in the unattributed remainder of `total`,
    // not against any specific phase.
    if (this.tickBurnMs > 0) {
      const burnDeadline = tStart + this.tickBurnMs;
      while (performance.now() < burnDeadline) { /* intentional busy-wait */ }
    }

    let tPhase = performance.now();
    // Reset per-tick phase capture at the top of every update().
    for (const k of Object.keys(this.thisTickPhases)) this.thisTickPhases[k] = 0;
    const phaseTime = (key: keyof typeof this.tickBudgetSums): void => {
      const now = performance.now();
      const elapsed = now - tPhase;
      this.tickBudgetSums[key] = (this.tickBudgetSums[key] ?? 0) + elapsed;
      this.thisTickPhases[key] = (this.thisTickPhases[key] ?? 0) + elapsed;
      tPhase = now;
    };

    // Seqlock read: retry if a write is in progress or if data was torn
    // (seqlock changed between the two loads). Player pose is mirrored into
    // `shipPoseCache` (a plain Map of mutable records) — NOT into the
    // Colyseus schema. Mirroring into the schema previously caused a
    // duplicate broadcast of every spatial field on top of the custom
    // SnapshotMessage; see the wire-discipline plan / SectorState.ts notes.
    // Swarm poses are read directly from SAB by the binary encoder later in
    // this tick (see swarmEncoder.encode).
    for (;;) {
      const seq1 = Atomics.load(this.sabU32, SEQLOCK_IDX);
      if (seq1 & 1) continue; // odd → write in progress, spin

      for (const [playerId, slot] of this.playerToSlot) {
        const pose = this.shipPoseCache.get(playerId);
        if (!pose) continue;
        const b = slotBase(slot);
        pose.x      = this.sabF32[b + SLOT_X_OFF]!;
        pose.y      = this.sabF32[b + SLOT_Y_OFF]!;
        pose.angle  = this.sabF32[b + SLOT_ANGLE_OFF]!;
        pose.vx     = this.sabF32[b + SLOT_VX_OFF]!;
        pose.vy     = this.sabF32[b + SLOT_VY_OFF]!;
        pose.angvel = this.sabF32[b + SLOT_ANGVEL_OFF]!;
        // Decode applied tick: storedValue=0 means no input applied yet (use 0);
        // storedValue=N+1 means client tick N was applied.
        // (handled below)
      }
      // Phase 6b — lingering hulls' pose mirror. Same SAB → cache update
      // pattern as the active-ship loop above. The worker continues to
      // step these bodies (drag decays vx/vy/angvel; positions drift on
      // their final velocity vector). lingeringPoseCache is allocated
      // lazily here so we don't carry an empty object for the common
      // case (no lingering hulls).
      for (const [shipInstanceId, slot] of this.lingeringSlots) {
        let pose = this.lingeringPoseCache.get(shipInstanceId);
        if (!pose) {
          pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
          this.lingeringPoseCache.set(shipInstanceId, pose);
        }
        const b = slotBase(slot);
        pose.x      = this.sabF32[b + SLOT_X_OFF]!;
        pose.y      = this.sabF32[b + SLOT_Y_OFF]!;
        pose.angle  = this.sabF32[b + SLOT_ANGLE_OFF]!;
        pose.vx     = this.sabF32[b + SLOT_VX_OFF]!;
        pose.vy     = this.sabF32[b + SLOT_VY_OFF]!;
        pose.angvel = this.sabF32[b + SLOT_ANGVEL_OFF]!;
      }
      // Phase 4 — wreck pose mirror. Wrecks live in SAB slots like
      // player ships; the worker steps them every physics tick. We
      // mirror their pose here for the snapshot path.
      for (const [shipInstanceId, slot] of this.wreckToSlot) {
        const pose = this.wreckPoseCache.get(shipInstanceId);
        if (!pose) continue;
        const b = slotBase(slot);
        pose.x      = this.sabF32[b + SLOT_X_OFF]!;
        pose.y      = this.sabF32[b + SLOT_Y_OFF]!;
        pose.angle  = this.sabF32[b + SLOT_ANGLE_OFF]!;
        pose.vx     = this.sabF32[b + SLOT_VX_OFF]!;
        pose.vy     = this.sabF32[b + SLOT_VY_OFF]!;
        pose.angvel = this.sabF32[b + SLOT_ANGVEL_OFF]!;
      }
      // (player-loop continuation just below for the appliedTicks
      //  decode — kept inside the seqlock window for consistency.)
      for (const [playerId, slot] of this.playerToSlot) {
        const b = slotBase(slot);
        const storedTick = this.sabU32[b + SLOT_APPLIED_TICK_OFF]!;
        this.sabAppliedTicks.set(playerId, storedTick === 0 ? 0 : storedTick - 1);
      }

      const seq2 = Atomics.load(this.sabU32, SEQLOCK_IDX);
      if (seq1 === seq2) break; // consistent read
      // seq changed during read → writer modified data, retry
    }

    this.serverTick = Atomics.load(this.sabU32, TICK_IDX);
    this.state.tick = this.serverTick;

    // Phase 4 — abandon detection. Every 30 ticks (~500ms) we check
    // whether any ship currently in this room has had its roster row
    // deleted (via /dev/player-ships/:shipId/abandon). When that
    // happens, convert the ship to an ownerless wreck and kick the
    // player. Galaxy rooms only — engineering rooms have no roster.
    if (this.sectorKey !== null && this.serverTick % 30 === 0 && this.state.ships.size > 0) {
      const store = getPlayerShipStore();
      const abandoned: string[] = [];
      // Phase 6b — schema key is shipInstanceId; convertShipToWreck still
      // takes playerId (internal slot maps haven't been rekeyed), so read
      // ship.playerId from the schema field. Inactive (lingering) hulls
      // are skipped: a player can abandon a lingering hull from the
      // roster panel, but that path goes through a different code branch.
      for (const [, ship] of this.state.ships) {
        if (ship.shipInstanceId === '' || !ship.alive || !ship.isActive) continue;
        if (store.get(ship.shipInstanceId) === null) abandoned.push(ship.playerId);
      }
      for (const playerId of abandoned) this.convertShipToWreck(playerId);
    }

    // Phase 5d: keep the spatial grid current. Most entities don't cross a
    // 2048-unit cell boundary in a single tick at typical drone/asteroid
    // speeds (~30-100 u/s), so move() returns early without touching the
    // bucket map. Cost is one Map.get + integer compare per entity.
    //
    // Phase 1 AI backstop: while we iterate, also catch any drone that
    // has drifted past `DRONE_MAX_BOUNDS` and post a SET_POSITION worker
    // command to teleport it back. Patrol behaviour pulls drones home in
    // normal play; this is a "should never fire" guard against runaway
    // pursuits and the long-session drift bug (real diag: drones at
    // (4 133 782, -1 093 669) on 2026-05-10). Asteroids unaffected.
    for (const rec of this.swarmRegistry.all()) {
      const b = slotBase(rec.slot);
      const sx = this.sabF32[b + SLOT_X_OFF]!;
      const sy = this.sabF32[b + SLOT_Y_OFF]!;
      this.interestGrid.move(rec.entityId, sx, sy);
      if (rec.kind === 1 && (Math.abs(sx) > DRONE_MAX_BOUNDS || Math.abs(sy) > DRONE_MAX_BOUNDS)) {
        const clampedX = Math.max(-DRONE_MAX_BOUNDS, Math.min(DRONE_MAX_BOUNDS, sx));
        const clampedY = Math.max(-DRONE_MAX_BOUNDS, Math.min(DRONE_MAX_BOUNDS, sy));
        this.postToWorker({
          type: 'SET_POSITION',
          entityId: rec.id,
          x: clampedX, y: clampedY,
          angle: this.sabF32[b + SLOT_ANGLE_OFF]!,
          vx: 0, vy: 0, angvel: 0,
        });
        logger.warn({ entityId: rec.id, sx, sy }, 'drone position clamped to bounds');
      }
    }
    phaseTime('sabRead');

    // Record poses for lag compensation. Allocation-free: streams directly
    // through `beginTick` + `recordEntity` instead of materializing an
    // intermediate array. Covers every dynamic entity — ships AND swarm —
    // so the polygon-aware hit resolver can rewind any obstacle's pose
    // (position + angle) to the shooter's tick. Mass-independent: any
    // moving entity benefits from accurate hit attribution.
    this.snapshotRing.beginTick(this.serverTick);
    for (const id of this.playerToSlot.keys()) {
      const ship = this.getActiveShip(id);
      if (!ship?.alive) continue;
      const pose = this.shipPoseCache.get(id);
      if (!pose) continue;
      this.snapshotRing.recordEntity(id, pose.x, pose.y, pose.vx, pose.vy, pose.angle, pose.angvel ?? 0);
    }
    for (const rec of this.swarmRegistry.all()) {
      const b = slotBase(rec.slot);
      this.snapshotRing.recordEntity(
        rec.id,
        this.sabF32[b + SLOT_X_OFF]!,
        this.sabF32[b + SLOT_Y_OFF]!,
        this.sabF32[b + SLOT_VX_OFF]!,
        this.sabF32[b + SLOT_VY_OFF]!,
        this.sabF32[b + SLOT_ANGLE_OFF]!,
        this.sabF32[b + SLOT_ANGVEL_OFF]!,
      );
    }

    // Advance physical projectiles and check for collisions.
    this.advanceProjectiles();
    this.tickShieldRegen();
    phaseTime('projectiles');

    // Phase 8 — sector persistence. Galaxy rooms snapshot their volatile
    // state (swarm health) every 60 s. Engineering rooms (sectorKey null)
    // skip; their state is ephemeral by design.
    if (this.sectorKey !== null) {
      this.ticksSinceSnapshot += 1;
      if (this.ticksSinceSnapshot >= 3600 /* 60 s at 60 Hz */) {
        this.ticksSinceSnapshot = 0;
        this.persistSectorSnapshot();
      }
    }

    // Broadcast authoritative snapshot at 20 Hz using an independent counter
    // on the main thread, not a SAB tick divisibility check. Divisibility caused
    // ~25% missed broadcasts when the two 60 Hz loops (worker + Colyseus) were
    // slightly out of phase. The counter fires every 3 main-thread update() calls
    // (= every 50 ms) regardless of which SAB tick value is currently visible.
    // Phase 5c: encode the binary swarm packet every server tick (60 Hz). The
    // encoder returns null when no pose has changed past the quantisation
    // epsilon (or when not every-60th-tick full-snapshot), so the wire cost is
    // dominated by the full-snapshot keyframe and the rare-but-real motion
    // deltas. Phase 5d: encode per-client with the spatial grid's 9-cell
    // interest window. Out-of-interest entities still ship at decimated
    // cadence inside the encoder.
    if (this.serverTick > 0 && this.clients.length > 0) {
      for (const client of this.clients) {
        const bp = checkBackpressure(client, logger);
        if (bp === 'close') { client.leave(4002); continue; }
        if (bp === 'drop') continue;

        const playerId = this.sessionToPlayer.get(client.sessionId);
        const slot = playerId !== undefined ? this.playerToSlot.get(playerId) : undefined;
        let inInterest: Set<number> | undefined;
        if (slot !== undefined) {
          const b = slotBase(slot);
          const sx = this.sabF32[b + SLOT_X_OFF]!;
          const sy = this.sabF32[b + SLOT_Y_OFF]!;
          const { cx, cy } = this.interestGrid.cellOf(sx, sy);
          let scratch = this.interestScratch.get(client.sessionId);
          if (!scratch) {
            scratch = new Set<number>();
            this.interestScratch.set(client.sessionId, scratch);
          }
          this.interestGrid.query9(cx, cy, scratch);
          inInterest = scratch;
        }
        const swarmPacket = this.swarmEncoder.encode(this.swarmRegistry, this.sabF32, this.sabU32, this.serverTick, inInterest);
        if (swarmPacket) client.send('swarm', swarmPacket);
      }
    }
    phaseTime('swarmEncode');
    phaseTime('swarmBroadcast');

    // Stage 5 — sector idle tracking. Updated every tick from motion +
    // projectile-in-flight signals; when no activity in IDLE_THRESHOLD_TICKS
    // (= 1 s at 60 Hz), the snapshot broadcast block short-circuits.
    if (this.liveProjectiles.size > 0) {
      noteSectorEvent(this.idleTracker, this.serverTick);
    } else {
      for (const [, pose] of this.shipPoseCache) {
        const speedSq = pose.vx * pose.vx + pose.vy * pose.vy;
        if (speedSq > IDLE_MOTION_EPSILON_SQ) {
          noteSectorEvent(this.idleTracker, this.serverTick);
          break;
        }
        if (Math.abs(pose.angvel ?? 0) > 0.05) {
          noteSectorEvent(this.idleTracker, this.serverTick);
          break;
        }
      }
    }
    // A freshly-joined client needs a steady snapshot stream to
    // reconcile its prediction before idle-suppression can quiet the
    // sector. `forceBroadcastUntilTick` is set on every join/spawn;
    // while the current tick is inside that window the sector is
    // treated as non-idle regardless of motion. See
    // JOIN_BROADCAST_GRACE_TICKS for the full rationale.
    const inJoinGrace = this.serverTick < this.forceBroadcastUntilTick;
    const sectorIdle =
      !inJoinGrace &&
      isSectorIdle(this.idleTracker, this.serverTick, IDLE_THRESHOLD_TICKS);

    // Stage 5 (post-hotfix #4) — per-client phase-staggered snapshot broadcast.
    //
    // Pre-Stage-5: every 3rd update() the room built one snapshot containing
    // every alive ship and broadcast it to every client.
    //
    // Stage 5 (initial): introduced two cadences (close-tier 30 Hz at
    // every 2 broadcastCounter ticks, far-tier 20 Hz at every 3) and
    // sent on the union — `closeFires || farFires`. That produced
    // irregular 17/17/33/33 ms intervals at the recipient, which broke
    // the reconciler's lerp (built around a clean ~50 ms cadence) and
    // caused visible stutter (see `docs/LESSONS.md` 2026-05-08 hotfix #4).
    //
    // Stage 5 (post-hotfix #4): single 20 Hz cadence — `shouldBroadcastFar`
    // only. Tier classification is no longer used for inclusion (every
    // alive ship is in every fired snapshot, same as pre-Stage-5). The
    // gains kept from Stage 5: phase staggering (each recipient's
    // farOffset hashed from playerId, smoothing server CPU spikes since
    // recipients almost never peak on the same tick); idle suppression
    // after 60 ticks of no sector activity; lastInput omission when the
    // bits match the per-recipient cache. The 30 Hz close-tier idea is
    // shelved until a single-cadence design with selective tier inclusion
    // can be tested end-to-end.
    //
    // Scheduling tick is `broadcastCounter` (incremented once per update()),
    // NOT `serverTick` (read from SAB). The worker's SAB tick can advance
    // by 1, 2, or 3 between successive update() calls when the two 60 Hz
    // loops drift; using SAB tick % 3 for scheduling caused ~25% missed
    // broadcasts pre-Phase-3. See `docs/LESSONS.md`. broadcastCounter is
    // purely main-thread and so is monotonic with update() calls.
    this.broadcastCounter++;
    if (this.serverTick > 0 && !sectorIdle) {
      // Build the global "all alive ships" digest once — same data for every
      // recipient, just the inclusion decision differs per (recipient, ship).
      type AllShipEntry = {
        playerId: string;
        // Phase 6a — outer wire key. Falls back to playerId for any ship
        // missing a shipInstanceId (shouldn't happen post-synthetic-UUID
        // step, but defensive).
        shipInstanceId: string;
        // Phase 6a — true for any ship in 6a (one active hull per player
        // is invariant). Phase 6b will surface lingering hulls with false.
        isActive: boolean;
        pose: ShipPhysicsState;
        lastInput: ShipInputBits;
      };
      const allShips: AllShipEntry[] = [];
      const ackedTicksTelemetry: Record<string, number> = {};
      const aliveIds = new Set<string>();
      for (const [playerId, slot] of this.playerToSlot) {
        const ship = this.getActiveShip(playerId);
        if (!ship || !ship.alive) continue;
        const pose = this.shipPoseCache.get(playerId);
        if (!pose) continue;
        // Stage 3 — read the worker's last-applied input bits out of SAB
        // FLAGS so remote clients can forward-predict this ship. Bits 3–7
        // of the FLAGS u32; sleeping/swarm bits 0–2 are masked off.
        const flags = this.sabU32[slotBase(slot) + SLOT_FLAGS_OFF] ?? 0;
        allShips.push({
          playerId,
          shipInstanceId: ship.shipInstanceId !== '' ? ship.shipInstanceId : playerId,
          isActive: ship.isActive,
          pose,
          lastInput: {
            thrust:    !!(flags & FLAG_INPUT_THRUST),
            turnLeft:  !!(flags & FLAG_INPUT_TURN_LEFT),
            turnRight: !!(flags & FLAG_INPUT_TURN_RIGHT),
            boost:     !!(flags & FLAG_INPUT_BOOST),
            reverse:   !!(flags & FLAG_INPUT_REVERSE),
          },
        });
        aliveIds.add(playerId);
        ackedTicksTelemetry[playerId] = this.sabAppliedTicks.get(playerId) ?? 0;
      }
      // Phase 6b — append lingering hulls to allShips. These have no
      // active player driving them; their pose comes from
      // lingeringPoseCache, their owner from state.ships entry's
      // playerId field, and isActive=false. lastInput is all-false
      // (the worker doesn't apply input to lingering hulls). They get
      // included in every recipient's snapshot the same way active
      // hulls do, so clients see them drifting in the sector.
      for (const [shipInstanceId, _slot] of this.lingeringSlots) {
        const ship = this.state.ships.get(shipInstanceId);
        if (!ship || !ship.alive) continue;
        const pose = this.lingeringPoseCache.get(shipInstanceId);
        if (!pose) continue;
        allShips.push({
          playerId: ship.playerId,
          shipInstanceId,
          isActive: false,
          pose,
          lastInput: {
            thrust: false, turnLeft: false, turnRight: false,
            boost: false, reverse: false,
          },
        });
      }

      // Boosting/thrusting filter — small lists, sent in every snapshot.
      const boostingIds: string[] = [];
      for (const id of this.boostingPlayers) {
        if (aliveIds.has(id)) boostingIds.push(id);
      }
      const thrustingIds: string[] = [];
      for (const id of this.thrustingPlayers) {
        if (aliveIds.has(id)) thrustingIds.push(id);
      }
      const sharedTail: { boostingIds?: string[]; thrustingIds?: string[] } = {};
      if (boostingIds.length > 0) sharedTail.boostingIds = boostingIds;
      if (thrustingIds.length > 0) sharedTail.thrustingIds = thrustingIds;

      // 3×3 cell window radius for projectile interest (unchanged from
      // pre-Stage-5).
      const interestRadius = CELL_SIZE * 1.5;
      let anySnapshotSent = false;

      for (const client of this.clients) {
        const bp = checkBackpressure(client, logger);
        if (bp === 'close') { client.leave(4002); continue; }
        if (bp === 'drop') continue;

        const recipientPlayerId = this.sessionToPlayer.get(client.sessionId);
        if (!recipientPlayerId) continue;

        // Stage 5 (post-hotfix #4) — single 20 Hz cadence with per-client
        // phase offset hashed from playerId. Two recipients with different
        // offsets almost never fire on the same tick, smoothing CPU spikes,
        // but each individual recipient sees a clean 50 ms interval at 20 Hz.
        if (!shouldBroadcastFar(this.broadcastCounter, recipientPlayerId)) continue;

        const recipientPose = this.shipPoseCache.get(recipientPlayerId);
        if (!recipientPose) continue;

        let lastInputCache = this.lastInputCaches.get(client.sessionId);
        if (!lastInputCache) {
          lastInputCache = createLastInputCache();
          this.lastInputCaches.set(client.sessionId, lastInputCache);
        }

        // Build per-recipient states map. Every alive ship is included
        // (no tier-based filtering — single-cadence design); per-recipient
        // lastInput omission still applies to save bytes on idle ships.
        const states: SnapshotMessage['states'] = {};
        for (const ship of allShips) {
          const includeLastInput = shouldIncludeLastInput(lastInputCache, ship.playerId, ship.lastInput);
          // Phase 4b.3 — per-mount rotation angles, included only when the
          // ship has rotating mounts (legacy fighter/scout/heavy stays
          // null and the field is omitted from the wire, no byte cost).
          // Each entry is the arc-local slewed angle for the mount at
          // that index in the ship-kind's catalogue. The client renders
          // every observer's turrets at these angles and reseeds its
          // own predicted angles when a snapshot lands.
          const angles = this.playerMountAngles.get(ship.playerId);
          let mountAnglesArr: number[] | undefined;
          if (angles && angles.length > 0) {
            let anyNonZero = false;
            for (let i = 0; i < angles.length; i++) {
              if (angles[i] !== 0) { anyNonZero = true; break; }
            }
            if (anyNonZero) {
              mountAnglesArr = new Array<number>(angles.length);
              for (let i = 0; i < angles.length; i++) {
                // Quantise to 4 decimal places (~0.006° resolution) to
                // dedupe trailing-noise drift across the wire — the JSON
                // serialiser compresses repeats of the same number better
                // and the visible quality is identical at typical zoom.
                mountAnglesArr[i] = Math.round(angles[i]! * 10_000) / 10_000;
              }
            }
          }
          // Phase 6a wire key: shipInstanceId. Each entry carries
          // playerId (for owner identity) and isActive (for the
          // client's visibility / piloting gate). Other entry fields
          // unchanged from pre-6a snapshots.
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
        if (this.liveProjectiles.size > 0) {
          for (const [projId, proj] of this.liveProjectiles) {
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
        // pivot, 2026-05-18). Drone POSE is NO LONGER on the JSON snapshot —
        // it flows exclusively on the binary swarm channel and the client
        // renders it via time-based `interpolateSwarmPose` (no client AI
        // re-sim, no predWorld reconcile anchor). For every drone in this
        // recipient's 9-cell interest window we emit ONLY the non-pose
        // fields that ride JSON: per-mount turret angles + the shield-down
        // flag, and ONLY when there is something to carry (no `{ id }`-only
        // entries — they would just be wasted bytes).
        //
        // Reuse the `interestScratch` Set populated by the swarm-broadcast
        // block earlier in this `update()` — same per-(client, tick) cell
        // window, no second `query9` call. Asteroids (kind === 0) are
        // skipped — they have no turret/shield. The binary channel still
        // carries every in-interest drone's pose at full cadence.
        let drones: SnapshotMessage['drones'];
        const interest = this.interestScratch.get(client.sessionId);
        if (interest && interest.size > 0) {
          for (const eid of interest) {
            const rec = this.swarmRegistry.getByEntityId(eid);
            if (!rec || rec.kind !== 1) continue;
            // Phase 4c — per-drone mount angles for in-interest drones
            // whose ship-kind has rotating mounts. Only emitted when at
            // least one angle is non-zero (quantised to dedupe trailing
            // noise), same gate as the player snapshot path. Out-of-
            // interest drones never reach this branch, so their turrets
            // render at baseAngle on the client until they re-enter
            // interest and the next snapshot updates them.
            const droneAngles = this.droneMountAngles.get(rec.id);
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
        // interest filtering: the wreck count per sector is bounded
        // (one per abandoned ship; players are 10-capped) and Phase 5
        // can add interest culling if rosters grow.
        let wrecks: SnapshotMessage['wrecks'];
        if (this.wreckPoseCache.size > 0) {
          wrecks = [];
          for (const [shipInstanceId, pose] of this.wreckPoseCache) {
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
          serverTick: this.serverTick,
          states,
          ackedTick: recipientAcked,
          ...sharedTail,
          ...(projectiles ? { projectiles } : {}),
          ...(drones ? { drones } : {}),
          ...(wrecks ? { wrecks } : {}),
        };
        client.send('snapshot', snap);
        anySnapshotSent = true;
      }

      // Snapshot-broadcast log: gate to ~20 Hz (every 3rd tick) to preserve
      // pre-Stage-5 log volume even though the actual broadcast is per-client.
      if (anySnapshotSent && this.broadcastCounter % 3 === 0) {
        serverLogEvent('snapshot_broadcast', {
          serverTick: this.serverTick,
          playerCount: this.playerToSlot.size,
          ackedTicks: ackedTicksTelemetry,
          states: Object.fromEntries(
            allShips.map((s) => [s.playerId, {
              x: parseFloat(s.pose.x.toFixed(3)),
              y: parseFloat(s.pose.y.toFixed(3)),
              vx: parseFloat(s.pose.vx.toFixed(3)),
              vy: parseFloat(s.pose.vy.toFixed(3)),
            }]),
          ),
        });
      }
    }
    phaseTime('snapshotBroadcast');

    // Tick AI behaviours AT THE END of update() so impulses posted now reach
    // the worker BEFORE the next SAB read. Defect 1 (5c-stabilise plan): if
    // AI ticks before the encoder reads SAB in the same update() call, the
    // intent is still in-flight and the encoder broadcasts a pose that
    // doesn't include this tick's impulse — observed as drone stutter.
    // View is rebuilt in-place each tick to avoid alloc.
    if (this.aiController.size() > 0) {
      this.aiPlayerScratch.length = 0;
      for (const [pid] of this.playerToSlot) {
        const ship = this.getActiveShip(pid);
        if (!ship?.alive) continue;
        // Phase 6c — drones only see active hulls. Lingering hulls
        // (isActive === false during the 15-min disconnect linger
        // window) are skipped here so the AI never targets them.
        // The matching gate on the client side is in
        // `ColyseusClient.ts`'s AI view construction (Input Symmetry
        // Rule, `src/core/CLAUDE.md`). Lock test:
        // `tests/integration/sectorRoom/droneTargetActiveOnly.test.ts`.
        if (!ship.isActive) continue;
        const pose = this.shipPoseCache.get(pid);
        if (!pose) continue;
        this.aiPlayerScratch.push({ id: pid, x: pose.x, y: pose.y, vx: pose.vx, vy: pose.vy });
      }
      this.aiController.tick(this.serverTick, 1 / 60, this.aiPlayerScratch, (id) => this.swarmEntitySnapshot(id));
      phaseTime('aiTick');

      const fires = this.aiController.drainFireRequests();
      for (const f of fires) this.handleAiFire(f.shooterId, f.dirX, f.dirY, f.tick);
      phaseTime('aiFire');
    }

    // Phase 4b.3 — server-authoritative turret rotation for player ships.
    // Mirrors the client's `tickLocalMountAim` so the server's hit-test
    // geometry uses the same rotated mount angles the client renders, and
    // so remote observers receive each ship's authoritative mount angles
    // through the snapshot extension below.
    this.tickPlayerMounts();
    phaseTime('playerMounts');

    // Phase 4c (2026-05-11) — server-authoritative turret rotation for
    // drones with rotating mounts. Same lockstep model as players: server
    // computes the per-mount slewed angle each tick; the snapshot's
    // `drones[]` slice ships authoritative angles to in-interest clients;
    // `handleAiFire` uses the current mount angles for ray geometry, so a
    // drone's tracked beam actually lands where the visible barrel points.
    this.tickDroneMounts();
    phaseTime('droneMounts');

    // Tick-budget telemetry. Cumulative phase totals across the last ~60 ticks
    // are emitted as one server event per second. The first capture told us
    // server tick rate was 46 Hz instead of 60 — this breakdown will tell us
    // which phase ate the budget so the fix is targeted, not speculative.
    const totalMs = performance.now() - tStart;
    this.tickBudgetSums['total'] = (this.tickBudgetSums['total'] ?? 0) + totalMs;
    this.tickBudgetSampleCount++;
    if (totalMs > this.tickBudgetMaxTotalMs) this.tickBudgetMaxTotalMs = totalMs;
    if (totalMs > 16.67) this.tickBudgetOverBudgetCount++;

    // Hot-capture per-tick hitches. The aggregated `tick_budget` log emits
    // an AVERAGE every 60 ticks, which buries individual tick spikes inside
    // the mean. A 26 ms spike disappears inside an `avgMs.total = 0.045`
    // line. The user-perceived "stuttering" diagnosed in the 2026-05-08
    // captures traced back to single ticks in the 25–30 ms range causing
    // 13 u correction snaps and 10-snapshot cascades. This branch fires a
    // dedicated `tick_hitch` event with per-phase breakdown PLUS context
    // from the previous 3 ticks, so the next diagnostic identifies the
    // culprit subsystem directly. Rate-limited to avoid flood during
    // sustained pathology.
    const nowMs = performance.now();
    if (
      totalMs > SectorRoom.TICK_HITCH_THRESHOLD_MS &&
      nowMs - this.lastTickHitchAtMs >= SectorRoom.TICK_HITCH_MIN_INTERVAL_MS
    ) {
      this.lastTickHitchAtMs = nowMs;
      const phasesSnapshot: Record<string, number> = {};
      for (const k of Object.keys(this.thisTickPhases)) {
        phasesSnapshot[k] = parseFloat((this.thisTickPhases[k] ?? 0).toFixed(3));
      }
      phasesSnapshot['total'] = parseFloat(totalMs.toFixed(3));
      const workerTickMsForHitch = (this.sabU32[WORKER_TICK_US_IDX] ?? 0) / 1000;
      serverLogEvent('tick_hitch', {
        serverTick: this.serverTick,
        totalMs: parseFloat(totalMs.toFixed(3)),
        phases: phasesSnapshot,
        recentTicks: this.tickHistoryRing.slice(),
        workerTickMs: parseFloat(workerTickMsForHitch.toFixed(3)),
        playerCount: this.playerToSlot.size,
        swarmCount: this.swarmRegistry.size(),
        aiSize: this.aiController.size(),
        liveProjectileCount: this.liveProjectiles.size,
      });
    }
    // Maintain the rolling 3-tick history regardless of hitch — context for
    // the next hitch event.
    this.tickHistoryRing.push({
      tick: this.serverTick,
      totalMs: parseFloat(totalMs.toFixed(3)),
      phases: { ...this.thisTickPhases },
    });
    if (this.tickHistoryRing.length > 3) this.tickHistoryRing.shift();

    // Phase 6 — drive the TiDi clock from whichever side is the bottleneck.
    // The server's `update()` time covers SAB-read / encode / broadcast; the
    // worker's most-recent step duration covers physics. The real budget
    // overrun is whichever is longer. Without this, a worker that's grinding
    // at 50 ms/tick goes undetected because the server thread reads the SAB
    // in <1 ms and reports a healthy budget.
    const workerTickMs = (this.sabU32[WORKER_TICK_US_IDX] ?? 0) / 1000;
    const busiestMs = Math.max(totalMs, workerTickMs);
    this.simClock.report(busiestMs);
    const newRate = this.simClock.rate;
    if (Math.abs(newRate - this.lastSentClockRate) >= 1e-4) {
      this.lastSentClockRate = newRate;
      this.state.clockRate = newRate;
      this.postToWorker({ type: 'CLOCK_RATE', rate: newRate });
    }
    // Phase 6 second-lever: if rate is at floor and we're still over budget,
    // shed far drones in batches. No-op when rate > 0.71 or budget healthy.
    this.shedder.consider(newRate, busiestMs);
    if (this.tickBudgetSampleCount >= 60) {
      const avg: Record<string, number> = {};
      for (const k of Object.keys(this.tickBudgetSums)) {
        avg[k] = parseFloat((this.tickBudgetSums[k]! / this.tickBudgetSampleCount).toFixed(3));
      }
      serverLogEvent('tick_budget', {
        serverTick: this.serverTick,
        sampleCount: this.tickBudgetSampleCount,
        avgMs: avg,
        maxTotalMs: parseFloat(this.tickBudgetMaxTotalMs.toFixed(3)),
        overBudgetCount: this.tickBudgetOverBudgetCount,
        playerCount: this.playerToSlot.size,
        swarmCount: this.swarmRegistry.size(),
        aiSize: this.aiController.size(),
      });
      for (const k of Object.keys(this.tickBudgetSums)) this.tickBudgetSums[k] = 0;
      this.tickBudgetSampleCount = 0;
      this.tickBudgetMaxTotalMs = 0;
      this.tickBudgetOverBudgetCount = 0;
    }
  }
}
