import { Room, Client } from 'colyseus';
import { randomUUID } from 'node:crypto';
import { aggregateRamming } from '../../core/combat/Ramming.js';
// clampFireTick now used inside PlayerFireResolver.ts
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { pino } from 'pino';
import { Bus } from '../../core/events/Bus.js';
import { SimulationClock } from '../../core/clock/SimulationClock.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import {
  subscribeGcPause,
  unsubscribeGcPause,
  type GcPauseEvent,
} from '../debug/GcMonitor.js';
import type { GcPauseEventMessage } from '../../shared-types/messages.js';
import { SectorState, ShipState, WreckState } from './schema/SectorState.js';
import { shouldHonourResumedCooldown } from './cooldownRestore.js';
import { SwarmEntityRegistry, type SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import { LoadShedder } from '../orchestration/LoadShedder.js';
import { SpatialGrid } from '../interest/SpatialGrid.js';
import { BinarySwarmBroadcast } from '../net/BinarySwarmBroadcast.js';
import {
  createIdleTracker,
  type LastInputCache,
  type IdleTracker,
} from '../net/snapshotScheduler.js';
import { SwarmSpawner, type AsteroidSpec } from '../spawn/SwarmSpawner.js';
// Vec2 was used by the inline WorkerCmd union; now in PhysicsWorkerProxy.
import type { ShipPhysicsState } from '../../core/physics/World.js';
import { AiController } from '../../core/ai/AiController.js';
import { HostileDroneBehaviour } from '../../core/ai/HostileDroneBehaviour.js';
import { PassiveDroneBehaviour } from '../../core/ai/PassiveDroneBehaviour.js';
// pickTarget / rotateMountToward / wrapPi / MountTargetView now used
// inside WeaponMountTicker.ts; this file no longer imports them.
import type { AiPlayerView, AiStructureView, AiEntity } from '../../core/contracts/IAiBehaviour.js';
import { assignPlayerId } from '../identity/PlayerIdentity.js';
import type { WelcomeMessage } from '../../shared-types/messages.js';
import { DEFAULT_SHIP_KIND, getShipKind, isShipKindId, SHIELD_RADIUS_PAD, type ShipKind, type ShipKindId, type WeaponMount } from '../../shared-types/shipKinds.js';
// applyLayeredDamage + regenStep + ShieldHullState now used inside ShieldHullRouter.ts.
import { shipCollisionParts } from '../../core/geometry/shipHullDecomp.js';
import type { BotCarry } from '../livingworld/botTypes.js';

// Drone-kind catalogue helpers moved to ./droneKindHelpers.ts.
import { getDroneMaxHealth, getDroneShieldMax } from './droneKindHelpers.js';
import { STRUCTURE_DEFAULT_HEALTH } from '../../core/swarm/structureConstants.js';
import { StructureRegistry } from '../structures/StructureRegistry.js';
import { FactionLedger } from '../faction/FactionLedger.js';
import { StructurePlacementSubsystem } from '../structures/StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from '../structures/StructureGridSubsystem.js';
import { getStructureKind, type StructureKindId } from '../../shared-types/structureKinds.js';
import { TRANSFER_PULSE_MS, TURRET_TICK_MS } from '../../core/structures/structureGridConstants.js';
import type { GridObstacle } from '../../core/structures/Grid.js';
import { clampToSectorBounds } from '../../shared-types/sectorBounds.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
// Mount/slot geometry helpers moved to ./mountGeometry.ts.
import { resolveSlotMounts, mountWorldOrigin } from './mountGeometry.js';
import { WeaponMountTicker } from './WeaponMountTicker.js';
import { PhysicsWorkerProxy, type WorkerCmd } from './PhysicsWorkerProxy.js';
import { WreckLifecycleCoordinator } from './WreckLifecycleCoordinator.js';
import { ProjectilePipeline } from './ProjectilePipeline.js';
import { MissileSimulation } from './MissileSimulation.js';
import { ShieldHullRouter } from './ShieldHullRouter.js';
import { AiFireResolver } from './AiFireResolver.js';
import { PlayerFireResolver } from './PlayerFireResolver.js';
import { DamageRouter } from './DamageRouter.js';
import { RespawnHandler } from './RespawnHandler.js';
import { SwarmEvictor } from './SwarmEvictor.js';
import { RosterPersistence } from './RosterPersistence.js';
import { SnapshotBroadcaster } from './SnapshotBroadcaster.js';
import { WebRtcChannelManager, type WebRtcEntryCounters } from '../transport/webrtcChannel.js';
import { nodeDataChannelPeerConnectionFactory } from '../transport/webrtcChannelFactory.js';
import {
  WebRtcOfferMessageSchema,
  WebRtcIceMessageSchema,
  WebRtcFallbackMessageSchema,
} from '../../shared-types/messages/webrtcSignalingMessages.js';
import { SwarmBroadcaster } from './SwarmBroadcaster.js';
import { EntitySyncRouter } from './EntitySyncRouter.js';
import { SectorPersistence } from './SectorPersistence.js';
import { LivingWorldBotHooks } from './LivingWorldBotHooks.js';
import { OwnerlessShipEvictor } from './OwnerlessShipEvictor.js';
import { LeaveHandler } from './LeaveHandler.js';
import { mirrorSabPoses } from './SabPoseMirror.js';
import { updateSwarmInterestGrid } from './swarmInterestUpdater.js';
import { recordLagCompPoses } from './lagCompRecorder.js';
import { TickBudgetTelemetry } from './TickBudgetTelemetry.js';
import {
  evaluateSectorIdle,
  findAbandonedShips,
} from './sectorIdleEvaluator.js';
import { runAiTick } from './aiTickRunner.js';
import { makeInputHandler } from './InputHandler.js';
import {
  TICK_IDX,
  WORKER_TICK_US_IDX,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  // FLAG_INPUT_* + SLOT_FLAGS_OFF now used inside SnapshotBroadcaster.ts
  // SEQLOCK_IDX + SLOT_APPLIED_TICK_OFF moved into SabPoseMirror.ts
  slotBase,
  SAB_TOTAL_BYTES,
  MAX_ENTITIES,
} from '../../shared-types/sabLayout.js';
import { SnapshotRing } from '../lagcomp/SnapshotRing.js';
// checkBackpressure now used inside SnapshotBroadcaster.ts + SwarmBroadcaster.ts
import { validateToken, getUser } from '../auth/AuthService.js';
import { recordGameJoin, recordKill } from '../stats/StatsService.js';
// db / saveSnapshot / SectorSnapshot.* now used inside SectorPersistence.ts
import { getLimboStore, getPlayerShipStore } from '../db/PersistenceWorker.js';
// LIMBO_DISCONNECT_TTL_MS + LimboPayload now used inside LeaveHandler.ts
// RosterFullError is handled inside RosterPersistence.ts
import { TransitOrchestrator } from '../transit/TransitOrchestrator.js';
import { setSession } from '../transit/sessionRegistry.js';
import {
  EngageTransitSchema,
  CancelTransitSchema,
  ClientReadyMessageSchema,
  PlaceStructureSchema,
  RemoveStructureSchema,
  SelectEntitySchema,
  DeselectEntitySchema,
} from '../../shared-types/messages.js';
import type { EntityStatsMessage } from '../../shared-types/messages/selectionMessages.js';
import { SelectionStatsSubsystem, type Selection } from './SelectionStatsSubsystem.js';
import {
  rayHitsSphere,
  // rayHitsConvexPolygon now used inside PlayerFireResolver.ts
  projectileSweepCircle,
  rayHitsShipPolygon,
  sweptSegmentHitsShipPolygon,
  // WEAPON_COOLDOWN_TICKS now used inside PlayerFireResolver + AiFireResolver
  // SHIP_COLLISION_RADIUS retired 2026-05-27 — hit-tests now derive per-kind
  // bounding-circle from `getShipKind(ship.kind).radius + SHIELD_RADIUS_PAD`
  // so the system matches the visible ShieldAura on every ship kind.
  SHIP_MAX_HEALTH,
} from '../../core/combat/Weapons.js';
// getWeapon/isWeaponId/HitscanWeaponDef/ProjectileWeaponDef now used inside PlayerFireResolver.ts
import type { WeaponId, MissileWeaponDef } from '../../core/combat/WeaponCatalogue.js';
import { regenEnergyStep, spendEnergy, BOOST_TICK_COST } from '../../core/combat/Energy.js';

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

// Dev-only override gate. When set, `testMode`-only join options
// (`initialHull`, `initialShield`, `startHostile`) ALSO apply on
// galaxy rooms — required by the phone-stall repro spec
// (tests/mobile-perf/phone-galaxy-stall-repro.spec.ts) to harden test
// conditions (near-invulnerable ship under heavy combat). Off in
// production; set via `EQX_ALLOW_DEV_OVERRIDES=1` for E2E only.
const ALLOW_DEV_OVERRIDES = process.env['EQX_ALLOW_DEV_OVERRIDES'] === '1';

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
    /** Test-only initial energy override; same testMode gate. Lets energy
     *  specs start near-empty so the fire-gate / regen flow resolves in a
     *  few ticks. (weapons/energy/AI overhaul §3) */
    initialEnergy: z.number().int().min(0).optional(),
    /** Mobile-perf gate test-only leak rate (bytes per RAF tick). Server
     *  accepts and ignores — the value is consumed CLIENT-SIDE by
     *  `src/client/debug/testLeakHook.ts` reading the URL param directly.
     *  Validated here only for schema parity with the other test
     *  primitives + so the URL → joinOption echo round-trips cleanly. */
    injectLeak: z.number().int().min(0).max(10_000_000).optional(),
    /** Test-only initial angle override (radians, standard math CCW).
     *  Lets a spec spawn pointing at a specific target without burning
     *  ~2 seconds rotating the ship via keyboard input. testMode gate. */
    initialAngle: z.number().finite().optional(),
    /** Per-test room isolation knob. Combined with the test rooms'
     *  `filterBy(['testId'])` (in `src/server/index.ts`), passing a
     *  unique testId routes each Playwright spec to its own physics-
     *  worker-backed Colyseus room — enabling safe `fullyParallel`
     *  execution across specs without cross-test state pollution.
     *  Omit (default) → shared room for back-compat with pre-filterBy
     *  specs. The server doesn't otherwise consume this field; Colyseus
     *  routes by it at the matchmaker layer. */
    testId: z.string().optional(),
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
    /** Test-only: pre-mark every drone in this sector hostile to the
     *  joining player at spawn time. Lets a 20-25 s CDP allocation
     *  profile (or any combat-shaped E2E) measure steady-state combat
     *  without the IDLE→COMBAT transition tail polluting the window.
     *  testMode-gated; ignored on galaxy rooms so a malicious client
     *  can't force-aggro a live sector. plan: imperative-taco. */
    startHostile: z.boolean().optional(),
    /** Test-only: override the disconnect-linger TTL (ms) for THIS player.
     *  On disconnect the room normally lingers the hull for
     *  `LIMBO_DISCONNECT_TTL_MS` (15 min) before the ownerless-evict timer
     *  returns it to the virtual pool. That's far too long for an E2E to
     *  observe the despawn→return-to-pool transition, so the linger E2E
     *  suite passes e.g. `?lingerMs=2000` to make the evict fire in ~2 s.
     *  testMode-gated (honoured only on `galaxy-test` / engineering rooms);
     *  ignored on live galaxy rooms so a malicious client can't force a
     *  short or huge linger window. */
    lingerMs: z.number().int().min(1).max(900_000).optional(),
    /** Structures plan (Phase 3/4) test-only override of the grid pulse
     *  interval (ms). On the room-creating client it reaches `onCreate` and
     *  sets the pulse timer; lets the mining/construction E2E fast-forward the
     *  wall-clock pulse (which `testTimeScale` can't, being physics-tick-only).
     *  testMode-gated. */
    structureGridPulseMs: z.number().int().min(20).max(2000).optional(),
  })
  .passthrough();

const MAX_INPUTS_PER_TICK = 3;
// LAG_COMP_WINDOW now used inside PlayerFireResolver.ts

/** Click-to-inspect live-stats emit cadence (Item B5). ~5 Hz on its OWN
 *  timer — low-frequency + off the snapshot/physics hot path; only does work
 *  while a client has an entity selected. */
const SELECTION_STATS_INTERVAL_MS = 200;

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

/**
 * Plan: crispy-kazoo, Commit 9 — synchronised warp-in handshake.
 *
 * After `client_ready` arrives, the server picks
 * `arrivalTick = serverTick + ARRIVAL_OFFSET_TICKS` and broadcasts
 * `warp_in` with that tick to all clients in the sector (including
 * the joiner). At `arrivalTick` the server flips `ship.isActive = true`
 * and the snapshot diff carries the ship into broadcasts for the
 * first time.
 *
 * 36 ticks @ 60 Hz = 600 ms. Budget breakdown for the joiner:
 *   - ~50 ms broadcast propagation
 *   - ~150 ms loading-active "world emerges" window (curtain held)
 *   - 380 ms curtain fade-out (`WarpFilterChain.setLoadCurtain(false)`)
 *   - 20 ms safety
 *   = curtain visibly drops → user sees the world → warp-in flash
 *
 * The 2026-05-31 smoke (capture `w5wihn`) at 6 ticks (100 ms) had two
 * problems: (a) the client used a stale `inputTick` for the setTimeout
 * math and waited 5 s instead of 100 ms — fixed client-side, but
 * (b) even with the math right, 100 ms is too short to fade the
 * 380 ms curtain before the warp-in flash fires; the two events
 * overlapped and the user "never saw the warp-in".
 */
const ARRIVAL_OFFSET_TICKS = 36;

/**
 * Plan: crispy-kazoo, Commit 2 — `client_ready` watchdog.
 *
 * If the client never sends `client_ready` (broken bootstrap, network
 * drop mid-load) the watchdog force-activates the ship at this tick
 * so the player appears even if their client is wedged. 30 s at
 * 60 Hz = 1800 ticks. Better than an invisible ghost; the Limbo
 * 15 min TTL eventually catches truly-dead sessions.
 */
const CLIENT_READY_TIMEOUT_TICKS = 1800;

/**
 * Per-pending-join record. Lives in `pendingJoin: Map<playerId, ...>`
 * on the room. Removed when the ship activates (normal or watchdog).
 */
interface PendingJoinRecord {
  joinTick: number;
  watchdogTick: number;
  /** Set when `client_ready` is received and the server picks the
   *  activation tick. `null` while waiting for client_ready. */
  arrivalTick: number | null;
  spawnX: number;
  spawnY: number;
  sessionId: string;
}

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

// WorkerCmd union extracted to PhysicsWorkerProxy.ts

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

/** Wave-system Phase 2 — drone target priority by structure kind (higher =
 *  attacked first). The Capital (the "core" / mineral bank) is the prize; the
 *  Miner is the objective the de-escalation condition keys on; defence + power
 *  rank below. All are > 0 so every hostile structure outranks a player ship
 *  (req #2 "structures primarily"). Tunable per difficulty pass. */
function structurePriority(kind: StructureKindId): number {
  switch (kind) {
    case 'capital':
      return 3;
    case 'miner':
      return 2;
    default:
      return 1;
  }
}

export class SectorRoom extends Room<SectorState> {
  /** Owns the physics worker (lifecycle + message routing + typed
   *  postMessage facade). Extracted to PhysicsWorkerProxy.ts (commit 20
   *  of v3 refactor plan). */
  private physicsWorkerProxy!: PhysicsWorkerProxy;
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
  /** Atomic ship→wreck conversion + wreck destruction. Owns
   *  `wreckToSlot`, `slotToWreck`, `wreckPoseCache`, `wreckConversions`.
   *  Extracted to `WreckLifecycleCoordinator.ts` (commit 15 of v3
   *  refactor plan). Aliased below as getters so the unchanged call
   *  sites in `update()` / snapshot serialiser / restore paths keep
   *  reading the same Map identity. */
  private wreckCoordinator!: WreckLifecycleCoordinator;
  private get wreckToSlot(): Map<string, number> { return this.wreckCoordinator.wreckToSlot; }
  private get slotToWreck(): Map<number, string> { return this.wreckCoordinator.slotToWreck; }
  private get wreckPoseCache(): Map<string, ShipPhysicsState> { return this.wreckCoordinator.wreckPoseCache; }
  private get wreckConversions(): number { return this.wreckCoordinator.wreckConversions; }

  // Phase 5c: swarm entities (asteroids, drones) live in the same SAB slot
  // pool as ships, but their wire-side metadata (kind, radius, last-broadcast
  // pose, sleeping flag) is owned by the swarm registry and shipped via the
  // binary swarm channel — never on MapSchema.
  private readonly swarmRegistry = new SwarmEntityRegistry();
  private readonly swarmEncoder = new BinarySwarmBroadcast();
  /** Phase 5d: per-client interest grid. 2048-unit cells, 3×3 query window. */
  private readonly interestGrid = new SpatialGrid();
  /** Reused per-tick scratch sets so query9 doesn't allocate per call.
   *  Owned by SnapshotBroadcaster (extracted); aliased here so the
   *  swarm-broadcast block earlier in update() keeps reading the same
   *  Map identity. */
  private get interestScratch(): Map<string, Set<number>> { return this.snapshotBroadcaster.interestScratch; }
  /** Per-client snapshot broadcaster. Extracted to `SnapshotBroadcaster.ts`. */
  private snapshotBroadcaster!: SnapshotBroadcaster;
  /**
   * Phase 1 of swift-otter — per-room WebRTC DataChannel transport. Owns
   * one PeerConnection per sessionId. Snapshot routing is wired through
   * `SnapshotBroadcaster.sendSnapshot` to call `webrtcChannelManager
   * .sendSnapshot(sessionId, snap, () => client.send('snapshot', snap))`.
   *
   * Null on engineering rooms (`sectorKey === null`) — those rooms are
   * test fixtures and don't need the additional native-binding init cost.
   */
  private webrtcChannelManager: WebRtcChannelManager | null = null;
  /** Per-client binary swarm packet encode + send. Extracted to `SwarmBroadcaster.ts`. */
  private swarmBroadcaster!: SwarmBroadcaster;
  /** GEP B4 — single orchestration entry point for per-tick entity sync (routes
   *  pose-core then json-slice in HC#4 order). Extracted to `EntitySyncRouter.ts`. */
  private entitySync!: EntitySyncRouter;
  /** Sector volatile-state persistence (swarm health snapshots). Extracted to `SectorPersistence.ts`. */
  private sectorPersistence!: SectorPersistence;
  /** Living World bot lifecycle (spawn/despawn/markHostile). Extracted to `LivingWorldBotHooks.ts`. */
  private livingWorldBotHooks!: LivingWorldBotHooks;
  /** Ownerless ship full-despawn (TTL expiry + lingering destruction). Extracted to `OwnerlessShipEvictor.ts`. */
  private ownerlessShipEvictor!: OwnerlessShipEvictor;
  /** Player onLeave handler (lingering / transit / despawn branches). Extracted to `LeaveHandler.ts`. */
  private leaveHandler!: LeaveHandler;
  private swarmSpawner!: SwarmSpawner;
  /** Placed-structure bookkeeping (structures plan, Phase 2). */
  private readonly structureRegistry = new StructureRegistry();
  private structurePlacement!: StructurePlacementSubsystem;
  /** Monotonic id source for player-placed structures (session-scoped). */
  private placedStructureCounter = 0;
  /** Power-grid pulse subsystem (structures plan, Phase 3). */
  private structureGrid!: StructureGridSubsystem;
  /** 1 Hz grid heartbeat timer (unref'd; off the physics tick). */
  private structureGridTimer: ReturnType<typeof setInterval> | undefined;
  /** Faster turret aim/fire timer (Phase 5; unref'd). */
  private structureTurretTimer: ReturnType<typeof setInterval> | undefined;
  /** Click-to-inspect live-stats channel (structures follow-up Item B5) +
   *  its ~5 Hz emit timer (unref'd; OFF the snapshot/physics hot path). */
  private selectionStats!: SelectionStatsSubsystem;
  private selectionStatsTimer: ReturnType<typeof setInterval> | undefined;
  /** Cached low-cadence structures snapshot slice (rebuilt on pulse / place;
   *  attached by reference to every recipient). Undefined ⇒ no structures. */
  private structuresSlice: SnapshotMessage['structures'] = undefined;
  private aiController!: AiController;
  /** Reused per-tick view for the AI controller — avoids per-tick allocation. */
  private aiPlayerScratch: AiPlayerView[] = [];
  /** Wave-system Phase 1 — per-room faction hostility/peace ledger, membership
   *  derived live from this room's structure registry. */
  private readonly factionLedger = new FactionLedger({
    structures: () => this.structureRegistry.all(),
  });
  /** Wave-system Phase 2 — reused per-tick structure target buffers, rebuilt
   *  ONCE per tick (shared by every drone via AiWorldView; never per-drone).
   *  `aiStructureScratch` feeds the brain (priority); `hostileStructureCircles`
   *  feeds the fire-resolver hit test (radius). Both hold only this sector's
   *  hostile (under-wave / member-attacked), constructed structures. Object
   *  churn matches the established `aiPlayerScratch` view-build pattern. */
  private readonly aiStructureScratch: AiStructureView[] = [];
  private readonly hostileStructureCircles: Array<{
    id: string;
    x: number;
    y: number;
    radius: number;
  }> = [];

  // ── Phase 4b.3 (multi-mount turret refactor, 2026-05-11) ────────────────
  /** Authoritative per-mount rotation angle (ship-relative, arc-local) for
   *  each alive player ship's active slot. Indexed by mount-order in the
   *  ship-kind catalogue. Computed each `update()` by the server-side
   *  WeaponMountController tick; consumed by `handleFire` for ray geometry
   *  and shipped per-recipient in `SnapshotMessage.states[id].mountAngles`
   *  so remote observers see the same turret rotation the firer's screen
   *  is drawing. */
  /**
   * Per-tick weapon-mount aim updater. Owns:
   *   - `playerMountAngles` / `droneMountAngles` (per-mount slewed angles)
   *   - `playerSlotTargets` / `droneSlotTargets` (sticky pickTarget hysteresis)
   *   - pooled MountTargetView scratch arrays
   *
   * Consumers (`handleFire`, `handleAiFire`, snapshot serialiser, eviction
   * paths) read/write through `mountTicker.playerMountAngles` etc. directly;
   * the underlying Map identity is the same as the pre-extraction fields.
   *
   * Extracted to `WeaponMountTicker.ts` (commit 21 of the v3 refactor plan).
   */
  private mountTicker!: WeaponMountTicker;
  /** Alias accessors so the rest of SectorRoom keeps the old field-style
   *  reads (`this.playerMountAngles.get(id)`). Initialised in `onCreate`
   *  after the ticker is constructed. */
  private get playerMountAngles(): Map<string, Float32Array> { return this.mountTicker.playerMountAngles; }
  private get droneMountAngles(): Map<string, Float32Array> { return this.mountTicker.droneMountAngles; }
  private get playerSlotTargets(): Map<string, string | null> { return this.mountTicker.playerSlotTargets; }
  private get droneSlotTargets(): Map<string, string | null> { return this.mountTicker.droneSlotTargets; }

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
  /** Physics-tick acceleration multiplier; see roomOpts.testTimeScale. */
  private testTimeScale = 1;
  private sessionToPlayer = new Map<string, string>();
  private playerToSession = new Map<string, string>();
  private inputCountThisTick = new Map<string, number>();
  /** PlayerIds currently holding boost (energy-affordable), regardless of
   *  thrust. Surfaced on every snapshot so all clients can render an exhaust
   *  trail for that ship; also drives the per-tick boost energy drain. */
  private readonly boostingPlayers = new Set<string>();
  /** PlayerIds currently holding thrust (regardless of boost). Surfaced on
   *  every snapshot so observers can see a baseline thrust flame whenever
   *  a ship is accelerating. No longer a strict superset of `boostingPlayers`
   *  (boost without thrust is now valid). */
  private readonly thrustingPlayers = new Set<string>();
  /** Last client input tick the physics worker confirmed it applied, read from SAB.
   *  Owned by SnapshotBroadcaster (extracted); aliased here for the
   *  worker-read site + the room's onJoin/onLeave callers. */
  private get sabAppliedTicks(): Map<string, number> { return this.snapshotBroadcaster.sabAppliedTicks; }
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
  /** Owned by SnapshotBroadcaster (extracted). */
  private get broadcastCounter(): number { return this.snapshotBroadcaster.broadcastCounter; }
  /** Stage 5 — per-recipient cache of the last lastInput bits sent for
   *  each ship. Owned by SnapshotBroadcaster (extracted). */
  private get lastInputCaches(): Map<string, LastInputCache> { return this.snapshotBroadcaster.lastInputCaches; }
  /** Stage 5 — sector-wide idle tracker. Updated each update() with
   *  motion / projectile-in-flight signals; when isSectorIdle returns
   *  true, the snapshot broadcast block short-circuits entirely. */
  private readonly idleTracker: IdleTracker = createIdleTracker();
  /** Server tick until which snapshot broadcasts are forced ON,
   *  bypassing idle-suppression. Set on every player join/spawn — see
   *  `JOIN_BROADCAST_GRACE_TICKS`. */
  private forceBroadcastUntilTick = 0;

  /**
   * Plan: crispy-kazoo, Commit 2 — pending-join handshake registry.
   *
   * `onJoin` (and `RespawnHandler.handle`) sets the joining ship's
   * `isActive=false` and adds an entry here. The client bootstraps,
   * calls `client_ready`, the handler picks `arrivalTick` and
   * broadcasts `warp_in`. The per-tick drain in `update()` flips
   * `isActive=true` at `arrivalTick` and removes the entry. A
   * watchdog force-activates after `CLIENT_READY_TIMEOUT_TICKS`.
   *
   * Keyed by playerId for symmetry with `playerToSlot` / `lastFireClientTick`.
   */
  private pendingJoin = new Map<string, PendingJoinRecord>();
  private testMode = false;
  private disableCollisionDamage = false;
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
  /** Paradigm plan (quirky-rabbit) Phase 6 — fans process-wide GC pauses
   *  out to this room's clients so the on-device dev overlay can show
   *  the server's GC health alongside its own browser longtask stats.
   *  Stored as a bound function reference so onDispose can unsubscribe
   *  the exact callback. Initialised in onCreate, nulled in onDispose. */
  private gcPauseSubscriber: ((event: GcPauseEvent) => void) | null = null;
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

  /** Test-only per-player disconnect-linger TTL override (ms), captured
   *  from the `lingerMs` JoinOption in testMode rooms. LeaveHandler reads
   *  it to shorten the linger window so the despawn→return-to-pool E2E
   *  runs in ~2 s instead of 15 min. Cleared on leave. */
  private readonly playerToLingerMs = new Map<string, number>();

  /**
   * Test-only piercing surface (see src/server/CLAUDE.md "Testing
   * patterns"). Exposes private collaborators that integration tests
   * assert against without each declaring a local cast interface. NOT used
   * in production. Restored 2026-06-03 after the v3 subsystem extraction
   * dropped it (it was still referenced by 4 integration files, leaving
   * them RED). Each access reads through to the live field/method.
   */
  get _internals(): {
    serverTick: number;
    ownerlessShips: Map<string, ReturnType<typeof setTimeout>>;
    aiPlayerScratch: AiPlayerView[];
    postToWorker: (cmd: WorkerCmd) => void;
    applyDamage: (
      targetId: string,
      shooterId: string,
      damage: number,
      hitX?: number,
      hitY?: number,
    ) => void;
    /** GEP P4 — lets the structureEntity integration test find a kind=2 record
     *  and assert it is damageable (seeded into swarmHealth). */
    swarmRegistry: {
      all(): Iterable<{ id: string; kind: number; entityId: number; shipKind?: string }>;
      get(id: string): { id: string; kind: number; entityId: number; shipKind?: string } | null | undefined;
    };
    swarmHealth: Map<string, number>;
    /** Structures plan, Phase 2 — lets the placement integration test assert
     *  the blueprint vs pre-built record state from the player-driven path. */
    structureRegistry: StructureRegistry;
    /** Structures plan, Phase 3 — drive the grid pulse deterministically (no
     *  wall-clock wait) + read the cached snapshot slice. */
    pulseStructureGrid: () => void;
    getStructuresSlice: () => SnapshotMessage['structures'];
    /** Phase 4 — seed a mineable asteroid for the mining integration test. */
    spawnTestAsteroid: (id: string, x: number, y: number, radius: number) => boolean;
    /** Phase 5 — seed a drone + drive the turret tick for the turret test. */
    spawnTestDrone: (id: string, x: number, y: number) => boolean;
    tickStructureTurrets: () => void;
  } {
    return {
      serverTick: this.serverTick,
      ownerlessShips: this.ownerlessShips,
      aiPlayerScratch: this.aiPlayerScratch,
      postToWorker: (cmd) => this.postToWorker(cmd),
      applyDamage: (targetId, shooterId, damage, hitX, hitY) =>
        this.applyDamage(targetId, shooterId, damage, hitX, hitY),
      swarmRegistry: this.swarmRegistry,
      swarmHealth: this.swarmHealth,
      structureRegistry: this.structureRegistry,
      pulseStructureGrid: () => this.structureGridTick(),
      getStructuresSlice: () => this.structuresSlice,
      spawnTestAsteroid: (id, x, y, radius) =>
        this.swarmSpawner.spawnAsteroid({ id, x, y, vx: 0, vy: 0, radius, mass: 1 }),
      spawnTestDrone: (id, x, y) => {
        const ok = this.swarmSpawner.spawnDrone({ id, x, y, kind: 'fighter' });
        if (ok) {
          this.swarmHealth.set(id, getDroneMaxHealth('fighter') ?? 40);
          this.swarmShield.set(id, 0); // hull exposed so turret damage lands
        }
        return ok;
      },
      tickStructureTurrets: () => this.structureTurretTick(),
    };
  }

  // Auth — maps playerId → userId (null for anonymous)
  private readonly playerToUser = new Map<string, string | null>();

  // Combat
  private readonly snapshotRing = new SnapshotRing();
  private readonly lastFireClientTick = new Map<string, number>();
  /** Server-side projectile lifecycle (spawn + per-tick sweep + cleanup).
   *  Owns `liveProjectiles` + the monotonic id counter. Extracted to
   *  `ProjectilePipeline.ts` (commit 21 of v3 refactor plan). Aliased
   *  below as a getter so the `update()` callsites that read
   *  `this.liveProjectiles.size` keep the same Map identity. */
  private projectiles!: ProjectilePipeline;
  private get liveProjectiles(): Map<string, ProjectileRecord> { return this.projectiles.liveProjectiles; }
  /** Server-side missile simulation — pool, guidance, splash, impulse
   *  queue. See `MissileSimulation.ts`. Wired into the per-tick `update()`
   *  loop alongside `advanceProjectiles`. */
  private missileSim!: MissileSimulation;
  /** AI drone weapon-fire resolver (per-mount hitscan + laser_fired
   *  broadcast). Extracted to `AiFireResolver.ts` (commit 21 partial). */
  private aiFireResolver!: AiFireResolver;
  /** Player weapon-fire resolver — zod parse + cooldown + lag-comp
   *  rewind + 4-target sweep + aggregate hit_ack. Extracted to
   *  `PlayerFireResolver.ts`. */
  private playerFireResolver!: PlayerFireResolver;
  /** Damage routing — 4 branches (wreck / lingering / active / swarm).
   *  Extracted to `DamageRouter.ts`. */
  private damageRouter!: DamageRouter;
  /** Player respawn handler. Extracted to `RespawnHandler.ts`. */
  private respawnHandler!: RespawnHandler;
  /** Swarm entity eviction. Extracted to `SwarmEvictor.ts`. */
  private swarmEvictor!: SwarmEvictor;
  /** Roster persistence bridge. Extracted to `RosterPersistence.ts`. */
  private rosterPersistence!: RosterPersistence;
  /** Two-layer shield/hull damage + regen routing. Owns the swarm-side
   *  shield/hull state (swarmHealth, swarmShield, swarmShieldLastDmg) +
   *  the three layered-damage methods. Extracted to
   *  `ShieldHullRouter.ts`. Aliased below so the call sites in spawn
   *  / evict / persistence paths keep reading the same Map identity. */
  private shieldHullRouter!: ShieldHullRouter;
  private get swarmHealth(): Map<string, number> { return this.shieldHullRouter.swarmHealth; }
  private get swarmShield(): Map<string, number> { return this.shieldHullRouter.swarmShield; }
  private get swarmShieldLastDmg(): Map<string, number> { return this.shieldHullRouter.swarmShieldLastDmg; }

  // Tick-budget telemetry. Accumulated each `update()`; flushed every 60 ticks
  // (≈ 1 s wall-clock) to a single serverLogEvent so a diagnostic capture can
  // see the breakdown without saturating the 500-entry server-event buffer.
  // Per-tick accumulation + tick_hitch + tick_budget aggregation lives in
  // TickBudgetTelemetry.
  private readonly tickBudget = new TickBudgetTelemetry();

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
       * 2026-05-27 — Engineering test rooms (`shield-test`) want a
       * stationary drone gallery: ram them, shoot them, watch the
       * shield-vs-hull collider swap, WITHOUT having them fly around
       * pursuing + firing back. When true, drones spawn with
       * `PassiveDroneBehaviour` (zero-impulse, never-fire) instead of
       * `HostileDroneBehaviour`. Drones still take damage and die
       * normally; only the COMBAT state transition (pursuit + fire)
       * is suppressed. */
      peacefulDrones?: boolean;
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
      /** Test-only physics-tick acceleration. The worker already scales
       *  its physics-step accumulator by the SAB-resident clock rate
       *  (Phase 6 TiDi — `physics.tick(FIXED_DT * rate)`); setting this
       *  to e.g. 10 in a `testMode` room multiplies the outbound rate
       *  by 10 so 1 wall-clock tick advances 10 physics ticks of game
       *  time. Ghost-TTL (500 ms), projectile lifetime (4 s), warp
       *  spool (30 s), regen cycles all compress proportionally.
       *  Ignored on non-testMode rooms (galaxy gameplay never sees a
       *  multiplied clock). Server-side `state.clockRate` continues to
       *  report the unmultiplied `simClock.rate` so client audio pitch
       *  + TiDi UI stay honest. */
      testTimeScale?: number;
      /**
       * 2026-05-28 — test-only: gate the entire ramming-damage path. The
       * damage formula in `core/combat/Ramming.ts` is impact-speed gated
       * (`RAM_MIN_IMPACT_SPEED` u/s below which damage is 0), and a real
       * ram quickly caps the player at the per-pair `RAM_DAMAGE_MAX = 50`
       * HP/tick. `ramming-probe-test` needs the player to ram a target
       * to gather visual-vs-physics frames WITHOUT dying. When this
       * flag is true the `onContactBatch` path skips the `applyDamage`
       * call (server still broadcasts `collision_resolved` for velocity
       * sync; `ram_damage` is suppressed and no health changes). Ignored
       * on non-testMode rooms.
       */
      disableCollisionDamage?: boolean;
      /**
       * 2026-05-28 — Engineering-test rooms (`hull-collision-test`) seed a
       * deterministic gallery of drones at hand-authored poses, bypassing the
       * uniform-disc spawner. Each entry forces the drone to a specific
       * world `(x, y, angle)`; `hullExposed: true` immediately drops the
       * shield + posts `SET_HULL_EXPOSED` so the hull-polygon collider is
       * exposed at spawn (no need to ram + drain shield first).
       *
       * Suppresses `useBulkSeed` / asteroidRoster / legacy drone-wave seed
       * paths — no double-spawn. Ignored on non-testMode rooms; bypasses
       * `peacefulDrones` AI selection (the room-level option still applies
       * to the AI factory). Drones still take damage and die normally.
       */
      dronePoses?: ReadonlyArray<{
        kind: ShipKindId;
        x: number;
        y: number;
        angle?: number;
        hullExposed?: boolean;
      }>;
      /**
       * Generic Entity Pipeline P4 — deterministic STRUCTURE placement. Each
       * entry spawns a static, damageable structure (pose-core kind byte 2) at
       * a world `(x, y)`, seeding `swarmHealth` so it takes damage through the
       * EXISTING swarm path (zero new dispatch). testMode-only; suppresses the
       * legacy asteroid roster like `dronePoses`. Drives the `structureEntity`
       * integration + `structure-visible-damageable` E2E ("for free" proof).
       */
      structurePoses?: ReadonlyArray<{
        id?: string;
        x: number;
        y: number;
        radius?: number;
        mass?: number;
      }>;
      /** Structures plan, Phase 3/4 — override the grid pulse interval (ms).
       *  testMode-only bespoke trigger so E2E can fast-forward construction +
       *  mining (the pulse is a wall-clock timer, NOT the physics tick, so
       *  `testTimeScale` doesn't speed it). Default `TRANSFER_PULSE_MS`. */
      structureGridPulseMs?: number;
      /** Structures plan (Phase 3-5) — seed PRE-BUILT, auto-connected structures
       *  at hand-authored poses (owner `scenario`). testMode-only bespoke
       *  trigger: gives E2E a fully-functional powered grid without fighting the
       *  place-ahead UI (which stacks/overlaps multiple placements) or the
       *  construction wait. Each is born `isConstructed` at full HP. */
      prebuiltStructures?: ReadonlyArray<{ kind: StructureKindId; x: number; y: number }>;
      /** Structures plan (Phase 5) — park idle drones at poses (turret targets).
       *  testMode-only; for the turret-fires scenario. */
      scenarioDrones?: ReadonlyArray<{ x: number; y: number }>;
      /** Structures plan (Phase 4) — seed asteroids at poses (miner targets).
       *  testMode-only; for the mining scenario. */
      scenarioAsteroids?: ReadonlyArray<{ x: number; y: number; radius?: number }>;
      /** Wave-system (2026-06-10) — override the PLAYER warp spool (ms). The
       *  production default is `SPOOL_DURATION_MS` (5 min); E2E can't wait that
       *  long, so testMode rooms inject e.g. 2_000. testMode-only. NOTE: this
       *  reaches the player `TransitOrchestrator` only — drone-squad spool is
       *  driven by the director's own `spoolMs` option / `EQX_BOT_SPOOL_MS`. */
      transitSpoolMsOverride?: number;
    };
    this.testMode = roomOpts.testMode ?? false;
    this.disableCollisionDamage = this.testMode && (roomOpts.disableCollisionDamage ?? false);
    // Default 1.0 (no acceleration). Only honoured when testMode is true,
    // so a malicious / mis-targeted galaxy join can't ever speed it up.
    this.testTimeScale = this.testMode ? Math.max(1, roomOpts.testTimeScale ?? 1) : 1;
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
    const useDronePoses = this.testMode && Array.isArray(roomOpts.dronePoses) && roomOpts.dronePoses.length > 0;
    const useStructurePoses = this.testMode && Array.isArray(roomOpts.structurePoses) && roomOpts.structurePoses.length > 0;
    const asteroidRoster =
      (useBulkSeed || useSingleAsteroid || useDronePoses || useStructurePoses) ? [] : (roomOpts.asteroidConfig ?? ASTEROIDS);

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

    // Per-tick weapon-mount aim updater. Owns playerMountAngles +
    // droneMountAngles + the sticky targets + the pooled scratches.
    // Extracted from SectorRoom (commit 21 of v3 refactor plan).
    this.mountTicker = new WeaponMountTicker({
      sabF32: this.sabF32,
      playerToSlot: this.playerToSlot,
      swarmRegistry: this.swarmRegistry,
      shipPoseCache: this.shipPoseCache,
      getActiveShip: (pid) => this.getActiveShip(pid),
      aiController: this.aiController,
      swarmHealth: () => this.swarmHealth,
      resolveSlotMounts: (kind, slotId) => this.resolveSlotMounts(kind, slotId),
    });

    // Atomic ship→wreck conversion + wreck destruction. Owns the
    // wreckTo/From/Pose maps + the diagnostic counter. The 8-collaborator
    // transaction lives here; the room provides the rest of the world
    // (slot maps, identity maps, snapshot ring, schema). Extracted to
    // WreckLifecycleCoordinator.ts (commit 15 of v3 refactor plan).
    this.wreckCoordinator = new WreckLifecycleCoordinator({
      getActiveShip: (pid) => this.getActiveShip(pid),
      newWreckState: () => new WreckState(),
      state: this.state,
      sabF32: this.sabF32,
      shipPoseCache: this.shipPoseCache,
      lingeringSlots: this.lingeringSlots,
      lingeringPoseCache: this.lingeringPoseCache,
      ownerlessShips: this.ownerlessShips,
      playerToSlot: this.playerToSlot,
      slotToPlayer: this.slotToPlayer,
      freeSlots: this.freeSlots,
      lastFireClientTick: this.lastFireClientTick,
      initialSpawnPositions: this.initialSpawnPositions,
      mountTicker: this.mountTicker,
      playerToActiveShipInstance: this.playerToActiveShipInstance,
      playerToSession: this.playerToSession,
      sessionToPlayer: this.sessionToPlayer,
      playerToUser: this.playerToUser,
      snapshotRing: this.snapshotRing,
      clients: this.clients,
      postToWorker: (cmd) => this.postToWorker(cmd),
      sectorKey: () => this.sectorKey,
      logger,
      serverLogEvent,
    });

    // Player weapon-fire resolver. Owns the zod parse, cooldown gate,
    // lag-comp rewind, 4-target sweep (other players, lingering hulls,
    // swarm, wrecks), and the aggregate hit_ack. Per-mount laser_fired
    // broadcast per resolved fire.
    this.playerFireResolver = new PlayerFireResolver({
      sabF32: this.sabF32,
      serverTick: () => this.serverTick,
      sessionToPlayer: this.sessionToPlayer,
      getActiveShip: (pid) => this.getActiveShip(pid),
      lastFireClientTick: this.lastFireClientTick,
      snapshotRing: this.snapshotRing,
      shipPoseCache: this.shipPoseCache,
      playerToSlot: this.playerToSlot,
      lingeringSlots: this.lingeringSlots,
      lingeringPoseCache: this.lingeringPoseCache,
      wreckToSlot: this.wreckCoordinator.wreckToSlot,
      swarmRegistry: this.swarmRegistry,
      playerMountAngles: this.mountTicker.playerMountAngles,
      resolveSlotMounts: (kind, slotId) => this.resolveSlotMounts(kind, slotId),
      mountWorldOrigin: (x, y, ang, m) => this.mountWorldOrigin(x, y, ang, m),
      playerHitscanDist: (s, fx, fy, dx, dy, md, cx, cy, ang) =>
        this.playerHitscanDist(s, fx, fy, dx, dy, md, cx, cy, ang),
      spawnServerProjectile: (ownerId, x, y, vx, vy, dmg, r, mt, wId) =>
        this.spawnServerProjectile(ownerId, x, y, vx, vy, dmg, r, mt, wId),
      spawnServerMissile: (ownerId, x, y, dx, dy, def) =>
        this.spawnServerMissile(ownerId, x, y, dx, dy, def),
      applyDamage: (targetId, shooterId, damage, hitX, hitY) =>
        this.applyDamage(targetId, shooterId, damage, hitX, hitY),
      broadcast: (type, msg) => this.broadcast(type, msg),
      serverLogEvent,
      logger,
    });

    // AI drone weapon-fire resolver. Composes the per-mount hitscan +
    // laser_fired broadcast path that mirrors the player handleFire.
    this.aiFireResolver = new AiFireResolver({
      lastFireClientTick: this.lastFireClientTick,
      swarmEntitySnapshot: (id) => this.swarmEntitySnapshot(id),
      swarmRegistry: this.swarmRegistry,
      resolveSlotMounts: (kind, slotId) => this.resolveSlotMounts(kind, slotId),
      mountWorldOrigin: (x, y, ang, m) => this.mountWorldOrigin(x, y, ang, m),
      droneMountAngles: this.mountTicker.droneMountAngles,
      playerToSlot: this.playerToSlot,
      getActiveShip: (pid) => this.getActiveShip(pid),
      shipPoseCache: this.shipPoseCache,
      playerHitscanDist: (s, fx, fy, dx, dy, md, cx, cy, ang) =>
        this.playerHitscanDist(s, fx, fy, dx, dy, md, cx, cy, ang),
      applyDamage: (targetId, shooterId, damage) =>
        this.applyDamage(targetId, shooterId, damage),
      // Wave-system Phase 2: the beam also tests this tick's hostile-structure
      // circles (rebuilt once per tick by `fillStructureTargets`). Same
      // faction-filtered set the drone's body target chose among, so the beam
      // lands on the structure it's pointed at.
      structureHitTargets: () => this.hostileStructureCircles,
      broadcast: (type, msg) => this.broadcast(type, msg),
      spawnServerProjectile: (ownerId, x, y, vx, vy, dmg, r, mt, wId) =>
        this.spawnServerProjectile(ownerId, x, y, vx, vy, dmg, r, mt, wId),
      spawnServerMissile: (ownerId, x, y, dx, dy, def) =>
        this.spawnServerMissile(ownerId, x, y, dx, dy, def),
    });

    // Two-layer shield/hull damage + regen routing. Owns the swarm-side
    // shield state + the three layered-damage methods. Composes the pure
    // applyLayeredDamage + regenStep core with the room's bus / broadcast
    // / postToWorker / serverLogEvent seams.
    this.shieldHullRouter = new ShieldHullRouter({
      serverTick: () => this.serverTick,
      shipsMap: this.state.ships,
      swarmRegistry: this.swarmRegistry,
      bus: this.bus,
      serverLogEvent,
      postToWorker: (cmd) => this.postToWorker(cmd),
      broadcast: (type, msg) => this.broadcast(type, msg),
    });

    // Damage routing. Four branches (wreck / lingering / active /
    // swarm), each composing ShieldHullRouter + WreckLifecycleCoordinator
    // + evictSwarmEntity. Extracted to DamageRouter.ts.
    this.damageRouter = new DamageRouter({
      serverTick: () => this.serverTick,
      shipsMap: this.state.ships,
      wrecksMap: this.state.wrecks,
      shipPoseCache: this.shipPoseCache,
      lingeringSlots: this.lingeringSlots,
      lingeringPoseCache: this.lingeringPoseCache,
      wreckPoseCache: this.wreckCoordinator.wreckPoseCache,
      destroyWreck: (id) => this.destroyWreck(id),
      freeSlots: this.freeSlots,
      shieldHullRouter: this.shieldHullRouter,
      getActiveShip: (pid) => this.getActiveShip(pid),
      sabF32: this.sabF32,
      swarmRegistry: this.swarmRegistry,
      evictSwarmEntity: (rec, opts) => this.evictSwarmEntity(rec as SwarmEntityRecord, opts),
      aiController: this.aiController,
      bus: this.bus,
      broadcastDamage: (msg) => this.broadcast('damage', msg),
      broadcastDestroy: (msg) => this.broadcast('destroy', msg),
      postToWorker: (cmd) => this.postToWorker(cmd),
      logger,
      serverLogEvent,
    });

    // Roster persistence bridge — wraps the four getPlayerShipStore()
    // calls (bind on spawn, mark-linger on disconnect, mark-stored on
    // eviction, delete on destruction). Engineering rooms (sectorKey
    // null) make all 4 no-ops.
    this.rosterPersistence = new RosterPersistence({
      sectorKey: () => this.sectorKey,
      roomId: () => this.roomId,
      logger,
    });

    // Swarm entity eviction. Single canonical teardown for combat-kill
    // + LoadShedder + livingWorld bot despawn. Extracted to SwarmEvictor.ts.
    this.swarmEvictor = new SwarmEvictor({
      bus: this.bus,
      logger,
      broadcastDestroy: (msg) => this.broadcast('destroy', msg),
      postToWorker: (cmd) => this.postToWorker(cmd),
      interestGrid: this.interestGrid,
      swarmRegistry: this.swarmRegistry,
      aiController: this.aiController,
      snapshotRing: this.snapshotRing,
      shieldHullRouter: this.shieldHullRouter,
      mountTicker: this.mountTicker,
      freeSlots: this.freeSlots,
    });

    // Player respawn handler. Composes worker proxy + SAB writer +
    // mount-ticker cleanup. Extracted to RespawnHandler.ts.
    this.respawnHandler = new RespawnHandler({
      sabF32: this.sabF32,
      sabU32: this.sabU32,
      serverTick: () => this.serverTick,
      testMode: this.testMode,
      defaultSpawnX: this.defaultSpawnX,
      defaultSpawnY: this.defaultSpawnY,
      sessionToPlayer: this.sessionToPlayer,
      playerToSlot: this.playerToSlot,
      getActiveShip: (pid) => this.getActiveShip(pid),
      initialSpawnPositions: this.initialSpawnPositions,
      shipPoseCache: this.shipPoseCache,
      lastFireClientTick: this.lastFireClientTick,
      mountTicker: this.mountTicker,
      postToWorker: (cmd) => this.postToWorker(cmd),
      logger,
    });

    // Server-side projectile lifecycle. Spawn + per-tick sweep + cleanup.
    // Composes the 4-pass (player / swarm / wreck / lingering) collision
    // sweep with the injected playerProjectileSweep (shield-vs-hull
    // routing). Extracted to ProjectilePipeline.ts.
    this.projectiles = new ProjectilePipeline({
      sabF32: this.sabF32,
      serverTick: () => this.serverTick,
      playerToSlot: this.playerToSlot,
      getActiveShip: (pid) => this.getActiveShip(pid),
      shipPoseCache: this.shipPoseCache,
      playerSweep: (ship, fx, fy, sx, sy, r, cx, cy, ang) =>
        this.playerProjectileSweep(ship, fx, fy, sx, sy, r, cx, cy, ang),
      swarmRegistry: this.swarmRegistry,
      wreckToSlot: this.wreckCoordinator.wreckToSlot,
      lingeringSlots: this.lingeringSlots,
      applyDamage: (targetId, shooterId, damage, hitX, hitY) =>
        this.applyDamage(targetId, shooterId, damage, hitX, hitY),
    });

    // Missile subsystem — guidance, splash damage, impulse queue. The
    // queue is drained each tick and posted to the physics worker as
    // MISSILE_IMPULSE commands; the worker has the live Rapier world.
    this.missileSim = new MissileSimulation({
      sabF32: this.sabF32,
      serverTick: () => this.serverTick,
      playerToSlot: this.playerToSlot,
      getActiveShip: (pid) => this.getActiveShip(pid),
      shipPoseCache: this.shipPoseCache,
      swarmRegistry: this.swarmRegistry,
      applyDamage: (targetId, shooterId, damage, hitX, hitY) =>
        this.applyDamage(targetId, shooterId, damage, hitX, hitY),
      broadcastFired: (msg) => this.broadcast('missile_fired', msg),
      broadcastDetonated: (msg) => this.broadcast('missile_detonated', msg),
      bus: this.bus,
      serverLogEvent,
    });

    // Phase 1 swift-otter — instantiate the per-room WebRTC channel
    // manager BEFORE the SnapshotBroadcaster so the manager reference
    // can be captured into the sendSnapshot DI seam below.
    //
    // 2026-05-29 — gate removed (was: `if (this.sectorKey !== null)`).
    // Phase 4 E2E uses engineering rooms (`?room=feel-test-25`,
    // `sectorKey === null`) so gating on sectorKey meant the server
    // silently ignored every `webrtc_offer`, the client timed out, and
    // the measurement showed `dc_connected=false` across the board.
    // The PeerConnection isn't constructed until an offer actually
    // arrives (factory runs on `handleOffer`), so the cost on rooms
    // that never see a `?webrtc=1` client is zero — fine to create on
    // every room and let opt-in drive the actual binding load.
    this.webrtcChannelManager = new WebRtcChannelManager({
      peerConnectionFactory: nodeDataChannelPeerConnectionFactory({
        // STUN URL defaults to Google's freebie — works LAN + open
        // internet without TURN. TURN deployment for NAT-restricted
        // clients is scoped as a separate plan (hostile review #14).
        iceServers: ['stun:stun.l.google.com:19302'],
      }),
      sendAnswer: (sessionId, sdp) => {
        const client = this.clients.find((c) => c.sessionId === sessionId);
        if (client) client.send('webrtc_answer', { type: 'webrtc_answer', sdp });
      },
      sendCandidate: (sessionId, candidate, mid) => {
        const client = this.clients.find((c) => c.sessionId === sessionId);
        if (client) client.send('webrtc_ice', { type: 'webrtc_ice', candidate, mid });
      },
      serverLogEvent,
      logger,
    });

    // Per-client snapshot broadcaster. Owns broadcastCounter,
    // sabAppliedTicks, lastInputCaches, interestScratch. Composes the
    // per-client 20Hz phase-staggered loop with the global "all alive
    // ships" digest. Extracted to SnapshotBroadcaster.ts.
    this.snapshotBroadcaster = new SnapshotBroadcaster({
      serverTick: () => this.serverTick,
      sabU32: this.sabU32,
      clients: this.clients,
      sessionToPlayer: this.sessionToPlayer,
      playerToSlot: this.playerToSlot,
      getActiveShip: (pid) => this.getActiveShip(pid),
      shipPoseCache: this.shipPoseCache,
      lingeringSlots: this.lingeringSlots,
      lingeringPoseCache: this.lingeringPoseCache,
      shipsMap: this.state.ships,
      wreckPoseCache: this.wreckCoordinator.wreckPoseCache,
      liveProjectiles: this.projectiles.liveProjectiles,
      boostingPlayers: this.boostingPlayers,
      thrustingPlayers: this.thrustingPlayers,
      swarmRegistry: this.swarmRegistry,
      swarmHealth: this.swarmHealth,
      playerMountAngles: this.mountTicker.playerMountAngles,
      droneMountAngles: this.mountTicker.droneMountAngles,
      missileSim: this.missileSim,
      logger,
      serverLogEvent,
      // Phase 1 swift-otter DI seam — when the WebRtc manager is live
      // (galaxy rooms), route via DC with WS fallback; on engineering
      // rooms the seam stays undefined and the legacy WS-only path runs.
      sendSnapshot: (client, snap) => {
        // The manager owns the routing decision (sendable + degraded
        // + buffered + try/catch). `onFallback` is the WS path; the
        // manager invokes it synchronously when DC is unavailable.
        // Non-null assertion is safe here — the manager is always
        // constructed above (the previous `sectorKey === null` gate
        // was removed 2026-05-29).
        this.webrtcChannelManager!.sendSnapshot(
          client.sessionId,
          snap,
          () => { client.send('snapshot', snap); },
        );
      },
      // Structures plan, Phase 3 — the cached slice (rebuilt at the 1 Hz grid
      // pulse / on placement), attached by reference to every recipient.
      getStructuresSlice: () => this.structuresSlice,
    });

    // Player onLeave handler. Three branches: shouldLinger / transit-
    // in-flight / despawn. Extracted to LeaveHandler.ts.
    this.leaveHandler = new LeaveHandler({
      sabF32: this.sabF32,
      sectorKey: () => this.sectorKey,
      shipsMap: this.state.ships,
      sessionToPlayer: this.sessionToPlayer,
      playerToSession: this.playerToSession,
      playerToSlot: this.playerToSlot,
      slotToPlayer: this.slotToPlayer,
      freeSlots: this.freeSlots,
      lastFireClientTick: this.lastFireClientTick,
      initialSpawnPositions: this.initialSpawnPositions,
      shipPoseCache: this.shipPoseCache,
      playerToUser: this.playerToUser,
      playerToActiveShipInstance: this.playerToActiveShipInstance,
      playerToTransitInFlight: this.playerToTransitInFlight,
      ownerlessShips: this.ownerlessShips,
      lingerMs: (pid) => this.playerToLingerMs.get(pid),
      clearLingerMs: (pid) => { this.playerToLingerMs.delete(pid); },
      boostingPlayers: this.boostingPlayers,
      thrustingPlayers: this.thrustingPlayers,
      snapshotBroadcaster: this.snapshotBroadcaster,
      snapshotRing: this.snapshotRing,
      mountTicker: this.mountTicker,
      rosterPersistence: this.rosterPersistence,
      getActiveShip: (pid) => this.getActiveShip(pid),
      resolveActiveShipKey: (pid) => this.resolveActiveShipKey(pid),
      aiController: this.aiController,
      cancelTransit: (pid, reason) => { this.transitOrchestrator?.cancelTransit(pid, reason); },
      evictOwnerlessShip: (id) => this.evictOwnerlessShip(id),
      postToWorker: (cmd) => this.postToWorker(cmd),
      bus: this.bus,
      logger,
      serverLogEvent,
    });

    // Ownerless-ship eviction (TTL expiry + lingering destruction
    // tail). Composes the wreck-keyed Limbo delete + roster mark-stored.
    this.ownerlessShipEvictor = new OwnerlessShipEvictor({
      sabF32: this.sabF32,
      sectorKey: () => this.sectorKey,
      shipsMap: this.state.ships,
      ownerlessShips: this.ownerlessShips,
      lingeringSlots: this.lingeringSlots,
      lingeringPoseCache: this.lingeringPoseCache,
      playerToSlot: this.playerToSlot,
      slotToPlayer: this.slotToPlayer,
      freeSlots: this.freeSlots,
      lastFireClientTick: this.lastFireClientTick,
      initialSpawnPositions: this.initialSpawnPositions,
      shipPoseCache: this.shipPoseCache,
      playerToUser: this.playerToUser,
      playerToActiveShipInstance: this.playerToActiveShipInstance,
      snapshotRing: this.snapshotRing,
      mountTicker: this.mountTicker,
      rosterPersistence: this.rosterPersistence,
      postToWorker: (cmd) => this.postToWorker(cmd),
      bus: this.bus,
      logger,
      serverLogEvent,
    });

    // Sector volatile-state persistence. Galaxy-only — engineering
    // rooms have no persistent identity. Snapshots swarm health every
    // 60 s + onDispose; hydrates on onCreate.
    this.sectorPersistence = new SectorPersistence({
      sectorKey: () => this.sectorKey,
      sabF32: this.sabF32,
      swarmRegistry: this.swarmRegistry,
      swarmHealth: this.shieldHullRouter.swarmHealth,
      logger,
    });

    // Per-client binary swarm packet broadcaster. Encodes the swarm
    // packet per-client with the 9-cell interest window (Phase 5d).
    // The interestScratch Set populated here is REUSED by the snapshot
    // broadcaster's drone slice (same per-(client,tick) cell window).
    this.swarmBroadcaster = new SwarmBroadcaster({
      serverTick: () => this.serverTick,
      sabF32: this.sabF32,
      sabU32: this.sabU32,
      clients: this.clients,
      sessionToPlayer: this.sessionToPlayer,
      playerToSlot: this.playerToSlot,
      interestGrid: this.interestGrid,
      swarmRegistry: this.swarmRegistry,
      swarmEncoder: this.swarmEncoder,
      snapshotBroadcaster: this.snapshotBroadcaster,
      logger,
    });

    // GEP B4 — the single orchestration entry point for per-tick entity sync.
    // Routes pose-core binary FIRST (builds interestScratch), then the json-slice
    // snapshot slices (reuse it — HC#4), evaluating sector-idle between the two
    // sends exactly where update() used to (backpressure order preserved). The
    // idle closure is built ONCE here (no per-tick closure alloc, #14); its inner
    // options object is built per tick exactly as before. Construction also runs a
    // boot-time SyncProfile.transport governance check (makes `transport`
    // load-bearing). The proven broadcasters keep the byte-level encoding.
    this.entitySync = new EntitySyncRouter({
      swarmBroadcaster: this.swarmBroadcaster,
      snapshotBroadcaster: this.snapshotBroadcaster,
      evaluateSectorIdle: () =>
        evaluateSectorIdle({
          idleTracker: this.idleTracker,
          serverTick: this.serverTick,
          shipPoseCache: this.shipPoseCache,
          liveProjectiles: this.liveProjectiles,
          connectedClientCount: this.clients.length,
          swarmEntityCount: this.swarmRegistry.size(),
          forceBroadcastUntilTick: this.forceBroadcastUntilTick,
          idleMotionEpsilonSq: IDLE_MOTION_EPSILON_SQ,
          idleThresholdTicks: IDLE_THRESHOLD_TICKS,
        }),
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
      // `peacefulDrones` swaps the hostile-pursuit behaviour for the
      // zero-impulse passive one. Used by engineering rooms (shield-test)
      // where the player needs a stationary drone gallery for collision
      // testing without combat noise. Drones still die normally — only
      // the COMBAT pursue+fire path is suppressed.
      droneBehaviour: roomOpts.peacefulDrones
        ? () => new PassiveDroneBehaviour()
        : (kind) => new HostileDroneBehaviour(kind),
      interestGrid: this.interestGrid,
      registerLagComp: (id) => this.snapshotRing.registerEntity(id),
      ...(pickDroneKind ? { pickDroneKind } : {}),
    });
    const seeded = this.swarmSpawner.seedAsteroids(asteroidRoster);
    if (seeded < asteroidRoster.length) {
      logger.error({ requested: asteroidRoster.length, seeded }, 'swarm spawner: not all asteroids seeded (slot pool exhausted)');
    }

    // ── Structure placement (structures plan, Phase 2) ──────────────────
    // Decision logic over injected concretions (spawn / health-seed / despawn /
    // clamp / id). A placed structure rides the existing kind=2 swarm path, so
    // it broadcasts + takes damage for free; the only structure-specific seam
    // is `swarmHealth` (presence = damageable) + the StructureRegistry record.
    this.structurePlacement = new StructurePlacementSubsystem({
      spawnStructure: (s) => this.swarmSpawner.spawnStructure(s),
      seedHealth: (id, hp) => {
        this.swarmHealth.set(id, hp);
        this.swarmShield.set(id, 0); // no shield layer — hits land on the hull
      },
      despawn: (id) => {
        const rec = this.swarmRegistry.get(id);
        if (rec) this.evictSwarmEntity(rec, { broadcast: true, emitDestroyed: false });
        this.swarmHealth.delete(id);
        this.swarmShield.delete(id);
      },
      clamp: (x, y) => {
        const c = clampToSectorBounds(x, y);
        return { x: c.x, y: c.y };
      },
      nextId: () => `pstruct-${this.placedStructureCounter++}`,
      registry: this.structureRegistry,
      // Item D — asteroids (swarm kind=0) block a connector's line of sight, so
      // a structure never auto-wires straight through a rock. Poses read live
      // from the SAB (same path as findNearestSwarmOfKind); radius from the
      // registry record. Off the 60 Hz hot loop (runs only on placement), so the
      // array build here is fine.
      getObstacles: () => {
        const obstacles: GridObstacle[] = [];
        for (const rec of this.swarmRegistry.all()) {
          if (rec.kind !== 0) continue; // asteroids only
          const base = slotBase(rec.slot);
          obstacles.push({
            x: this.sabF32[base + SLOT_X_OFF]!,
            y: this.sabF32[base + SLOT_Y_OFF]!,
            radius: rec.radius,
          });
        }
        return obstacles;
      },
    });

    // ── Structure grid pulse (structures plan, Phase 3) ─────────────────
    // The 1 Hz logistics heartbeat: construction flow, repair, deconstruction,
    // power aggregation. Runs OFF the 60 Hz physics tick (unref'd timer).
    this.structureGrid = new StructureGridSubsystem({
      registry: this.structureRegistry,
      getHealth: (id) => this.swarmHealth.get(id) ?? 0,
      setHealth: (id, hp) => { this.swarmHealth.set(id, hp); },
      despawn: (id) => {
        const rec = this.swarmRegistry.get(id);
        if (rec) this.evictSwarmEntity(rec, { broadcast: true, emitDestroyed: false });
        this.swarmHealth.delete(id);
        this.swarmShield.delete(id);
      },
      findNearestAsteroid: (x, y, range) => this.findNearestAsteroid(x, y, range),
      findNearestDrone: (x, y, range) => this.findNearestSwarmOfKind(x, y, range, 1),
      applyDamage: (targetId, shooterId, damage) => this.applyDamage(targetId, shooterId, damage),
      broadcastBeam: (shooterId, fromX, fromY, toX, toY, targetId) => {
        this.broadcast('laser_fired', {
          type: 'laser_fired',
          shooterId,
          fromX, fromY, toX, toY,
          hit: true,
          targetId,
        });
      },
    });
    const pulseMs = this.testMode && roomOpts.structureGridPulseMs
      ? Math.max(20, roomOpts.structureGridPulseMs)
      : TRANSFER_PULSE_MS;
    this.structureGridTimer = setInterval(() => this.structureGridTick(), pulseMs);
    this.structureGridTimer.unref?.();
    // Phase 5 — turret aim/fire on a faster cadence than the grid pulse.
    this.structureTurretTimer = setInterval(() => this.structureTurretTick(), TURRET_TICK_MS);
    this.structureTurretTimer.unref?.();

    // Click-to-inspect live-stats channel (structures follow-up Item B5). Its
    // own ~5 Hz timer (200 ms), unref'd + OFF the snapshot/physics tick — the
    // emitter only does work while a client has an entity selected.
    this.selectionStats = new SelectionStatsSubsystem({
      resolveStats: (sel) => this.resolveSelectionStats(sel),
      sendTo: (sessionId, msg) => {
        const client = this.clients.find((c) => c.sessionId === sessionId);
        client?.send('entity_stats', msg);
      },
    });
    this.selectionStatsTimer = setInterval(() => this.selectionStats.tick(), SELECTION_STATS_INTERVAL_MS);
    this.selectionStatsTimer.unref?.();

    // Structures plan (Phase 3-5) — testMode scenario seeding: a pre-built,
    // powered grid + drones/asteroids, for deterministic E2E (no place-ahead
    // overlap, no construction wait).
    if (this.testMode) this.seedStructureScenario(roomOpts);

    // Living World bot lifecycle hooks (spawn/despawn/markHostile).
    // These satisfy the LivingWorldRoom contract; bots are server-
    // internal swarm entities, NOT Colyseus clients.
    this.livingWorldBotHooks = new LivingWorldBotHooks({
      serverTick: () => this.serverTick,
      sectorKey: () => this.sectorKey,
      sabF32: this.sabF32,
      playerToSlot: this.playerToSlot,
      getActiveShip: (pid) => this.getActiveShip(pid),
      swarmHealth: this.shieldHullRouter.swarmHealth,
      swarmRegistry: this.swarmRegistry,
      swarmSpawner: this.swarmSpawner,
      aiController: this.aiController,
      evictSwarmEntity: (rec, opts) => this.evictSwarmEntity(rec, opts),
      extendBroadcastGrace: (untilTick) => { this.forceBroadcastUntilTick = untilTick; },
      joinBroadcastGraceTicks: JOIN_BROADCAST_GRACE_TICKS,
      broadcastWarpIn: (msg) => this.broadcast('warp_in', msg),
      broadcastWarpOut: (msg) => this.broadcast('warp_out', msg),
      broadcastBotAggro: (msg) => this.broadcast('bot_aggro', msg),
      bus: this.bus,
      clients: this.clients,
    });

    if (useSingleAsteroid) {
      // Stationary asteroid 600 u from spawn — far enough that the worker's
      // sleep hysteresis (12 ticks at v ≈ 0) trips quickly without the
      // player accidentally bumping it. No drone, no AI behaviour wired.
      this.swarmSpawner.spawnAsteroid({ id: 'sleep-rock', x: 600, y: 0, vx: 0, vy: 0, radius: 24, mass: 1 });
      logger.info('Phase 5e single-asteroid sleep test seed');
    } else if (useDronePoses) {
      // 2026-05-28 — deterministic-pose engineering seed. Each entry forces a
      // drone to a specific world `(x, y, angle)` (bypassing the uniform-disc
      // spawner), and optionally drops shields immediately so the
      // hull-polygon collider is exposed at spawn. Used by the
      // `hull-collision-test` room to verify that a concave T-ship's
      // polygon collider correctly leaves the gap regions empty.
      const poses = roomOpts.dronePoses!;
      let placed = 0;
      for (let i = 0; i < poses.length; i++) {
        const pose = poses[i]!;
        const droneId = `pose-drone-${i}`;
        const ok = this.swarmSpawner.spawnDrone({ id: droneId, x: pose.x, y: pose.y, kind: pose.kind });
        if (!ok) {
          logger.error({ requested: poses.length, spawned: placed }, 'dronePoses spawn truncated (slot pool exhausted)');
          break;
        }
        const rec = this.swarmRegistry.get(droneId);
        if (!rec) continue;
        this.swarmHealth.set(droneId, getDroneMaxHealth(rec.shipKind) ?? 40);
        this.swarmShield.set(droneId, getDroneShieldMax(rec.shipKind));
        this.swarmShieldLastDmg.set(droneId, this.serverTick);
        // Apply rotation via SET_POSITION (SPAWN_OBSTACLE sets pos+vel only,
        // angle defaults to 0). The worker processes this command AFTER the
        // SPAWN_OBSTACLE that spawnDrone just enqueued, so the body exists.
        // Also seed the registry's lastBroadcast.angle so the very first
        // delta-detector decision uses the correct reference.
        const angle = pose.angle ?? 0;
        if (angle !== 0) {
          this.postToWorker({
            type: 'SET_POSITION',
            entityId: droneId, x: pose.x, y: pose.y, angle, vx: 0, vy: 0, angvel: 0,
          });
          rec.lastBroadcast.angle = angle;
        }
        if (pose.hullExposed) {
          // Force shield-down at spawn: clear the shield slot, flip the
          // registry's wire flag, post SET_HULL_EXPOSED so Rapier swaps to
          // the polygon collider. Mirrors `ShieldHullRouter`'s 0-cross path
          // minus the discrete `shield_broken` broadcast (no client cares
          // at room-boot time; subsequent regen will fire the normal events).
          this.swarmShield.set(droneId, 0);
          rec.shieldDown = true;
          this.postToWorker({
            type: 'SET_HULL_EXPOSED',
            id: droneId,
            exposed: true,
            kindId: rec.shipKind ?? DEFAULT_SHIP_KIND,
            tick: this.serverTick,
          });
        }
        placed++;
      }
      logger.info({ requested: poses.length, spawned: placed }, 'dronePoses seeded');
    } else if (useStructurePoses) {
      // Generic Entity Pipeline P4 — deterministic STRUCTURE placement (the
      // "for free" proof). Each structure is a kind=2 swarm entity; seeding
      // `swarmHealth` is the ONLY thing that makes it damageable — the existing
      // DamageRouter 'swarm' strategy then handles it with ZERO new dispatch.
      // `swarmShield = 0` (no shield layer) so a hit lands straight on the hull.
      const poses = roomOpts.structurePoses!;
      let placed = 0;
      for (let i = 0; i < poses.length; i++) {
        const p = poses[i]!;
        const id = p.id ?? `structure-${i}`;
        const ok = this.swarmSpawner.spawnStructure({ id, x: p.x, y: p.y, radius: p.radius ?? 50, mass: p.mass });
        if (!ok) {
          logger.error({ requested: poses.length, spawned: placed }, 'structurePoses spawn truncated (slot pool exhausted)');
          break;
        }
        this.swarmHealth.set(id, STRUCTURE_DEFAULT_HEALTH);
        this.swarmShield.set(id, 0);
        placed++;
      }
      logger.info({ requested: poses.length, spawned: placed }, 'structurePoses seeded');
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

    // Paradigm plan (quirky-rabbit) Phase 6 — fan server GC pauses out to
    // this room's clients. The subscriber is called synchronously inside
    // the GC observer; the broadcast just enqueues into each WS buffer,
    // which is the cheap operation that contract demands.
    this.gcPauseSubscriber = (event: GcPauseEvent): void => {
      const msg: GcPauseEventMessage = {
        type: 'gc_pause',
        durationMs: event.durationMs,
        kind: event.kind,
      };
      this.broadcast('gc_pause', msg);
    };
    subscribeGcPause(this.gcPauseSubscriber);

    // Phase 8 sub-phase B — per-room transit driver. Engineering rooms get
    // an orchestrator too, but it'll always reject `engage_transit` because
    // sectorKey is null (the orchestrator validates and sends back DOCKED).
    //
    // Phase 5 — the orchestrator gets `PlayerShipStore` so it can validate
    // ownership when `engage_transit` carries a `shipId`. Without the store
    // a shipId-carrying request rejects as unknown, which is safe-by-default.
    // Wave-system: testMode rooms may inject a fast player spool so E2E never
    // waits the 5-min production `SPOOL_DURATION_MS`. Galaxy gameplay always
    // gets the real spool (the override is testMode-gated, like testTimeScale).
    const transitSpoolMs =
      this.testMode && roomOpts.transitSpoolMsOverride != null
        ? Math.max(1, roomOpts.transitSpoolMsOverride)
        : undefined;
    this.transitOrchestrator = new TransitOrchestrator(
      this.asTransitHost(),
      getLimboStore(),
      transitSpoolMs,
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

    this.onMessage('input', makeInputHandler({
      sessionToPlayer: this.sessionToPlayer,
      inputCountThisTick: this.inputCountThisTick,
      maxInputsPerTick: MAX_INPUTS_PER_TICK,
      playerToSlot: this.playerToSlot,
      boostingPlayers: this.boostingPlayers,
      thrustingPlayers: this.thrustingPlayers,
      postToWorker: (cmd) => this.postToWorker(cmd),
      serverTick: () => this.serverTick,
      shipEnergyOf: (playerId) => this.getActiveShip(playerId)?.energy,
      logger,
    }));

    this.onMessage('fire', (client: Client, raw: unknown) => {
      this.handleFire(client, raw);
    });

    this.onMessage('respawn', (client: Client) => {
      this.handleRespawn(client);
    });

    // Plan: crispy-kazoo, Commit 2 — synchronised warp-in handshake.
    // Client signals it has finished bootstrapping; server picks an
    // `arrivalTick` and broadcasts `warp_in` to ALL clients (including
    // the joiner) so the curtain drop + warp-in animation fires in
    // sync everywhere. Idempotent — duplicate sends are dropped.
    this.onMessage('client_ready', (client: Client, raw: unknown) => {
      const parsed = ClientReadyMessageSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed client_ready');
        return;
      }
      this.handleClientReady(client);
    });

    // ── Structures plan, Phase 2 — placement / removal ──────────────────
    this.onMessage('place_structure', (client: Client, raw: unknown) => {
      const parsed = PlaceStructureSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed place_structure');
        return;
      }
      const owner = this.sessionToPlayer.get(client.sessionId);
      if (!owner) return;
      const id = this.structurePlacement.place(
        owner,
        parsed.data.kind,
        parsed.data.x,
        parsed.data.y,
      );
      if (id === null) {
        logger.warn({ sessionId: client.sessionId, kind: parsed.data.kind }, 'place_structure rejected');
      } else {
        // Refresh the slice so the new blueprint + its auto-connection appear on
        // the next snapshot without waiting for the 1 Hz pulse.
        this.rebuildStructuresSlice();
      }
    });

    this.onMessage('remove_structure', (client: Client, raw: unknown) => {
      const parsed = RemoveStructureSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed remove_structure');
        return;
      }
      const owner = this.sessionToPlayer.get(client.sessionId);
      if (!owner) return;
      if (this.structurePlacement.remove(owner, parsed.data.id)) {
        this.rebuildStructuresSlice();
      }
    });

    // ── Click-to-inspect selection-scoped live-stats channel (Item B5) ──────
    // The renderer tells the main thread which entity is selected; the client
    // forwards ship/structure selections here. The ~5 Hz emit happens on
    // `selectionStatsTimer` (off the hot path); these handlers only register /
    // clear the per-connection selection. Per-session cleanup on disconnect /
    // transit lives in `onLeave` (no 5 Hz leak).
    this.onMessage('select_entity', (client: Client, raw: unknown) => {
      const parsed = SelectEntitySchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed select_entity');
        return;
      }
      this.selectionStats.select(client.sessionId, parsed.data.id, parsed.data.kind);
    });

    this.onMessage('deselect_entity', (client: Client, raw: unknown) => {
      const parsed = DeselectEntitySchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed deselect_entity');
        return;
      }
      this.selectionStats.deselect(client.sessionId);
    });

    // ── Phase 1 swift-otter — WebRTC signaling handlers ─────────────────
    //
    // Client is the offerer; server is the answerer. Drop silently on
    // schema failure per the validation contract — sampled warn so a
    // malicious client can't flood the log. The manager handles
    // out-of-order ICE (counts iceDroppedBeforeOffer if a candidate
    // arrives before the offer).
    this.onMessage('webrtc_offer', (client: Client, raw: unknown) => {
      const parsed = WebRtcOfferMessageSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed webrtc_offer');
        return;
      }
      this.webrtcChannelManager?.handleOffer(client.sessionId, parsed.data.sdp);
    });

    this.onMessage('webrtc_ice', (client: Client, raw: unknown) => {
      const parsed = WebRtcIceMessageSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed webrtc_ice');
        return;
      }
      this.webrtcChannelManager?.handleIce(
        client.sessionId,
        parsed.data.candidate,
        parsed.data.mid,
      );
    });

    // Hostile #9 — client declares fallback explicitly. We clean up the
    // PC immediately (no waiting for ICE-deadline expiry) and ACK so the
    // client knows it can stop sending signaling.
    this.onMessage('webrtc_fallback', (client: Client, raw: unknown) => {
      const parsed = WebRtcFallbackMessageSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed webrtc_fallback');
        return;
      }
      serverLogEvent('webrtc_client_fallback', {
        sessionId: client.sessionId,
        reason: parsed.data.reason ?? 'unspecified',
      });
      this.webrtcChannelManager?.cleanup(client.sessionId);
      client.send('webrtc_fallback_ack', { type: 'webrtc_fallback_ack' });
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
  // Pure mount/slot geometry helpers moved to ./mountGeometry.ts. The
  // class still calls them via `this.resolveSlotMounts(...)` / `this.
  // mountWorldOrigin(...)` for minimal blast-radius — these thin
  // method-wrapper delegations preserve every existing call-site.
  private resolveSlotMounts(kind: ShipKind, slotId?: string): ReadonlyArray<WeaponMount> {
    return resolveSlotMounts(kind, slotId);
  }
  private mountWorldOrigin(
    shipX: number,
    shipY: number,
    shipAngle: number,
    mount: WeaponMount,
  ): { x: number; y: number } {
    return mountWorldOrigin(shipX, shipY, shipAngle, mount);
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
    this.mountTicker.tickPlayer();
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
    this.mountTicker.tickDrone();
  }

  private handleFire(client: Client, raw: unknown): void {
    this.playerFireResolver.resolve(client, raw);
  }


  /**
   * Build a read-only AiEntity snapshot for the given swarm id by reading SAB.
   * Used by AiController to feed live poses to behaviours each tick.
   *
   * 2026-05-31: pooled scratch (Invariant #14). Pre-fix this allocated a
   * fresh literal per drone per server tick (~15 × 60 = 900 allocs/sec).
   * Combined with HostileDroneBehaviour's per-tick AiIntent literals,
   * the V8 GC was firing major collections every ~1 s → 100-334 ms
   * stop-the-world pauses → `aiTick` phase blocking the snapshot
   * dispatch loop → user-reported chronic `recv_gap_long` 227-461 ms.
   * Capture `hlqxy6` + dispatch probe `tests/diag/server-dispatch-gap-probe.ts`.
   *
   * The caller (`AiController.runEntity` → `behaviour.tick(self, view)`)
   * reads the fields immediately and does not retain the reference, so
   * mutating a single shared object across calls is safe.
   */
  // `AiEntity` fields are typed `readonly` in the IAiBehaviour contract
  // — that's a contract-level read-only (callers must not mutate),
  // not a structural-level immutability. The pool writes through a
  // `Mutable<AiEntity>` view; consumers (`AiController.runEntity` →
  // `behaviour.tick(self, view)`) still see the original `readonly`
  // surface and treat fields as immutable.
  private readonly _aiEntityScratch: { -readonly [K in keyof AiEntity]: AiEntity[K] } = {
    id: '', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
  };
  private swarmEntitySnapshot(id: string): AiEntity | null {
    const rec = this.swarmRegistry.get(id);
    if (!rec) return null;
    const b = slotBase(rec.slot);
    const s = this._aiEntityScratch;
    s.id = id;
    s.x = this.sabF32[b + SLOT_X_OFF]!;
    s.y = this.sabF32[b + SLOT_Y_OFF]!;
    s.vx = this.sabF32[b + SLOT_VX_OFF]!;
    s.vy = this.sabF32[b + SLOT_VY_OFF]!;
    s.angle = this.sabF32[b + SLOT_ANGLE_OFF]!;
    s.angvel = this.sabF32[b + SLOT_ANGVEL_OFF]!;
    return s;
  }

  /**
   * Wave-system Phase 2 — rebuild this tick's hostile-structure target set,
   * shared by every drone (called ONCE per tick from `runAiTick`, never
   * per-drone — #14). A structure is a target iff its owning faction is
   * `hostileToDrones` (member attacked a drone) OR `underWave` (the director
   * declared a wave) AND it is constructed. Populates BOTH the brain view
   * (`out` = `aiStructureScratch`, carries `priority`) and the fire-resolver
   * hit circles (`this.hostileStructureCircles`, carries `radius`) in one
   * registry pass. Object churn matches the established `aiPlayerScratch`
   * view-build pattern (small, bounded structure count).
   */
  private fillStructureTargets(out: AiStructureView[]): void {
    const circles = this.hostileStructureCircles;
    circles.length = 0;
    if (this.structureRegistry.size === 0) return;
    for (const rec of this.structureRegistry.all()) {
      if (!rec.isConstructed) continue;
      if (!this.factionLedger.isHostileToDrones(rec.owner)) continue;
      out.push({
        id: rec.id,
        x: rec.x,
        y: rec.y,
        health: this.swarmHealth.get(rec.id),
        maxHealth: getStructureKind(rec.kind).maxHealth,
        priority: structurePriority(rec.kind),
      });
      circles.push({ id: rec.id, x: rec.x, y: rec.y, radius: rec.radius });
    }
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
    this.aiFireResolver.resolve(shooterId, dirX, dirY, tick);
  }

  private spawnServerProjectile(ownerId: string, x: number, y: number, vx: number, vy: number, damage: number, radius: number, maxTicks: number, weaponId: WeaponId): void {
    this.projectiles.spawn(ownerId, x, y, vx, vy, damage, radius, maxTicks, weaponId);
  }

  /** Hostility predicate the missile lock-on uses.
   *
   *  Player-fired missiles target any non-owner entity. Asteroid
   *  exclusion is handled at the candidate-build site in
   *  `MissileSimulation.lockOnTarget` (filtered by `rec.kind === 0`)
   *  rather than here, because galaxy asteroids spawn with bare
   *  `asteroid-N` ids — NO `swarm-` prefix — and string-prefix
   *  filtering misses them. Kind is the source of truth.
   *
   *  AI-fired missiles defer to the `aiController`'s hostility ledger
   *  (the existing `markHostile` / `bot_aggro` channel) — drones and
   *  bots only fire at players they've already been antagonised by.
   */
  private isMissileTargetHostile(ownerId: string): (targetId: string) => boolean {
    const isPlayerShooter = !ownerId.startsWith('swarm-') && !ownerId.startsWith('lwbot-');
    if (isPlayerShooter) {
      return (id) => id !== ownerId;
    }
    return (id) => this.aiController.isEntityHostileToPlayer(ownerId, id);
  }

  private spawnServerMissile(
    ownerId: string,
    spawnX: number,
    spawnY: number,
    dirX: number,
    dirY: number,
    def: MissileWeaponDef,
  ): number | null {
    return this.missileSim.spawn(
      ownerId, spawnX, spawnY, dirX, dirY, def,
      this.isMissileTargetHostile(ownerId),
    );
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
    return this.shieldHullRouter.damageShipLayered(ship, damage, workerBodyId);
  }

  private damageSwarmLayered(
    rec: { id: string; entityId: number; shipKind?: ShipKindId | null; shieldDown?: boolean },
    damage: number,
  ): { newShield: number; shieldMax: number; hullMax: number; hitLayer: 'shield' | 'hull' } | null {
    return this.shieldHullRouter.damageSwarmLayered(rec, damage);
  }

  private tickShieldRegen(): void {
    this.shieldHullRouter.tickShieldRegen();
  }

  /**
   * Energy authority (weapons/energy/AI overhaul §3.1). The single owner of
   * the energy pool lives on the main thread, alongside shield regen + the
   * fire-path drain. Each tick: regen every active ship's pool (no
   * post-spend delay — the bar always feels alive), then drain one boost
   * tick for every player currently boosting (`boostingPlayers` = boost held,
   * regardless of thrust). The boost bit was stripped in the input handler
   * when the pool couldn't afford a tick, so this drain can't drive it
   * negative; `spendEnergy` clamps at 0 anyway. Scalar core helpers ⇒ zero
   * per-tick allocation (Invariant #14).
   */
  private tickEnergy(): void {
    for (const [, ship] of this.state.ships) {
      if (!ship.isActive || !ship.alive) continue;
      const kind = getShipKind(ship.kind);
      ship.energy = regenEnergyStep(ship.energy, kind.energyMax ?? 100, kind.energyRegenRate ?? 0.25);
    }
    for (const playerId of this.boostingPlayers) {
      const ship = this.getActiveShip(playerId);
      if (!ship) continue;
      ship.energy = spendEnergy(ship.energy, BOOST_TICK_COST);
    }
  }

  private applyDamage(targetId: string, shooterId: string, damage: number, hitX?: number, hitY?: number): void {
    this.damageRouter.apply(targetId, shooterId, damage, hitX, hitY);
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
    // Structures plan, Phase 3 — a destroyed structure must sever its grid
    // connections (StructureRegistry.remove disconnects) so the web doesn't
    // keep a dangling edge. Idempotent: harmless if `rec` isn't a structure or
    // was already removed (e.g. by placement.remove / deconstruction).
    if (this.structureRegistry.has(rec.id)) {
      this.structureRegistry.remove(rec.id);
      this.rebuildStructuresSlice();
    }
    this.swarmEvictor.evict(rec, opts);
  }

  // ── Structure grid pulse (structures plan, Phase 3) ──────────────────────

  /** One 1 Hz grid heartbeat: pulse the logistics web, refresh the snapshot
   *  slice, and broadcast the discrete `grid_pulse` flash event. No-op (and no
   *  broadcast) when the sector has no structures. */
  private structureGridTick(): void {
    if (this.structureRegistry.size === 0) return;
    const result = this.structureGrid.pulse(Date.now());
    this.rebuildStructuresSlice();
    if (result.flashed.length > 0) {
      // Map the registry's string-id pairs to dense entityIds for the wire.
      const flashed: Array<[number, number]> = [];
      for (const [a, b] of result.flashed) {
        const ea = this.swarmRegistry.get(a)?.entityId;
        const eb = this.swarmRegistry.get(b)?.entityId;
        if (ea !== undefined && eb !== undefined) flashed.push([ea, eb]);
      }
      if (flashed.length > 0) {
        this.broadcast('grid_pulse', { type: 'grid_pulse', flashed, material: result.material });
      }
    }
  }

  /** Structures plan (Phase 3-5) — seed a testMode scenario: PRE-BUILT,
   *  auto-connected structures (owner `scenario`) + parked drones + asteroids.
   *  Gives E2E a fully-functional powered grid without the place-ahead UI
   *  (which overlaps stacked placements) or the construction wait. */
  private seedStructureScenario(roomOpts: {
    prebuiltStructures?: ReadonlyArray<{ kind: ShipKindId | string; x: number; y: number }>;
    scenarioDrones?: ReadonlyArray<{ x: number; y: number }>;
    scenarioAsteroids?: ReadonlyArray<{ x: number; y: number; radius?: number }>;
  }): void {
    const prebuilt = roomOpts.prebuiltStructures;
    if (prebuilt && prebuilt.length > 0) {
      for (const ps of prebuilt) {
        const id = this.structurePlacement.place('scenario', ps.kind as string, ps.x, ps.y);
        if (id === null) {
          logger.warn({ kind: ps.kind, x: ps.x, y: ps.y }, 'scenario prebuilt structure rejected');
          continue;
        }
        const rec = this.structureRegistry.get(id);
        if (rec && !rec.isConstructed) {
          rec.isConstructed = true;
          rec.constructionProgress = rec.constructionCost;
          this.swarmHealth.set(id, getStructureKind(rec.kind).maxHealth);
        }
      }
      this.structureRegistry.topologyDirty = true;
      // One pulse rebuilds the grid (powered components) + refreshes the slice.
      this.structureGridTick();
    }
    let scenarioSwarmId = 0;
    for (const a of roomOpts.scenarioAsteroids ?? []) {
      this.swarmSpawner.spawnAsteroid({
        id: `scenario-rock-${scenarioSwarmId++}`, x: a.x, y: a.y, vx: 0, vy: 0, radius: a.radius ?? 30, mass: 1,
      });
    }
    for (const d of roomOpts.scenarioDrones ?? []) {
      const droneId = `scenario-drone-${scenarioSwarmId++}`;
      if (this.swarmSpawner.spawnDrone({ id: droneId, x: d.x, y: d.y, kind: 'fighter' })) {
        this.swarmHealth.set(droneId, getDroneMaxHealth('fighter') ?? 40);
        this.swarmShield.set(droneId, 0); // hull exposed so turret damage lands
      }
    }
  }

  /** Phase 5 — turret aim/fire tick (faster cadence than the grid pulse).
   *  No-op when the sector has no structures. */
  private structureTurretTick(): void {
    if (this.structureRegistry.size === 0) return;
    this.structureGrid.tickTurrets(Date.now());
    // Refresh the slice so the client's turret aim line tracks at the turret
    // cadence (not just the 1 Hz pulse). Cheap — few structures, off the tick.
    this.rebuildStructuresSlice();
  }

  /** Phase 4 — nearest mineable asteroid (swarm kind 0) within `range` of
   *  (x, y). Reads authoritative poses from the SAB via each record's slot
   *  (asteroids are static, so this is their spawn pose). Low-frequency (1 Hz
   *  pulse), so the linear scan is fine. */
  private findNearestAsteroid(
    x: number,
    y: number,
    range: number,
  ): { entityId: number; x: number; y: number } | null {
    return this.findNearestSwarmOfKind(x, y, range, 0);
  }

  /** Nearest swarm entity of `swarmKind` (0=asteroid, 1=drone) within `range`
   *  of (x, y). Reads authoritative poses from the SAB via each record's slot.
   *  Low-frequency (1 Hz pulse / 100 ms turret tick), so the linear scan is
   *  fine. Returns the registry id (for damage) + entityId + pose. */
  private findNearestSwarmOfKind(
    x: number,
    y: number,
    range: number,
    swarmKind: number,
  ): { id: string; entityId: number; x: number; y: number } | null {
    let best: { id: string; entityId: number; x: number; y: number } | null = null;
    let bestD2 = range * range;
    for (const rec of this.swarmRegistry.all()) {
      if (rec.kind !== swarmKind) continue;
      const base = slotBase(rec.slot);
      const sx = this.sabF32[base + SLOT_X_OFF]!;
      const sy = this.sabF32[base + SLOT_Y_OFF]!;
      const dx = sx - x;
      const dy = sy - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = { id: rec.id, entityId: rec.entityId, x: sx, y: sy };
      }
    }
    return best;
  }

  /** Rebuild the cached structures snapshot slice from the registry + grid.
   *  Called at the 1 Hz pulse and after each placement/removal — never on the
   *  60 Hz tick, so the array allocation here is off the hot loop. */
  private rebuildStructuresSlice(): void {
    if (this.structureRegistry.size === 0) {
      this.structuresSlice = undefined;
      return;
    }
    const arr: NonNullable<SnapshotMessage['structures']> = [];
    for (const rec of this.structureRegistry.all()) {
      const entityId = this.swarmRegistry.get(rec.id)?.entityId;
      if (entityId === undefined) continue; // swarm entity gone — skip
      const summary = this.structureGrid.powerSummaryFor(rec.id);
      const conns = this.structureRegistry.connectionsOf(rec.id);
      const entry: NonNullable<SnapshotMessage['structures']>[number] = {
        id: entityId,
        powered: summary.powered,
        netPower: summary.netPower,
        built: rec.isConstructed,
      };
      if (conns.length > 0) {
        const connTo: number[] = [];
        for (const c of conns) {
          const other = c.getOtherNode(rec.id);
          if (other === null) continue;
          const otherEntityId = this.swarmRegistry.get(other)?.entityId;
          if (otherEntityId !== undefined) connTo.push(otherEntityId);
        }
        if (connTo.length > 0) entry.connTo = connTo;
      }
      if (rec.minerals > 0) entry.minerals = rec.minerals;
      if (!rec.isConstructed && rec.constructionCost > 0) {
        entry.buildPct = rec.constructionProgress / rec.constructionCost;
      }
      if (rec.isDeconstructing && rec.constructionCost > 0) {
        entry.deconstructPct = 1 - rec.constructionProgress / rec.constructionCost;
      }
      if (rec.miningTargetEntityId !== undefined) entry.miningTargetId = rec.miningTargetEntityId;
      if (rec.turretTargetEntityId !== undefined) entry.turretTargetId = rec.turretTargetEntityId;
      arr.push(entry);
    }
    this.structuresSlice = arr;
  }

  /**
   * Resolve live stats for a click-to-inspect selection (Item B5). Returns null
   * when the entity is gone (dead / despawned / lingering-only) — the
   * `SelectionStatsSubsystem` auto-clears the selection on null so the ~5 Hz
   * emitter never leaks. Only ship + structure ids reach here (drones/wrecks
   * read health client-side from the mirror).
   *
   *   - ship      → `id` is a playerId; resolve `state.ships.get(id)`. A
   *                 lingering hull (`isActive === false`) is treated as gone.
   *   - structure → `id` is the numeric swarm `entityId`; resolve the swarm
   *                 record → its registry id → `structureRegistry` + `swarmHealth`.
   */
  private resolveSelectionStats(sel: Selection): EntityStatsMessage | null {
    if (sel.kind === 'ship') {
      const ship = this.state.ships.get(sel.id);
      if (!ship || !ship.isActive || !ship.alive) return null;
      const kind = getShipKind(ship.kind);
      return {
        type: 'entity_stats',
        id: sel.id,
        kind: 'ship',
        name: ship.displayName,
        hp: Math.max(0, Math.round(ship.health)),
        hpMax: Math.round(ship.maxHealth),
        shield: Math.max(0, Math.round(ship.shield)),
        shieldMax: Math.round(kind.shieldMax),
      };
    }
    // structure — id is the numeric swarm entityId (as a string).
    const entityId = Number(sel.id);
    if (!Number.isFinite(entityId)) return null;
    const swarmRec = this.swarmRegistry.getByEntityId(entityId);
    if (!swarmRec) return null;
    const struct = this.structureRegistry.get(swarmRec.id);
    if (!struct) return null;
    const hp = this.swarmHealth.get(swarmRec.id);
    if (hp === undefined) return null;
    const kind = getStructureKind(struct.kind);
    return {
      type: 'entity_stats',
      id: sel.id,
      kind: 'structure',
      name: kind.displayName,
      hp: Math.max(0, Math.round(hp)),
      hpMax: Math.round(kind.maxHealth),
    };
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
    return this.livingWorldBotHooks.spawnBot(spec);
  }

  despawnLivingWorldBot(botId: string): BotCarry | null {
    return this.livingWorldBotHooks.despawnBot(botId);
  }

  markBotHostile(botId: string): void {
    this.livingWorldBotHooks.markBotHostile(botId);
  }

  private handleRespawn(client: Client): void {
    this.respawnHandler.handle(client);
  }

  /**
   * Plan: crispy-kazoo, Commit 2 — `client_ready` handler.
   *
   * Picks `arrivalTick = serverTick + ARRIVAL_OFFSET_TICKS`, stamps it
   * on the pending-join record, and broadcasts `warp_in { playerId,
   * x, y, arrivalTick }` to ALL occupants (no `except: client`).
   *
   * Idempotent: a second send when the player is already activated
   * or already has an arrivalTick is silently dropped + logged for
   * diag.
   */
  private handleClientReady(client: Client): void {
    const playerId = this.sessionToPlayer.get(client.sessionId);
    if (!playerId) {
      serverLogEvent('client_ready_no_session', { sessionId: client.sessionId });
      return;
    }
    const pending = this.pendingJoin.get(playerId);
    if (!pending) {
      // Already activated (handshake completed) or never registered.
      serverLogEvent('client_ready_no_pending', { playerId, sessionId: client.sessionId });
      return;
    }
    if (pending.arrivalTick !== null) {
      // Second client_ready before arrival fires — idempotent no-op.
      serverLogEvent('client_ready_duplicate', { playerId, arrivalTick: pending.arrivalTick });
      return;
    }
    const currentTick = Atomics.load(this.sabU32, TICK_IDX);
    const arrivalTick = currentTick + ARRIVAL_OFFSET_TICKS;
    pending.arrivalTick = arrivalTick;

    this.broadcast('warp_in', {
      type: 'warp_in',
      playerId,
      x: pending.spawnX,
      y: pending.spawnY,
      arrivalTick,
    });

    serverLogEvent('client_ready_received', {
      playerId,
      sessionId: client.sessionId,
      msSinceJoin: (currentTick - pending.joinTick) * (1000 / 60),
      arrivalTick,
    });
  }

  /**
   * Plan: crispy-kazoo, Commit 2 — per-tick pending-join drain.
   *
   * Called from `update()` after `this.serverTick` is refreshed.
   *
   *   - For entries whose `arrivalTick` has been reached: flip
   *     `ship.isActive = true` and remove from the map. The schema
   *     diff broadcasts the new state on the next snapshot tick.
   *   - For entries past `watchdogTick` whose client_ready never
   *     arrived: synthesise an arrival (pick `arrivalTick =
   *     currentTick + ARRIVAL_OFFSET_TICKS`, broadcast `warp_in`,
   *     leave in map for normal drain). Player appears even if
   *     their client is wedged — better than an invisible ghost.
   */
  private drainPendingJoin(): void {
    if (this.pendingJoin.size === 0) return;
    const currentTick = this.serverTick;
    for (const [playerId, rec] of this.pendingJoin) {
      // Activation branch: arrivalTick set and reached.
      if (rec.arrivalTick !== null && currentTick >= rec.arrivalTick) {
        const ship = this.getActiveShip(playerId);
        if (ship) {
          ship.isActive = true;
          serverLogEvent('ship_activated', {
            playerId,
            entityId: ship.shipInstanceId,
            arrivalTick: rec.arrivalTick,
            currentTick,
          });
        }
        this.pendingJoin.delete(playerId);
        continue;
      }
      // Watchdog branch: client_ready never arrived.
      if (rec.arrivalTick === null && currentTick >= rec.watchdogTick) {
        const arrivalTick = currentTick + ARRIVAL_OFFSET_TICKS;
        rec.arrivalTick = arrivalTick;
        this.broadcast('warp_in', {
          type: 'warp_in',
          playerId,
          x: rec.spawnX,
          y: rec.spawnY,
          arrivalTick,
        });
        serverLogEvent('client_ready_timeout', {
          playerId,
          sessionId: rec.sessionId,
          joinTick: rec.joinTick,
          watchdogTick: rec.watchdogTick,
          arrivalTick,
        });
      }
    }
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
    // Per-kind bounding circle = hull radius + SHIELD_RADIUS_PAD. Three
    // sites share this constant (physics ball collider, this hit-test,
    // visible ShieldAura ring) so the player's "where the shield is"
    // intuition matches every gate. Pre-2026-05-27 used a hardcoded
    // SHIP_COLLISION_RADIUS=12 that only matched fighter — heavy at
    // radius 16 had ~4 u of visible hull where lasers passed through.
    const r = getShipKind(ship.kind).radius + SHIELD_RADIUS_PAD;
    const circle = rayHitsSphere(fx, fy, dx, dy, maxDist, cx, cy, r);
    if (circle === null || ship.shield > 0) return circle;
    return rayHitsShipPolygon(fx, fy, dx, dy, maxDist, cx, cy, angle, shipCollisionParts(ship.kind));
  }

  /** Projectile sweep counterpart of playerHitscanDist — same per-kind
   *  bounding-circle (kind.radius + SHIELD_RADIUS_PAD), same shield-up /
   *  shield-down split. Projectiles now impact at the visible shield
   *  boundary on every ship kind, not just fighter. */
  private playerProjectileSweep(
    ship: ShipState,
    fromX: number, fromY: number, stepX: number, stepY: number, projRadius: number,
    cx: number, cy: number, angle: number,
  ): { entry: number; hitX: number; hitY: number } | null {
    const r = getShipKind(ship.kind).radius + SHIELD_RADIUS_PAD;
    const circle = projectileSweepCircle(fromX, fromY, stepX, stepY, projRadius, cx, cy, r);
    if (circle === null || ship.shield > 0) return circle;
    return sweptSegmentHitsShipPolygon(fromX, fromY, stepX, stepY, cx, cy, angle, shipCollisionParts(ship.kind));
  }

  private advanceProjectiles(): void {
    this.projectiles.advance();
  }

  // ── Worker lifecycle ────────────────────────────────────────────────────

  /**
   * Bundle + spawn the physics worker through the PhysicsWorkerProxy.
   * The proxy owns the Worker instance, the READY handshake, and the
   * SLEEP_TRANSITION / CONTACT_BATCH routing — this room provides
   * the handlers (bus emit, broadcast, ramming damage) via callbacks.
   */
  private async spawnWorker(): Promise<void> {
    this.physicsWorkerProxy = new PhysicsWorkerProxy({
      workerEntryPath: WORKER_TS_PATH,
      sab: this.sab,
      logger,
      stats: () => ({
        playerCount: this.playerToSlot.size,
        swarmCount: this.swarmRegistry.size(),
      }),
      onSleepTransition: (entityId, sleeping) => {
        // Re-emit on the local bus as a discrete event. Phase 5
        // subscribers (binary swarm broadcast in 5c, audio/UI in later
        // phases) consume these to freeze interpolation / play wake
        // SFX. Pino sampling rule for high-frequency events applies.
        if (sleeping) {
          this.bus.emit('ENTITY_SLEPT', { type: 'ENTITY_SLEPT', entityId });
        } else {
          this.bus.emit('ENTITY_WOKE', { type: 'ENTITY_WOKE', entityId });
        }
      },
      onContactBatch: (tick, contacts) => {
        // Stage 2 of the network-feel roadmap: each contact above the
        // worker's CONTACT_FORCE_FLOOR is broadcast to all clients in
        // the room as `collision_resolved`. AOI filter is deferred —
        // the typical 1–4 player room's per-tick contact volume is
        // low, and the client's `applyCollisionResolved` silently
        // no-ops on bodies its predWorld doesn't track. Bus emission
        // lets persistence/telemetry subscribe.
        //
        // Aggregate per unordered {aId,bId} pair FIRST. A hull-polygon
        // body is a compound of N triangle colliders, so one physical
        // ram emits up to N contact-force sub-events sharing aId/bId.
        // Summing before floor/damage/broadcast prevents N-multiplied
        // damage, sub-floor splitting, and one broadcast per triangle.
        // See src/core/combat/Ramming.ts.
        for (const p of aggregateRamming(contacts)) {
          // Phase 6b self-collision filter (aId === bId): the active +
          // lingering hulls of one player share the playerId identity.
          // See ./contactFilter.ts for the rationale + its unit test.
          if (p.aId === p.bId) {
            serverLogEvent('collision_self_filtered', {
              aId: p.aId,
              tick,
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
            tick,
          });
          this.broadcast('collision_resolved', {
            type: 'collision_resolved',
            aId: p.aId,
            bId: p.bId,
            vA: p.vA,
            vB: p.vB,
            impulse: p.force,
            tick,
          });
          serverLogEvent('collision_resolved', {
            aId: p.aId,
            bId: p.bId,
            impulse: parseFloat(p.force.toFixed(3)),
            tick,
          });
          // Ramming damage (Phase 4). Symmetric: each side takes the
          // damage; the OTHER id is the "shooter" (kill-feed +
          // hostility attribution). applyDamage already no-ops on
          // asteroids (immune - no swarmHealth entry) while still
          // damaging the ship they hit, so "asteroids deal but do not
          // take" falls out for free. Applied once per pair per tick.
          if (p.damage > 0 && !this.disableCollisionDamage) {
            serverLogEvent('ram_damage', {
              aId: p.aId,
              bId: p.bId,
              force: parseFloat(p.force.toFixed(1)),
              impactSpeed: parseFloat(p.impactSpeed.toFixed(1)),
              damage: parseFloat(p.damage.toFixed(2)),
              tick,
            });
            this.applyDamage(p.aId, p.bId, p.damage);
            this.applyDamage(p.bId, p.aId, p.damage);
          }
        }
      },
    });
    await this.physicsWorkerProxy.start();
  }

  private postToWorker(cmd: WorkerCmd): void {
    this.physicsWorkerProxy.postCommand(cmd);
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
        // Plan: crispy-kazoo, Commit 2 — invariant: every join goes
        // through the synchronised handshake (`pendingJoin` →
        // `client_ready` → `warp_in` → arrivalTick → isActive=true).
        // The rebind path used to flip `isActive = true` directly,
        // skipping the handshake — works for the player (the ship is
        // already alive) but BREAKS the client's bootstrap which sits
        // waiting for `warp_in` to flip `arrival_acked`. Repro: phone
        // smoke capture 2026-05-31T15-36-08Z-7eqj1a + the React
        // StrictMode dev-mount cycle.
        //
        // The fix is to register the rebind in `pendingJoin` exactly
        // as a fresh spawn does: isActive=false initially, watchdog
        // armed, waiting for the client's `client_ready` to broadcast
        // `warp_in`. `drainPendingJoin` flips `isActive=true` at the
        // arrivalTick. The hull stays at its current live pose (we
        // don't move it); only the visibility + handshake state are
        // re-driven through the unified path.
        existingShip.isActive = false;
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

        // Plan: crispy-kazoo invariant — register the rebind in
        // `pendingJoin` so `client_ready` → `warp_in` → arrivalTick →
        // isActive=true follows the same path as a fresh spawn. The
        // hull pose stays live (no SAB reset); only the visibility +
        // handshake state are re-driven through the unified path.
        this.pendingJoin.set(playerId, {
          joinTick: tickAtRebind,
          watchdogTick: tickAtRebind + CLIENT_READY_TIMEOUT_TICKS,
          arrivalTick: null,
          spawnX: liveX,
          spawnY: liveY,
          sessionId: client.sessionId,
        });
        serverLogEvent('pending_join_registered', {
          playerId,
          sessionId: client.sessionId,
          watchdogTick: tickAtRebind + CLIENT_READY_TIMEOUT_TICKS,
          source: 'rebind',
        });
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
    } else {
      // Fresh spawn: zero the velocity/angle fields. This SAB slot may hold
      // STALE values from a previous occupant of the slot; the physics worker
      // would otherwise read them and drift the just-spawned ship (~30 u over
      // the first 500 ms — the spawn-position E2E regression). Position is set
      // unconditionally above; velocity must be too.
      this.sabF32[base + SLOT_VX_OFF]     = 0;
      this.sabF32[base + SLOT_VY_OFF]     = 0;
      this.sabF32[base + SLOT_ANGLE_OFF]  = 0;
      this.sabF32[base + SLOT_ANGVEL_OFF] = 0;
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
    // Energy seeds full on spawn (transient like shield; weapons/energy/AI
    // overhaul §3). Fallback covers any kind that pre-dates the energy field.
    ship.energy = getShipKind(ship.kind).energyMax ?? 100;
    // Test-only initialHull / initialShield overrides. Gated to testMode
    // rooms (engineering, never galaxy) so live gameplay can't be nerfed
    // via the wire. Applied AFTER the kind-default hull/shield are
    // installed so the test spec gets the exact override it asked for.
    // E2E specs that just need "do they die when shot?" spawn with
    // initialHull=1, initialShield=0 → one beam tick kills.
    if ((this.testMode || ALLOW_DEV_OVERRIDES) && parsed.success) {
      if (typeof parsed.data.initialHull === 'number') {
        ship.health = Math.max(1, parsed.data.initialHull);
      }
      if (typeof parsed.data.initialShield === 'number') {
        ship.shield = Math.max(0, parsed.data.initialShield);
      }
      // initialEnergy override — lets energy specs start near-empty so the
      // gate/regen flow is testable in a few ticks instead of seconds.
      if (typeof parsed.data.initialEnergy === 'number') {
        ship.energy = Math.max(0, parsed.data.initialEnergy);
      }
      // initialAngle is applied below — the angle lives in
      // `shipPoseCache` + the Rapier body (via SET_POSITION post-SPAWN),
      // not on the ShipState schema (per the spatial-fields-off-schema
      // invariant at the top of `SectorState.ts`).
      // lingerMs override — captured per-player so the NEXT onLeave uses a
      // short linger TTL (lets the despawn→return-to-pool E2E observe the
      // evict without waiting out the 15-min production window).
      if (typeof parsed.data.lingerMs === 'number') {
        this.playerToLingerMs.set(playerId, parsed.data.lingerMs);
      }
    }
    ship.shieldLastDamageTick = this.serverTick;

    // plan: imperative-taco — pre-mark every drone hostile to this player
    // so a CDP allocation profile (combat-allocation-profile-hostile.spec.ts)
    // measures steady-state combat instead of the IDLE→COMBAT transition.
    // Mirrors the `markBotHostile` pattern in LivingWorldBotHooks: per-player
    // `aiController.markHostile` + `bot_aggro` broadcast so the client's
    // hostility ledger stays in lockstep. testMode-gated for safety.
    if ((this.testMode || ALLOW_DEV_OVERRIDES) && parsed.success && parsed.data.startHostile === true) {
      const tick = this.serverTick;
      for (const rec of this.swarmRegistry.all()) {
        if (rec.kind !== 1) continue; // drones only — asteroids stay inert
        this.aiController.markHostile(rec.id, playerId, tick);
        this.broadcast('bot_aggro', {
          type: 'bot_aggro',
          botEntityId: `swarm-${rec.entityId}`,
          targetPlayerId: playerId,
          tick,
        });
      }
    }

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

    // Test-only initialAngle: SPAWN creates the body at angle 0; force
    // the requested heading immediately via SET_POSITION so the spec
    // doesn't have to drive 2 s of keyboard rotation. Pose cache + ship
    // schema were already populated above; this just brings the Rapier
    // body in line with them.
    if (this.testMode && parsed.success && typeof parsed.data.initialAngle === 'number') {
      const a = parsed.data.initialAngle;
      this.postToWorker({
        type: 'SET_POSITION',
        entityId: playerId,
        x: spawnX, y: spawnY, angle: a,
        vx: 0, vy: 0, angvel: 0,
      });
      const poseEntry = this.shipPoseCache.get(playerId);
      if (poseEntry) poseEntry.angle = a;
    }

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

    // Plan: crispy-kazoo, Commit 2 — synchronised warp-in handshake.
    // Ship enters the sector INVISIBLY (isActive=false). Drones won't
    // target it (aiTickRunner / LivingWorldBotHooks both filter on
    // `ship.isActive`); the snapshot translator on remote clients
    // skips isActive=false entries; the client snapshot apply on the
    // joining player ignores their own ship (predWorld is authoritative
    // for the local pose anyway). The ship becomes visible to all
    // observers — including the joiner — at the synchronised
    // `arrivalTick` once the client has called `client_ready`.
    //
    // Note: the LOCAL CLIENT's `mirror.ships[playerId]` is populated
    // from the bootstrap path (welcome → predWorld), so the joiner
    // still has a ship to predict / render — but the loading curtain
    // (Commit 1's `useIsLoadingActive`) hides it until the curtain
    // drops at `arrivalTick`.
    ship.isActive = false;
    this.pendingJoin.set(playerId, {
      joinTick: currentServerTick,
      watchdogTick: currentServerTick + CLIENT_READY_TIMEOUT_TICKS,
      arrivalTick: null,
      spawnX,
      spawnY,
      sessionId: client.sessionId,
    });
    serverLogEvent('pending_join_registered', {
      playerId,
      sessionId: client.sessionId,
      watchdogTick: currentServerTick + CLIENT_READY_TIMEOUT_TICKS,
    });

    // NOTE: the previous immediate `warp_in` broadcast (to other
    // occupants, with `except: client`) is REMOVED. The unified
    // handshake broadcasts `warp_in` from the `client_ready` handler
    // (or the watchdog) to ALL clients with an `arrivalTick`, so the
    // flash fires in sync everywhere.
  }

  override onLeave(client: Client, consented: boolean): void {
    // Plan: crispy-kazoo, Commit 2 — drop any in-flight handshake
    // entry. A disconnected client can't complete the handshake;
    // its ship stays `isActive=false` for the standard leave flow
    // (linger / despawn) to handle, but we don't want a watchdog
    // to fire warp_in on a ghost session.
    const leavingPlayerId = this.sessionToPlayer.get(client.sessionId);
    if (leavingPlayerId) this.pendingJoin.delete(leavingPlayerId);

    // Click-to-inspect (Item B5) — drop this connection's selection so the
    // ~5 Hz stats emitter doesn't keep resolving for a gone session (covers
    // disconnect AND inter-sector transit, both of which fire onLeave).
    this.selectionStats?.clearSession(client.sessionId);

    // Phase 1 swift-otter — tear down the WebRTC peer connection BEFORE
    // running the existing leave handler. The leaveHandler does the
    // player-state cleanup (lingering / transit / despawn); the DC
    // teardown is independent and must happen even on lingering paths
    // (no point holding a PeerConnection alive against a disconnected
    // session). Idempotent: cleanup() is a no-op when no entry exists.
    this.webrtcChannelManager?.cleanup(client.sessionId);
    this.leaveHandler.handle(client, consented);
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
    this.ownerlessShipEvictor.evict(shipInstanceId);
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
    preferredShipId: string = '',
    forceFreshCreate: boolean = false,
  ): string {
    return this.rosterPersistence.bind(playerId, userId, kind, pose, preferredShipId, forceFreshCreate);
  }

  private markRosterLinger(
    shipInstanceId: string,
    pose: {
      x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
      health: number; lastFireClientTick: number;
    },
  ): void {
    this.rosterPersistence.markLinger(shipInstanceId, pose);
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
    this.wreckCoordinator.convertShipToWreck(playerId);
  }

  private destroyWreck(shipInstanceId: string): void {
    this.wreckCoordinator.destroyWreck(shipInstanceId);
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
    this.rosterPersistence.markStored(shipInstanceId, pose);
  }

  private deleteRosterRow(shipInstanceId: string): void {
    this.rosterPersistence.delete(shipInstanceId);
  }

  override onDispose(): void {
    this.simLoopStopped = true;
    // Structures plan, Phase 3 — stop the grid pulse heartbeat.
    if (this.structureGridTimer !== undefined) {
      clearInterval(this.structureGridTimer);
      this.structureGridTimer = undefined;
    }
    // Phase 5 — stop the turret tick.
    if (this.structureTurretTimer !== undefined) {
      clearInterval(this.structureTurretTimer);
      this.structureTurretTimer = undefined;
    }
    // Item B5 — stop the click-to-inspect stats emitter.
    if (this.selectionStatsTimer !== undefined) {
      clearInterval(this.selectionStatsTimer);
      this.selectionStatsTimer = undefined;
    }
    // Paradigm plan (quirky-rabbit) Phase 6 — unsubscribe from the GC
    // observer so the disposed room isn't kept alive by the subscriber
    // closure (and so the observer doesn't try to broadcast through a
    // torn-down WebSocket transport).
    if (this.gcPauseSubscriber) {
      unsubscribeGcPause(this.gcPauseSubscriber);
      this.gcPauseSubscriber = null;
    }
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
    // Phase 1 swift-otter — close every PeerConnection so the libdatachannel
    // worker threads exit cleanly before the process / room teardown.
    this.webrtcChannelManager?.cleanupAll();
    this.webrtcChannelManager = null;
    this.physicsWorkerProxy?.terminate();
    logger.info({ sectorKey: this.sectorKey }, 'SectorRoom disposed');
  }

  // ── Phase 4 iteration 3 swift-otter — WebRTC diagnostic surface ─────────

  /**
   * Invoked via `matchMaker.remoteRoomCall(roomId, 'getWebRtcCounters')`
   * from the `/dev/webrtc-counters` dev endpoint. Returns a JSON-safe
   * snapshot of per-session counters so the Phase 4 E2E can compare
   * server-side `sentViaDc` against client-side `snapshot_received`
   * via='dc' counts to localise where DC throughput variance lives.
   * Null when the room has no manager (defensive — every room currently
   * constructs one).
   */
  getWebRtcCounters(): {
    roomId: string;
    sectorKey: string | null;
    sessions: WebRtcEntryCounters[];
  } | null {
    if (!this.webrtcChannelManager) return null;
    return {
      roomId: this.roomId,
      sectorKey: this.sectorKey,
      sessions: this.webrtcChannelManager.getCounters(),
    };
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
    this.sectorPersistence.persist();
  }

  private hydrateFromSnapshot(): void {
    this.sectorPersistence.hydrate();
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

    this.tickBudget.beginTick(tStart);
    const phaseTime = (key: string): void => this.tickBudget.phaseTime(key);

    // Seqlock SAB → pose-cache mirror — see SabPoseMirror.ts. Swarm
    // poses are read directly from SAB by the binary encoder later in
    // this tick (see swarmEncoder.encode).
    mirrorSabPoses({
      sabF32: this.sabF32,
      sabU32: this.sabU32,
      playerToSlot: this.playerToSlot,
      lingeringSlots: this.lingeringSlots,
      wreckToSlot: this.wreckToSlot,
      shipPoseCache: this.shipPoseCache,
      lingeringPoseCache: this.lingeringPoseCache,
      wreckPoseCache: this.wreckPoseCache,
      sabAppliedTicks: this.sabAppliedTicks,
    });

    this.serverTick = Atomics.load(this.sabU32, TICK_IDX);
    this.state.tick = this.serverTick;

    // Plan: crispy-kazoo, Commit 2 — drain handshake activations.
    // Flip pending-join ships' `isActive=true` at arrivalTick, and
    // fire the watchdog for any ship whose client_ready hasn't
    // arrived in CLIENT_READY_TIMEOUT_TICKS. Cheap when the map
    // is empty (most ticks); short-circuits at the top of the
    // method.
    this.drainPendingJoin();

    // Phase 4 abandon detection — galaxy-rooms only, every 30 ticks
    // (~500ms). See sectorIdleEvaluator.ts.
    if (this.sectorKey !== null && this.serverTick % 30 === 0 && this.state.ships.size > 0) {
      const abandoned = findAbandonedShips(this.state.ships, getPlayerShipStore());
      for (const a of abandoned) {
        if (a.lingering) this.wreckCoordinator.convertLingeringHullToWreck(a.shipInstanceId);
        else this.convertShipToWreck(a.playerId);
      }
    }

    // Phase 5d spatial-grid update + Phase 1 AI runaway-bounds clamp.
    // See swarmInterestUpdater.ts.
    updateSwarmInterestGrid({
      swarmRegistry: this.swarmRegistry,
      interestGrid: this.interestGrid,
      sabF32: this.sabF32,
      postToWorker: (cmd) => this.postToWorker(cmd),
      droneMaxBounds: DRONE_MAX_BOUNDS,
    });
    phaseTime('sabRead');

    // Per-tick lag-comp recording — see lagCompRecorder.ts.
    recordLagCompPoses({
      snapshotRing: this.snapshotRing,
      serverTick: this.serverTick,
      playerToSlot: this.playerToSlot,
      shipPoseCache: this.shipPoseCache,
      swarmRegistry: this.swarmRegistry,
      sabF32: this.sabF32,
      getActiveShip: (id) => this.getActiveShip(id),
    });

    // Advance physical projectiles and check for collisions.
    this.advanceProjectiles();
    // Advance missiles (lock-verify, guidance, sweep, detonate-splash).
    // Detonations enqueue physics impulses which are drained below and
    // posted to the worker as MISSILE_IMPULSE commands.
    this.missileSim.advance();
    const impulses = this.missileSim.drainImpulses();
    for (const imp of impulses) {
      this.postToWorker({
        type: 'MISSILE_IMPULSE',
        entityId: imp.targetId,
        fx: imp.fx,
        fy: imp.fy,
      });
    }
    this.tickShieldRegen();
    this.tickEnergy();
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
    // GEP B4 — both per-tick entity-sync sends route through the EntitySyncRouter:
    // pose-core binary FIRST (builds the per-(client,tick) interestScratch), then
    // the json-slice snapshot slices (reuse it — no second query9; HC#4). The
    // router evaluates sector-idle BETWEEN the two sends (swarm.broadcast may apply
    // backpressure before idle reads clients.length — order preserved verbatim) and
    // fires the phaseTime markers at the same boundaries. The single-20 Hz cadence,
    // phase staggering, and idle-suppression rationale live in SnapshotBroadcaster
    // + server CLAUDE.md (Phase 3 snapshot-broadcast-rate) + docs/LESSONS.md.
    this.entitySync.route(phaseTime);

    // Phase 1 swift-otter — once per second, expire any WebRTC sessions
    // whose ICE deadline has elapsed without `onConnected`. Gated to
    // 1 Hz because the call iterates a (small) Map and the deadline is
    // 5 s anyway. broadcastCounter is the 60 Hz main-thread monotonic.
    if (this.webrtcChannelManager !== null && this.broadcastCounter % 60 === 0) {
      this.webrtcChannelManager.expireStale();
    }

    // Tick AI AT THE END of update() so posted impulses reach the
    // worker BEFORE the next SAB read. See aiTickRunner.ts.
    runAiTick({
      aiController: this.aiController,
      serverTick: this.serverTick,
      playerToSlot: this.playerToSlot,
      getActiveShip: (id) => this.getActiveShip(id),
      shipPoseCache: this.shipPoseCache,
      aiPlayerScratch: this.aiPlayerScratch,
      aiStructureScratch: this.aiStructureScratch,
      fillStructureTargets: (out) => this.fillStructureTargets(out),
      swarmEntitySnapshot: (id) => this.swarmEntitySnapshot(id),
      handleAiFire: (shooterId, dirX, dirY, tick) => this.handleAiFire(shooterId, dirX, dirY, tick),
      phaseTime,
    });

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
    const workerTickMs = (this.sabU32[WORKER_TICK_US_IDX] ?? 0) / 1000;
    const totalMs = this.tickBudget.endTick({
      serverTick: this.serverTick,
      workerTickMs,
      playerCount: this.playerToSlot.size,
      swarmCount: this.swarmRegistry.size(),
      aiSize: this.aiController.size(),
      liveProjectileCount: this.liveProjectiles.size,
    });

    // Phase 6 — drive the TiDi clock from whichever side is the bottleneck.
    // The server's `update()` time covers SAB-read / encode / broadcast; the
    // worker's most-recent step duration covers physics. The real budget
    // overrun is whichever is longer.
    const busiestMs = Math.max(totalMs, workerTickMs);
    this.simClock.report(busiestMs);
    const newRate = this.simClock.rate;
    // testTimeScale lets testMode rooms run physics N× faster (default 1).
    // state.clockRate stays at the UNMULTIPLIED simClock value so client
    // audio pitch + TiDi UI don't show a fake anomaly under acceleration.
    const outboundRate = newRate * this.testTimeScale;
    if (Math.abs(outboundRate - this.lastSentClockRate) >= 1e-4) {
      this.lastSentClockRate = outboundRate;
      this.state.clockRate = newRate;
      this.postToWorker({ type: 'CLOCK_RATE', rate: outboundRate });
    }
    // Phase 6 second-lever: if rate is at floor and we're still over budget,
    // shed far drones in batches. No-op when rate > 0.71 or budget healthy.
    this.shedder.consider(newRate, busiestMs);
  }
}
