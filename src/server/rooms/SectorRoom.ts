import { Room, Client } from 'colyseus';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { bundleWorker } from '../workers/bundleWorker.js';
import { pino } from 'pino';
import { Bus } from '../../core/events/Bus.js';
import { SimulationClock } from '../../core/clock/SimulationClock.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { SectorState, ShipState } from './schema/SectorState.js';
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
import type { AiPlayerView, AiEntity } from '../../core/contracts/IAiBehaviour.js';
import { assignPlayerId } from '../identity/PlayerIdentity.js';
import { InputMessageSchema, FireMessageSchema } from '../../shared-types/messages.js';
import type { WelcomeMessage, SnapshotMessage, HitAckMessage, DamageEvent, DestroyEvent, LaserFiredEvent, RespawnAckMessage } from '../../shared-types/messages.js';
import { DEFAULT_SHIP_KIND, getShipKind, isShipKindId } from '../../shared-types/shipKinds.js';

/** Resolve a (possibly missing) ship-kind id to the kind's max health, or
 *  null when the id is unknown. Drones use this on spawn so each kind has
 *  its own hull pool. */
function getDroneMaxHealth(kindId: string | undefined): number | null {
  if (!kindId) return null;
  return getShipKind(kindId).maxHealth;
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
import { getLimboStore } from '../db/PersistenceWorker.js';
import { LIMBO_DISCONNECT_TTL_MS, type LimboPayload } from '../limbo/LimboStore.js';
import { TransitOrchestrator } from '../transit/TransitOrchestrator.js';
import { setSession, clearSession } from '../transit/sessionRegistry.js';
import { EngageTransitSchema, CancelTransitSchema } from '../../shared-types/messages.js';
import {
  rayHitsSphere,
  rayHitsConvexPolygon,
  projectileSweepCircle,
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
    /** Player-chosen ship kind id (e.g. 'scout' | 'fighter' | 'heavy').
     *  Validated against `isShipKindId` in `onJoin`; unknown / missing values
     *  fall back to `DEFAULT_SHIP_KIND`. Ignored on Limbo rebind paths so a
     *  bad-actor client cannot mid-session swap kind. */
    shipKind: z.string().optional(),
  })
  .passthrough();

const MAX_INPUTS_PER_TICK = 3;
const LAG_COMP_WINDOW = 12;

/** Stage 5 — sector idle threshold. After this many ticks without any
 *  motion-above-epsilon or projectile-in-flight event, the room
 *  suppresses snapshot broadcasts entirely. 60 ticks = 1 second at
 *  60 Hz physics. */
const IDLE_THRESHOLD_TICKS = 60;

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
  | { type: 'INPUT';          slot: number; inputTick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean }
  | { type: 'SPAWN_OBSTACLE'; slot: number; obstacleId: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number; vertices?: ReadonlyArray<Vec2> }
  | { type: 'AI_INTENT';      slot: number; fx: number; fy: number; torque: number }
  | { type: 'CLOCK_RATE';     rate: number }
  | { type: 'SET_POSITION';   entityId: string; x: number; y: number; angle: number; vx: number; vy: number; angvel: number };

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
  /** Phase 8 sub-phase B (lingering ships) — playerIds whose owners have
   *  disconnected from a galaxy room but whose ships remain in the live
   *  simulation. The ship keeps its SAB slot, ShipState entry, and physics
   *  body; the worker continues stepping it (drag decays vx/vy/angvel, so
   *  it drifts to a stop). Reconnect within the TTL re-binds the new
   *  session to the existing ship (live pose, not the snapshot). On TTL
   *  expiry the ship is fully evicted. Maps to the eviction setTimeout. */
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
      postIntent: (slot, fx, fy, torque) => {
        this.postToWorker({ type: 'AI_INTENT', slot, fx, fy, torque });
      },
    });

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
    this.transitOrchestrator = new TransitOrchestrator(this.asTransitHost(), getLimboStore());

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
      const killerUser = this.playerToUser.get(evt.shooterId) ?? null;
      const victimUser = this.playerToUser.get(evt.targetId) ?? null;
      recordKill(killerUser, victimUser, 'hitscan', this.sectorKey ?? this.roomId);
      // Phase 8 sub-phase B (lingering ships) — if a player's ship was
      // destroyed while they were offline, evict immediately. Skipping the
      // 5-min wait keeps the room cleaner and lets the player fresh-spawn
      // from the galaxy map (no stale active-Limbo gate).
      if (this.ownerlessShips.has(evt.targetId)) {
        this.evictOwnerlessShip(evt.targetId);
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

  // ── Combat ──────────────────────────────────────────────────────────────

  private handleFire(client: Client, raw: unknown): void {
    const parsed = FireMessageSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ sessionId: client.sessionId }, 'malformed fire message');
      return;
    }
    const { tick, clientShotId, weapon, dirAngle } = parsed.data;

    const shooterId = this.sessionToPlayer.get(client.sessionId);
    if (!shooterId) return;

    const ship = this.state.ships.get(shooterId);
    if (!ship || !ship.alive) return;

    // Temporal plausibility: reject claims older than LAG_COMP_WINDOW ticks (~200 ms).
    if (this.serverTick - tick > LAG_COMP_WINDOW) {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false, rejected: true };
      client.send('hit_ack', ack);
      return;
    }

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
    // `dirAngle`. The ray is reconstructed from the shooter's lag-compensated
    // pose at `tick` plus the standard 20u barrel offset. SnapshotRing pose
    // is preferred (matches what the client predicted); shipPoseCache is the
    // fallback for ticks outside the lag-comp window (rare, since temporal
    // plausibility above already rejects anything beyond 12 ticks).
    const ndx = -Math.sin(dirAngle);
    const ndy = Math.cos(dirAngle);
    const rewoundShooter = this.snapshotRing.getPoseAt(shooterId, tick);
    const fallbackShooter = this.shipPoseCache.get(shooterId);
    const sx = rewoundShooter?.x ?? fallbackShooter?.x;
    const sy = rewoundShooter?.y ?? fallbackShooter?.y;
    if (sx === undefined || sy === undefined) return;
    const shooterVx = rewoundShooter?.vx ?? fallbackShooter?.vx ?? 0;
    const shooterVy = rewoundShooter?.vy ?? fallbackShooter?.vy ?? 0;
    const rayFromX = sx + ndx * 20;
    const rayFromY = sy + ndy * 20;

    // Diagnostic — captures the server's view of where the shooter was
    // when the fire happened. Cross-reference with the client-side `fire`
    // log (in `ColyseusClient.sendFire`) to localise any divergence
    // between (a) where the client thinks it fired (predWorld), (b)
    // where it rendered itself firing (mirror = predWorld + lerpOffset),
    // and (c) where the server lag-comp resolved the ray (rewoundShooter).
    serverLogEvent('fire_received', {
      shooterId,
      clientTick: tick,
      serverTick: this.serverTick,
      tickDelta: this.serverTick - tick,
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

    const weaponId: WeaponId = isWeaponId(weapon) ? weapon : 'hitscan';
    const weaponDef = getWeapon(weaponId);

    if (weaponDef.mode === 'projectile') {
      const projDef = weaponDef as ProjectileWeaponDef;
      this.spawnServerProjectile(shooterId, rayFromX, rayFromY, shooterVx + ndx * projDef.speed, shooterVy + ndy * projDef.speed, projDef.damage, projDef.radius, projDef.maxTicks, weaponId);
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false };
      client.send('hit_ack', ack);
      return;
    }

    // Hitscan: lag-comp check against rewound positions of all other ships.
    const hitscanDef = weaponDef as HitscanWeaponDef;
    let hitId: string | null = null;
    let hitDist = Infinity;
    let hitIsObstacle = false;

    for (const [targetId] of this.playerToSlot) {
      if (targetId === shooterId) continue;
      const targetShip = this.state.ships.get(targetId);
      if (!targetShip || !targetShip.alive) continue;

      // Use rewound pose if available; fall back to current position. Ships
      // are still circles, so angle is irrelevant for the hit-test, but the
      // ring's API returns it uniformly for any future polygon-shaped ship.
      const rewound = this.snapshotRing.getPoseAt(targetId, tick);
      const fallback = this.shipPoseCache.get(targetId);
      const cx = rewound?.x ?? fallback?.x;
      const cy = rewound?.y ?? fallback?.y;
      if (cx === undefined || cy === undefined) continue;

      const dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, hitscanDef.range, cx, cy, SHIP_COLLISION_RADIUS);
      if (dist !== null && dist < hitDist) {
        hitDist = dist;
        hitId = targetId;
        hitIsObstacle = false;
      }
    }

    // Check swarm entities (asteroids, drones) lag-compensated against the
    // shooter's tick. Asteroids (kind=0) with vertices use the polygon-aware
    // hit test so the silhouette — not the bounding circle — decides hits.
    // Drones (kind=1) and any asteroid that somehow lacks vertices fall back
    // to the sphere test against rec.radius. Per-entity rewound pose is the
    // single source of truth; SAB-current is the fallback for ticks outside
    // the ring window.
    for (const rec of this.swarmRegistry.all()) {
      const rewound = this.snapshotRing.getPoseAt(rec.id, tick);
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
      if (dist !== null && dist < hitDist) {
        hitDist = dist;
        hitId = rec.id;
        hitIsObstacle = true;
      }
    }

    // Resolve the wire-side target id. Player hits send raw playerId; swarm
    // hits send `swarm-${entityId}` so the client renderer can match against
    // its `mirror.swarm` keying convention. The server still uses `hitId` (the
    // registry's string id) internally for damage routing and lag-comp.
    let wireTargetId: string | undefined = hitId ?? undefined;
    if (hitId && hitIsObstacle) {
      const rec = this.swarmRegistry.get(hitId);
      if (rec) wireTargetId = `swarm-${rec.entityId}`;
    }

    if (hitId) {
      // Sampled LASER_FIRED log at 1 %.
      if (Math.random() < 0.01) {
        logger.info({ shooterId, hitId, hitIsObstacle }, 'LASER_FIRED (1% sample)');
      }
      // applyDamage routes by id type: player ship → existing damage path,
      // swarm entity (drone with health) → swarm damage path. Asteroids (no
      // swarmHealth entry) are no-ops; the hit still rings client-side via
      // the `laser_fired` broadcast and the wireTargetId tint.
      const hitX = rayFromX + ndx * hitDist;
      const hitY = rayFromY + ndy * hitDist;
      this.applyDamage(hitId, shooterId, hitscanDef.damage, hitX, hitY);
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: true, targetId: hitId };
      client.send('hit_ack', ack);
    } else {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false };
      client.send('hit_ack', ack);
    }

    // Broadcast authoritative beam endpoint to ALL clients so they can render it.
    const beamEndX = rayFromX + ndx * (hitDist === Infinity ? hitscanDef.range : hitDist);
    const beamEndY = rayFromY + ndy * (hitDist === Infinity ? hitscanDef.range : hitDist);
    this.broadcast('laser_fired', {
      type: 'laser_fired',
      shooterId,
      fromX: rayFromX,
      fromY: rayFromY,
      toX: beamEndX,
      toY: beamEndY,
      hit: !!hitId,
      targetId: wireTargetId,
    } satisfies LaserFiredEvent);
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
    const ndx = dirX / len;
    const ndy = dirY / len;

    // Drone fires from its own pose, offset 16u along the firing direction so
    // it doesn't self-hit on the next-tick ray.
    const self = this.swarmEntitySnapshot(shooterId);
    if (!self) return;
    const rayFromX = self.x + ndx * 16;
    const rayFromY = self.y + ndy * 16;

    // Hitscan against all alive ships (no lag-comp — drones fire at current tick).
    let hitId: string | null = null;
    let hitDist = Infinity;
    for (const [targetId] of this.playerToSlot) {
      const targetShip = this.state.ships.get(targetId);
      if (!targetShip || !targetShip.alive) continue;
      const pose = this.shipPoseCache.get(targetId);
      if (!pose) continue;
      const dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, HITSCAN_RANGE, pose.x, pose.y, SHIP_COLLISION_RADIUS);
      if (dist !== null && dist < hitDist) { hitDist = dist; hitId = targetId; }
    }

    if (hitId) {
      this.applyDamage(hitId, shooterId, HITSCAN_DAMAGE);
    }

    const beamEndX = rayFromX + ndx * (hitDist === Infinity ? HITSCAN_RANGE : hitDist);
    const beamEndY = rayFromY + ndy * (hitDist === Infinity ? HITSCAN_RANGE : hitDist);

    // Wire shooterId for AI shooters uses the swarm-${entityId} convention so
    // the client can look the firing drone up in mirror.swarm and re-derive
    // the beam origin from its current pose each frame (see PixiRenderer for
    // the player-beam parallel). Bare `drone-N` would leave the client unable
    // to map the shooter to a swarm entry.
    const shooterRec = this.swarmRegistry.get(shooterId);
    const wireShooterId = shooterRec ? `swarm-${shooterRec.entityId}` : shooterId;

    this.broadcast('laser_fired', {
      type: 'laser_fired',
      shooterId: wireShooterId,
      fromX: rayFromX,
      fromY: rayFromY,
      toX: beamEndX,
      toY: beamEndY,
      hit: !!hitId,
      targetId: hitId ?? undefined,
    } satisfies LaserFiredEvent);
  }

  private spawnServerProjectile(ownerId: string, x: number, y: number, vx: number, vy: number, damage: number, radius: number, maxTicks: number, weaponId: WeaponId): void {
    const projId = `proj-${this.projectileCounter++}`;
    this.liveProjectiles.set(projId, { x, y, vx, vy, ownerId, birthTick: this.serverTick, damage, radius, maxTicks, weaponId });
    // Wire-discipline P3: projectiles no longer ride MapSchema. Per-recipient
    // interest-filtered list is folded into the snapshot in the broadcast loop.
  }

  private applyDamage(targetId: string, shooterId: string, damage: number, hitX?: number, hitY?: number): void {
    const ship = this.state.ships.get(targetId);
    if (ship) {
      if (!ship.alive) return;
      ship.health = Math.max(0, ship.health - damage);

      const pose = this.shipPoseCache.get(targetId);
      const dmgEvent: DamageEvent = {
        type: 'damage',
        targetId,
        damage,
        newHealth: ship.health,
        shooterId,
        hitX: hitX ?? pose?.x,
        hitY: hitY ?? pose?.y,
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
    const currentHealth = this.swarmHealth.get(targetId);
    if (currentHealth === undefined) return; // immune (asteroid)

    const newHealth = Math.max(0, currentHealth - damage);
    this.swarmHealth.set(targetId, newHealth);

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
    for (const [playerId, ship] of this.state.ships) {
      if (!ship.alive) continue;
      const pose = this.shipPoseCache.get(playerId);
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
    this.snapshotRing.unregisterEntity(rec.id);
    this.freeSlots.push(rec.slot);
    if (opts.broadcast) {
      logger.info({ targetId: rec.id, shooterId: opts.shooterId }, 'drone destroyed');
    }
  }

  private handleRespawn(client: Client): void {
    const playerId = this.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;

    const ship = this.state.ships.get(playerId);
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

    const currentServerTick = Atomics.load(this.sabU32, TICK_IDX);
    const ack: RespawnAckMessage = { type: 'respawn_ack', x: spawnX, y: spawnY, serverTick: currentServerTick };
    client.send('respawn_ack', ack);

    logger.info({ playerId, spawnX, spawnY }, 'player respawned');
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
        const targetShip = this.state.ships.get(targetId);
        if (!targetShip || !targetShip.alive) continue;
        const targetPose = this.shipPoseCache.get(targetId);
        if (!targetPose) continue;
        const sweep = projectileSweepCircle(proj.x, proj.y, stepX, stepY, proj.radius, targetPose.x, targetPose.y, SHIP_COLLISION_RADIUS);
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
        if (msg.type === 'CONTACT_BATCH' && Array.isArray(msg.contacts) && typeof msg.tick === 'number') {
          // Stage 2 of the network-feel roadmap: each contact above the
          // worker's CONTACT_FORCE_FLOOR is broadcast to all clients in the
          // room as `collision_resolved`. AOI filter is deferred — the
          // typical 1–4 player room's per-tick contact volume is low, and
          // the client's `applyCollisionResolved` already silently no-ops
          // on bodies its predWorld doesn't track (drone-vs-drone events).
          // Bus emission lets persistence/telemetry subscribe.
          for (const c of msg.contacts) {
            this.bus.emit('COLLISION_RESOLVED', {
              type: 'COLLISION_RESOLVED',
              aId: c.aId,
              bId: c.bId,
              vA: { x: c.vAxPost, y: c.vAyPost },
              vB: { x: c.vBxPost, y: c.vByPost },
              impulse: c.forceMagnitude,
              tick: msg.tick,
            });
            this.broadcast('collision_resolved', {
              type: 'collision_resolved',
              aId: c.aId,
              bId: c.bId,
              vA: { x: c.vAxPost, y: c.vAyPost },
              vB: { x: c.vBxPost, y: c.vByPost },
              impulse: c.forceMagnitude,
              tick: msg.tick,
            });
            // Diag-stream the contact so we can correlate combat-phase
            // correction bursts with physics-side collisions. Added
            // 2026-05-09 to confirm/reject the hypothesis that drone-vs-
            // player contacts are the source of the ~10–22 u drift events
            // seen in combat captures (e.g. cap 09-54-45-849Z-8grdi1).
            // Logged at full fidelity — typical 1-4 player rooms produce
            // sub-100 contacts per second so the 500-entry ring buffer
            // is fine. Only the local player's contacts are visible
            // post-aggregation if `aId`/`bId` filtering is needed.
            serverLogEvent('collision_resolved', {
              aId: c.aId,
              bId: c.bId,
              impulse: parseFloat(c.forceMagnitude.toFixed(3)),
              tick: msg.tick,
            });
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
    const ownerlessTimer = this.ownerlessShips.get(playerId);
    if (this.sectorKey !== null && ownerlessTimer !== undefined) {
      clearTimeout(ownerlessTimer);
      this.ownerlessShips.delete(playerId);
      const existingSlot = this.playerToSlot.get(playerId);
      const existingShip = this.state.ships.get(playerId);
      if (existingSlot !== undefined && existingShip) {
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
    /** Kind to spawn with. Defaults to the requested kind; Limbo overrides. */
    let chosenKind: string = requestedKind;

    // Phase 8 sub-phase B — Limbo restore. Only galaxy rooms participate
    // in Limbo; engineering rooms continue to fresh-spawn on every join.
    // The destination's `onJoin` consumes the entry whether it was created
    // by a disconnect (5 min TTL) or by a transit commit (30 s TTL); the
    // sectorKey gate ensures we only consume entries destined for THIS room.
    if (this.sectorKey !== null) {
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
    this.state.ships.set(playerId, ship);

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
    serverLogEvent('player_join', { playerId, sessionId: client.sessionId, spawnX, spawnY });
    logger.info(
      { playerId, sessionId: client.sessionId, userId: effectiveUserId, resumedFromLimbo },
      'player joined',
    );
  }

  override onLeave(client: Client, _consented: boolean): void {
    const playerId = this.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;

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
    const ship = this.state.ships.get(playerId);
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

      const evictTimer = setTimeout(() => {
        this.evictOwnerlessShip(playerId);
      }, LIMBO_DISCONNECT_TTL_MS);
      if (typeof evictTimer === 'object' && evictTimer !== null && 'unref' in evictTimer) {
        (evictTimer as { unref: () => void }).unref();
      }
      this.ownerlessShips.set(playerId, evictTimer);

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
    this.initialSpawnPositions.delete(playerId);
    this.snapshotRing.unregisterEntity(playerId);

    if (slot !== undefined) {
      this.playerToSlot.delete(playerId);
      this.slotToPlayer.delete(slot);
      this.freeSlots.push(slot);
      this.postToWorker({ type: 'DESPAWN', slot, playerId });
    }

    this.state.ships.delete(playerId);
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
  private evictOwnerlessShip(playerId: string): void {
    const timer = this.ownerlessShips.get(playerId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.ownerlessShips.delete(playerId);
    }

    this.lastFireClientTick.delete(playerId);
    this.initialSpawnPositions.delete(playerId);
    this.snapshotRing.unregisterEntity(playerId);

    const slot = this.playerToSlot.get(playerId);
    if (slot !== undefined) {
      this.playerToSlot.delete(playerId);
      this.slotToPlayer.delete(slot);
      this.freeSlots.push(slot);
      this.postToWorker({ type: 'DESPAWN', slot, playerId });
    }

    this.state.ships.delete(playerId);
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
    this.bus.emit('SHIP_DESPAWNED', { type: 'SHIP_DESPAWNED' as const, playerId });
    serverLogEvent('ownerless_evicted', { playerId });
    logger.info({ playerId, sectorKey: this.sectorKey }, 'ownerless ship evicted');
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
        const ship = this.state.ships.get(playerId);
        return ship?.health ?? SHIP_MAX_HEALTH;
      },
      getShipKind: (playerId: string): string => {
        const ship = this.state.ships.get(playerId);
        return ship?.kind ?? DEFAULT_SHIP_KIND;
      },
      playerToTransitInFlight: this.playerToTransitInFlight,
      clientForPlayer: (playerId: string): Client | null => {
        const sessionId = this.playerToSession.get(playerId);
        if (!sessionId) return null;
        const c = this.clients.find((x) => x.sessionId === sessionId);
        return c ?? null;
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
        const storedTick = this.sabU32[b + SLOT_APPLIED_TICK_OFF]!;
        this.sabAppliedTicks.set(playerId, storedTick === 0 ? 0 : storedTick - 1);
      }

      const seq2 = Atomics.load(this.sabU32, SEQLOCK_IDX);
      if (seq1 === seq2) break; // consistent read
      // seq changed during read → writer modified data, retry
    }

    this.serverTick = Atomics.load(this.sabU32, TICK_IDX);
    this.state.tick = this.serverTick;

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
      const ship = this.state.ships.get(id);
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
    const sectorIdle = isSectorIdle(this.idleTracker, this.serverTick, IDLE_THRESHOLD_TICKS);

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
        pose: ShipPhysicsState;
        lastInput: ShipInputBits;
      };
      const allShips: AllShipEntry[] = [];
      const ackedTicksTelemetry: Record<string, number> = {};
      const aliveIds = new Set<string>();
      for (const [playerId, slot] of this.playerToSlot) {
        const ship = this.state.ships.get(playerId);
        if (!ship || !ship.alive) continue;
        const pose = this.shipPoseCache.get(playerId);
        if (!pose) continue;
        // Stage 3 — read the worker's last-applied input bits out of SAB
        // FLAGS so remote clients can forward-predict this ship. Bits 3–7
        // of the FLAGS u32; sleeping/swarm bits 0–2 are masked off.
        const flags = this.sabU32[slotBase(slot) + SLOT_FLAGS_OFF] ?? 0;
        allShips.push({
          playerId,
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
          states[ship.playerId] = {
            x: ship.pose.x, y: ship.pose.y, vx: ship.pose.vx, vy: ship.pose.vy,
            angle: ship.pose.angle, angvel: ship.pose.angvel ?? 0,
            ...(includeLastInput ? { lastInput: ship.lastInput } : {}),
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

        // Phase C (2026-05-09 AI lockstep) — drone reconcile-anchor slice.
        //
        // For every drone in this recipient's 9-cell interest window, ship
        // its pose AT `serverTick` (read from `SnapshotRing.getPoseAt`).
        // The client uses these to reset predWorld drone bodies before the
        // reconciler replay loop, so AI re-tick across replay starts from a
        // server-authoritative pose at `ackedTick`. Closes the structural
        // lookahead-gap that surfaced as ~10–15 u per-packet snap distance
        // (visible on mobile as "two positions fighting").
        //
        // Reuse the `interestScratch` Set populated by the swarm-broadcast
        // block earlier in this `update()` — same per-(client, tick) cell
        // window, no second `query9` call. Out-of-interest drones aren't
        // anchored; they continue on the binary-channel cadence (acceptable
        // since they cannot collide with the local ship within a snapshot
        // window). Asteroids (kind === 0) are skipped — they don't run AI
        // and don't need the anchor.
        let drones: SnapshotMessage['drones'];
        const interest = this.interestScratch.get(client.sessionId);
        if (interest && interest.size > 0) {
          for (const eid of interest) {
            const rec = this.swarmRegistry.getByEntityId(eid);
            if (!rec || rec.kind !== 1) continue;
            const pose = this.snapshotRing.getPoseAt(rec.id, this.serverTick);
            if (!pose) continue;
            if (!drones) drones = [];
            drones.push({
              id: eid,
              x: pose.x, y: pose.y,
              vx: pose.vx, vy: pose.vy,
              angle: pose.angle, angvel: pose.angvel,
            });
          }
        }

        const recipientAcked = this.sabAppliedTicks.get(recipientPlayerId) ?? 0;
        const snap: SnapshotMessage = {
          type: 'snapshot',
          serverTick: this.serverTick,
          states,
          ackedTick: recipientAcked,
          ...sharedTail,
          ...(projectiles ? { projectiles } : {}),
          ...(drones ? { drones } : {}),
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
        const ship = this.state.ships.get(pid);
        if (!ship?.alive) continue;
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
