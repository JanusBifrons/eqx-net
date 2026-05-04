import { Room, Client } from 'colyseus';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { bundleWorker } from '../workers/bundleWorker.js';
import { pino } from 'pino';
import { Bus } from '../../core/events/Bus.js';
import { SimulationClock } from '../../core/clock/SimulationClock.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { SectorState, ShipState, ProjectileState } from './schema/SectorState.js';
import { SwarmEntityRegistry, type SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import { LoadShedder } from '../orchestration/LoadShedder.js';
import { SpatialGrid } from '../interest/SpatialGrid.js';
import { BinarySwarmBroadcast } from '../net/BinarySwarmBroadcast.js';
import { SwarmSpawner, type AsteroidSpec } from '../spawn/SwarmSpawner.js';
import { AiController } from '../ai/AiController.js';
import { HostileDroneBehaviour } from '../../core/ai/HostileDroneBehaviour.js';
import type { AiPlayerView, AiEntity } from '../../core/contracts/IAiBehaviour.js';
import { assignPlayerId } from '../identity/PlayerIdentity.js';
import { InputMessageSchema, FireMessageSchema } from '../../shared-types/messages.js';
import type { WelcomeMessage, SnapshotMessage, HitAckMessage, DamageEvent, DestroyEvent, LaserFiredEvent, RespawnAckMessage } from '../../shared-types/messages.js';
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
  slotBase,
  SAB_TOTAL_BYTES,
  MAX_ENTITIES,
} from '../../shared-types/sabLayout.js';
import { SnapshotRing } from '../lagcomp/SnapshotRing.js';
import { checkBackpressure } from '../net/Backpressure.js';
import { validateToken } from '../auth/AuthService.js';
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
  HITSCAN_DAMAGE,
  PROJECTILE_DAMAGE,
  HITSCAN_RANGE,
  PROJECTILE_SPEED,
  WEAPON_COOLDOWN_TICKS,
  PROJECTILE_RADIUS,
  SHIP_COLLISION_RADIUS,
  SHIP_MAX_HEALTH,
} from '../../core/combat/Weapons.js';

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
  })
  .passthrough();

const MAX_INPUTS_PER_TICK = 3;
const LAG_COMP_WINDOW = 12;
const PROJECTILE_MAX_TICKS = 180; // 3 s at 60 Hz

type WorkerCmd =
  | { type: 'SPAWN';          slot: number; playerId: string; x: number; y: number }
  | { type: 'DESPAWN';        slot: number; playerId: string }
  | { type: 'INPUT';          slot: number; inputTick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean }
  | { type: 'SPAWN_OBSTACLE'; slot: number; obstacleId: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number }
  | { type: 'AI_INTENT';      slot: number; fx: number; fy: number; torque: number }
  | { type: 'CLOCK_RATE';     rate: number };

/** Fixed asteroid roster for the multiplayer diagnostic. Deterministic so the
 *  initial swarm population matches between sessions. Spawned via SwarmSpawner
 *  in onCreate(), then shipped via the binary swarm broadcast — no longer on
 *  Colyseus MapSchema. */
const ASTEROIDS: ReadonlyArray<AsteroidSpec> = [
  { id: 'asteroid-0', x:  200, y:    0, vx: 0,   vy: 0,    radius: 32, mass: 5 },
  { id: 'asteroid-1', x: -180, y:  120, vx: 0.3, vy: -0.2, radius: 24, mass: 3 },
  { id: 'asteroid-2', x:   80, y: -220, vx: 0,   vy: 0,    radius: 40, mass: 7 },
];

interface ProjectileRecord {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
  birthTick: number;
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
  /** Last client input tick the physics worker confirmed it applied, read from SAB. */
  private sabAppliedTicks = new Map<string, number>();
  private serverTick = 0;
  private broadcastCounter = 0;
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
  /** Phase 8 — counter for the 60-second snapshot cadence (galaxy sectors only). */
  private ticksSinceSnapshot = 0;
  /** Phase 8 sub-phase B — set when an in-flight transit has committed (Limbo
   *  entry written with destination sectorKey, seat reserved, ship about to
   *  leave). The subsequent `onLeave` checks this and skips its own Limbo
   *  put so the destination-keyed entry survives intact. Cleared in onLeave. */
  readonly playerToTransitInFlight = new Set<string>();
  /** Phase 8 sub-phase B — per-room transit driver, set in onCreate. */
  private transitOrchestrator: TransitOrchestrator | null = null;

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
    };
    this.testMode = roomOpts.testMode ?? false;
    this.sectorKey = roomOpts.sectorKey ?? null;
    this.tickBurnMs = Math.max(0, Math.min(50, roomOpts.tickBurnMs ?? 0));
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
      postSpawnObstacle: (slot, id, x, y, vx, vy, radius, mass) =>
        this.postToWorker({ type: 'SPAWN_OBSTACLE', slot, obstacleId: id, x, y, vx, vy, radius, mass }),
      sabF32: this.sabF32,
      sabU32: this.sabU32,
      registerAi: (id, slot, behaviour) => this.aiController.register(id, slot, behaviour),
      droneBehaviour: () => new HostileDroneBehaviour(),
      interestGrid: this.interestGrid,
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
      // Match the per-drone health bookkeeping the legacy ring did, so the
      // seeded drones still take 2 hitscan hits to die.
      for (const rec of this.swarmRegistry.all()) {
        if (rec.kind === 1) this.swarmHealth.set(rec.id, 40);
      }
      logger.info({ requested, spawned: bulk }, 'Phase 5e bulk seed');
    } else {
      // Seed a small drone wave for early manual testing. Drones ring the
      // spawn area at distance 350u so the player can engage them without
      // being instantly swarmed.
      const droneCount = roomOpts.droneCount ?? (this.testMode ? 0 : 30);
      for (let i = 0; i < droneCount; i++) {
        const angle = (i / droneCount) * Math.PI * 2;
        const r = 350;
        const id = `drone-${i}`;
        const ok = this.swarmSpawner.spawnDrone({ id, x: Math.cos(angle) * r, y: Math.sin(angle) * r });
        if (!ok) { logger.warn({ requested: droneCount, spawned: i }, 'drone wave truncated (slot pool full)'); break; }
        this.swarmHealth.set(id, 40);
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
      this.transitOrchestrator.beginTransit(playerId, parsed.data.targetSectorKey);
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
      const slot = this.playerToSlot.get(playerId);
      if (slot !== undefined) {
        this.postToWorker({ type: 'INPUT', slot, inputTick: tick, thrust, turnLeft, turnRight, boost });
      }
      // Track per-player boost state so the snapshot can broadcast it to all
      // observers for the visual exhaust trail. Only "active" while boosting
      // AND thrusting — shift alone doesn't visually do anything.
      if (boost && thrust) this.boostingPlayers.add(playerId);
      else this.boostingPlayers.delete(playerId);
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
    const { tick, clientShotId, weapon, rayFromX, rayFromY, rayDirX, rayDirY } = parsed.data;

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

    // Normalize ray direction defensively.
    const len = Math.hypot(rayDirX, rayDirY);
    if (len < 0.001) return;
    const ndx = rayDirX / len;
    const ndy = rayDirY / len;

    if (weapon === 'projectile') {
      this.spawnServerProjectile(shooterId, rayFromX, rayFromY, ndx * PROJECTILE_SPEED, ndy * PROJECTILE_SPEED);
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false };
      client.send('hit_ack', ack);
      return;
    }

    // Hitscan: lag-comp check against rewound positions of all other ships.
    let hitId: string | null = null;
    let hitDist = Infinity;
    let hitIsObstacle = false;

    for (const [targetId] of this.playerToSlot) {
      if (targetId === shooterId) continue;
      const targetShip = this.state.ships.get(targetId);
      if (!targetShip || !targetShip.alive) continue;

      // Use rewound position if available; fall back to current position.
      const rewound = this.snapshotRing.getAt(targetId, tick);
      const cx = rewound?.x ?? targetShip.x;
      const cy = rewound?.y ?? targetShip.y;

      const dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, HITSCAN_RANGE, cx, cy, SHIP_COLLISION_RADIUS);
      if (dist !== null && dist < hitDist) {
        hitDist = dist;
        hitId = targetId;
        hitIsObstacle = false;
      }
    }

    // Check swarm entities (asteroids, drones) — no lag-comp needed in 5c
    // (asteroids move slowly; drones contribute to SnapshotRing in 5e).
    // Pose read direct from SAB so we always check current authoritative
    // positions, never the last-broadcast pose stored on the registry.
    for (const rec of this.swarmRegistry.all()) {
      const b = slotBase(rec.slot);
      const sx = this.sabF32[b + SLOT_X_OFF]!;
      const sy = this.sabF32[b + SLOT_Y_OFF]!;
      const dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, HITSCAN_RANGE, sx, sy, rec.radius);
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
      this.applyDamage(hitId, shooterId, HITSCAN_DAMAGE);
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: true, targetId: hitId };
      client.send('hit_ack', ack);
    } else {
      const ack: HitAckMessage = { type: 'hit_ack', clientShotId, hit: false };
      client.send('hit_ack', ack);
    }

    // Broadcast authoritative beam endpoint to ALL clients so they can render it.
    const beamEndX = rayFromX + ndx * (hitDist === Infinity ? HITSCAN_RANGE : hitDist);
    const beamEndY = rayFromY + ndy * (hitDist === Infinity ? HITSCAN_RANGE : hitDist);
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
      const dist = rayHitsSphere(rayFromX, rayFromY, ndx, ndy, HITSCAN_RANGE, targetShip.x, targetShip.y, SHIP_COLLISION_RADIUS);
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

  private spawnServerProjectile(ownerId: string, x: number, y: number, vx: number, vy: number): void {
    const projId = `proj-${this.projectileCounter++}`;
    this.liveProjectiles.set(projId, { x, y, vx, vy, ownerId, birthTick: this.serverTick });
    const ps = new ProjectileState();
    ps.projectileId = projId;
    ps.ownerId = ownerId;
    ps.x = x; ps.y = y;
    ps.vx = vx; ps.vy = vy;
    this.state.projectiles.set(projId, ps);
  }

  private applyDamage(targetId: string, shooterId: string, damage: number): void {
    const ship = this.state.ships.get(targetId);
    if (ship) {
      if (!ship.alive) return;
      ship.health = Math.max(0, ship.health - damage);

      const dmgEvent: DamageEvent = {
        type: 'damage',
        targetId,
        damage,
        newHealth: ship.health,
        shooterId,
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
    this.broadcast('damage', {
      type: 'damage',
      targetId: wireTargetId,
      damage,
      newHealth,
      shooterId,
    } satisfies DamageEvent);

    if (newHealth <= 0) {
      this.evictSwarmEntity(rec, { broadcast: true, emitDestroyed: true, shooterId });
    }
  }

  /** Iterates positions of currently-alive players, for the LoadShedder.
   *  Skips dead ships so a corpse doesn't anchor far drones in place. */
  private *alivePlayerPositions(): IterableIterator<{ x: number; y: number }> {
    for (const ship of this.state.ships.values()) {
      if (!ship.alive) continue;
      yield { x: ship.x, y: ship.y };
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
    const spawnX = (this.testMode && storedPos) ? storedPos.x : (Math.random() - 0.5) * 400;
    const spawnY = (this.testMode && storedPos) ? storedPos.y : (Math.random() - 0.5) * 400;

    // Reset physics body in worker to new spawn position.
    this.postToWorker({ type: 'DESPAWN', slot, playerId });
    this.postToWorker({ type: 'SPAWN', slot, playerId, x: spawnX, y: spawnY });

    // Pre-populate SAB so update() reads a sane position before the worker responds.
    const base = slotBase(slot);
    this.sabF32[base + SLOT_X_OFF]  = spawnX;
    this.sabF32[base + SLOT_Y_OFF]  = spawnY;
    this.sabF32[base + SLOT_VX_OFF] = 0;
    this.sabF32[base + SLOT_VY_OFF] = 0;

    // Reset authoritative ship state.
    ship.health = SHIP_MAX_HEALTH;
    ship.alive  = true;
    ship.x      = spawnX;
    ship.y      = spawnY;
    ship.vx     = 0;
    ship.vy     = 0;

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
      proj.x += proj.vx * DT;
      proj.y += proj.vy * DT;

      // Lifetime check.
      if (this.serverTick - proj.birthTick >= PROJECTILE_MAX_TICKS) {
        this.liveProjectiles.delete(projId);
        this.state.projectiles.delete(projId);
        continue;
      }

      // Collision check against live ships.
      let hit = false;
      for (const [targetId] of this.playerToSlot) {
        if (targetId === proj.ownerId) continue;
        const targetShip = this.state.ships.get(targetId);
        if (!targetShip || !targetShip.alive) continue;
        const dx = proj.x - targetShip.x;
        const dy = proj.y - targetShip.y;
        const minDist = PROJECTILE_RADIUS + SHIP_COLLISION_RADIUS;
        if (dx * dx + dy * dy < minDist * minDist) {
          this.applyDamage(targetId, proj.ownerId, PROJECTILE_DAMAGE);
          hit = true;
          break;
        }
      }

      if (hit) {
        const ps = this.state.projectiles.get(projId);
        if (ps) ps.destroyed = true;
        this.liveProjectiles.delete(projId);
        // Leave destroyed state in schema briefly so client sees it, then clean up next tick.
        continue;
      }

      // Update schema position.
      const ps = this.state.projectiles.get(projId);
      if (ps) {
        ps.x = proj.x;
        ps.y = proj.y;
      }
    }

    // Clean up destroyed entries from schema.
    for (const [projId, ps] of this.state.projectiles) {
      if (ps.destroyed && !this.liveProjectiles.has(projId)) {
        this.state.projectiles.delete(projId);
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

      this.physicsWorker.on('message', (msg: { type: string; entityId?: string; sleeping?: boolean; tick?: number }) => {
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

    // If the requested ID is already held by an active session (e.g. two tabs
    // sharing the same localStorage), assign a fresh UUID.
    if (this.playerToSession.has(playerId)) {
      playerId = assignPlayerId(null);
    }

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

    let spawnX = parsed.success && parsed.data.spawnX !== undefined
      ? parsed.data.spawnX
      : (Math.random() - 0.5) * 400;
    let spawnY = parsed.success && parsed.data.spawnY !== undefined
      ? parsed.data.spawnY
      : (Math.random() - 0.5) * 400;
    let resumedHealth: number | null = null;
    let resumedUserId: string | null = null;
    let resumedLastFireTick: number | null = null;
    let resumedVx = 0;
    let resumedVy = 0;
    let resumedAngle = 0;
    let resumedAngvel = 0;
    let resumedFromLimbo = false;

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

    // Create Colyseus schema entry.
    const ship = new ShipState();
    ship.playerId = playerId;
    ship.x = spawnX;
    ship.y = spawnY;
    if (resumedHealth !== null) ship.health = resumedHealth;
    this.state.ships.set(playerId, ship);

    if (resumedLastFireTick !== null) {
      this.lastFireClientTick.set(playerId, resumedLastFireTick);
    }

    this.postToWorker({ type: 'SPAWN', slot, playerId, x: spawnX, y: spawnY });

    const currentServerTick = Atomics.load(this.sabU32, TICK_IDX);
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

    // Phase 8 sub-phase B — Limbo put. Galaxy rooms only; engineering rooms
    // continue to fresh-spawn next time. Skip if the player was mid-transit
    // (their commit-time entry — keyed to the destination sector — is
    // already in Limbo with a 30 s TTL; clobbering it with a source-keyed
    // 5 min entry would break the destination's onJoin restore).
    const slot = this.playerToSlot.get(playerId);
    if (
      this.sectorKey !== null
      && slot !== undefined
      && !this.playerToTransitInFlight.has(playerId)
    ) {
      const b = slotBase(slot);
      const payload: LimboPayload = {
        x:      this.sabF32[b + SLOT_X_OFF]!,
        y:      this.sabF32[b + SLOT_Y_OFF]!,
        vx:     this.sabF32[b + SLOT_VX_OFF]!,
        vy:     this.sabF32[b + SLOT_VY_OFF]!,
        angle:  this.sabF32[b + SLOT_ANGLE_OFF]!,
        angvel: this.sabF32[b + SLOT_ANGVEL_OFF]!,
        health: this.state.ships.get(playerId)?.health ?? SHIP_MAX_HEALTH,
        lastFireClientTick: this.lastFireClientTick.get(playerId) ?? 0,
        userId: this.playerToUser.get(playerId) ?? null,
        sectorKey: this.sectorKey,
      };
      try {
        getLimboStore().put(playerId, payload, LIMBO_DISCONNECT_TTL_MS);
      } catch (err) {
        logger.warn({ err, playerId }, 'Limbo put on leave failed');
      }
    }
    // Always clear the transit-in-flight flag, regardless of which branch
    // ran above.
    this.playerToTransitInFlight.delete(playerId);

    // Cancel any in-flight orchestrator entry for this player (e.g. they
    // disconnected during SPOOLING). Idempotent if there's no entry.
    this.transitOrchestrator?.cancelTransit(playerId, 'manual');

    this.sessionToPlayer.delete(client.sessionId);
    this.playerToSession.delete(playerId);
    this.interestScratch.delete(client.sessionId);
    this.sabAppliedTicks.delete(playerId);
    this.lastFireClientTick.delete(playerId);
    this.initialSpawnPositions.delete(playerId);
    this.snapshotRing.unregisterEntity(playerId);
    this.boostingPlayers.delete(playerId);
    clearSession(client.sessionId);

    if (slot !== undefined) {
      this.playerToSlot.delete(playerId);
      this.slotToPlayer.delete(slot);
      this.freeSlots.push(slot);
      this.postToWorker({ type: 'DESPAWN', slot, playerId });
    }

    this.state.ships.delete(playerId);
    recordGameLeave(playerId);
    this.playerToUser.delete(playerId);
    this.bus.emit('SHIP_DESPAWNED', { type: 'SHIP_DESPAWNED' as const, playerId });
    serverLogEvent('player_leave', { playerId });
    logger.info({ playerId }, 'player left');
  }

  override onDispose(): void {
    this.simLoopStopped = true;
    // Phase 8 sub-phase B — abort any in-flight transits so no orphan timers
    // or seat reservations linger past room teardown.
    this.transitOrchestrator?.cancelAll('manual');
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
    const phaseTime = (key: keyof typeof this.tickBudgetSums): void => {
      const now = performance.now();
      this.tickBudgetSums[key] = (this.tickBudgetSums[key] ?? 0) + (now - tPhase);
      tPhase = now;
    };

    // Seqlock read: retry if a write is in progress or if data was torn
    // (seqlock changed between the two loads). Only player ships are mirrored
    // into MapSchema; swarm poses are read directly from SAB by the binary
    // encoder later in this tick (see swarmEncoder.encode).
    for (;;) {
      const seq1 = Atomics.load(this.sabU32, SEQLOCK_IDX);
      if (seq1 & 1) continue; // odd → write in progress, spin

      for (const [playerId, slot] of this.playerToSlot) {
        const ship = this.state.ships.get(playerId);
        if (!ship) continue;
        const b = slotBase(slot);
        ship.x     = this.sabF32[b + SLOT_X_OFF]!;
        ship.y     = this.sabF32[b + SLOT_Y_OFF]!;
        ship.angle = this.sabF32[b + SLOT_ANGLE_OFF]!;
        ship.vx    = this.sabF32[b + SLOT_VX_OFF]!;
        ship.vy    = this.sabF32[b + SLOT_VY_OFF]!;
        ship.angvel = this.sabF32[b + SLOT_ANGVEL_OFF]!;
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
    for (const rec of this.swarmRegistry.all()) {
      const b = slotBase(rec.slot);
      const sx = this.sabF32[b + SLOT_X_OFF]!;
      const sy = this.sabF32[b + SLOT_Y_OFF]!;
      this.interestGrid.move(rec.entityId, sx, sy);
    }
    phaseTime('sabRead');

    // Record positions for lag compensation — alive ships only.
    this.snapshotRing.record(
      this.serverTick,
      Array.from(this.playerToSlot.keys())
        .filter((id) => {
          const ship = this.state.ships.get(id);
          return ship?.alive === true;
        })
        .map((id) => {
          const s = this.state.ships.get(id)!;
          return { id, x: s.x, y: s.y, vx: s.vx, vy: s.vy };
        }),
    );

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

    if (++this.broadcastCounter >= 3 && this.serverTick > 0) {
      this.broadcastCounter = 0;
      const states: SnapshotMessage['states'] = {};
      const ackedTicks: SnapshotMessage['ackedTicks'] = {};
      for (const [playerId] of this.playerToSlot) {
        const ship = this.state.ships.get(playerId);
        if (ship && ship.alive) {
          states[playerId] = { x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy, angle: ship.angle, angvel: ship.angvel };
          ackedTicks[playerId] = this.sabAppliedTicks.get(playerId) ?? 0;
        }
      }
      // Filter boostingPlayers to alive players included in this snapshot —
      // a stale id from a leaver shouldn't ship.
      const boostingIds: string[] = [];
      for (const id of this.boostingPlayers) {
        if (id in states) boostingIds.push(id);
      }
      const snap: SnapshotMessage = {
        type: 'snapshot',
        serverTick: this.serverTick,
        states,
        ackedTicks,
        ...(boostingIds.length > 0 ? { boostingIds } : {}),
      };

      // Per-client backpressure check before broadcast.
      for (const client of this.clients) {
        const bp = checkBackpressure(client, logger);
        if (bp === 'close') {
          client.leave(4002);
          continue;
        }
        if (bp === 'drop') continue;
        client.send('snapshot', snap);
      }

      serverLogEvent('snapshot_broadcast', {
        serverTick: this.serverTick,
        playerCount: this.playerToSlot.size,
        ackedTicks,
        states: Object.fromEntries(
          Object.entries(states).map(([id, s]) => [id, { x: parseFloat(s.x.toFixed(3)), y: parseFloat(s.y.toFixed(3)), vx: parseFloat(s.vx.toFixed(3)), vy: parseFloat(s.vy.toFixed(3)) }]),
        ),
      });
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
        this.aiPlayerScratch.push({ id: pid, x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy });
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
