import { Client, Room } from 'colyseus.js';
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';
import type { IAudio } from '@core/contracts/IAudio';
import { REAL_CLOCK, type Clock } from '@core/clock/Clock';
import { SPOOL_DURATION_MS } from '@core/transit/TransitStateMachine';
import type { WelcomeMessage, SnapshotMessage, DamageEvent, DestroyEvent, LaserFiredEvent, RespawnAckMessage, TransitStateMessage, WarpInEvent, WarpOutEvent, ShieldEventMessage, BotAggroEvent, GcPauseEventMessage, GridPulseEvent } from '@shared-types/messages';
import { TRANSFER_PULSE_MS as GRID_PULSE_WINDOW_MS } from '@core/structures/structureGridConstants';
import { PhysicsWorld, type ShipPhysicsState } from '@core/physics/World';
import { SHIELD_WALL_THICKNESS } from '@core/structures/ShieldWall';
import { Reconciler, type InputRecord } from '@core/prediction/Reconciler';
import { springStep, type SpringState } from '@core/math/CritDampedSpring';
import {
  applyCollisionResolved,
  createCollisionGuard,
  type CollisionGuardState,
} from './applyCollisionResolved';
import { CollisionResolvedMessageSchema, HitAckSchema, DamageEventSchema, MissileFiredEventSchema, MissileDetonatedEventSchema, EntityStatsSchema, WarpWarningSchema, WarpWarningClearSchema } from '@shared-types/messages';
import { applySelectionStats } from './selectionStats.js';
import {
  createRemotePredictionGuard,
  shouldForwardPredict,
  type RemotePredictionGuard,
} from './remotePredictionGuard';
import {
  createWelford,
  type WelfordState,
} from '@core/math/Welford';
import {
  createLookaheadController,
  type LookaheadController,
} from './lookaheadController';
import {
  createDropDetector,
  type DropDetector,
} from './snapshotDropDetector';
import { recoverInputTickFromStarvation } from './inputTickRecovery';
import { LingeringPredBodyManager } from './LingeringPredBodyManager.js';
import { SnapshotCoalescer } from './SnapshotCoalescer.js';
import { ClientEntityFactory } from './entity/ClientEntityFactory.js';
import type { ClientSpawnCtx } from './entity/IClientEntityLeaf.js';
import { DataChannelTransport } from './dataChannelTransport.js';
import { webrtcEnabledFromSearch } from './webrtcEnable.js';
import { HudDispatcher } from './HudDispatcher.js';
import { syncProjectiles, syncWreckPoses } from './SnapshotSyncHelpers.js';
import { applyMissileSnapshot, removeMissile } from '../combat/MissileMirror.js';
import { RafStallDetector } from './RafStallDetector.js';
import {
  routeSnapshotShipStates,
  applyBoostingThrustingSets,
  type ShipRouterCtx,
} from './snapshotShipRouter.js';
import { applySnapshotPerfStats } from './snapshotPerfStats.js';
import { syncTidiFromRoom } from './tidiSync.js';
import { updateRttAndLookahead } from './rttLookaheadUpdater.js';
import { preResetRemoteShips, applyDroneMountAngles, applyAsteroidResources, type PreResetRemoteCtx } from './snapshotRemoteSync.js';
import { computeRemoteLerpOffsets } from './remoteLerpOffsets.js';
import { useUIStore, type ConnectionStatus } from '../state/store';
import { logEvent, isDiagEnabled, isFullDiagMode, isRammingProbeEnabled, isGhostProbeEnabled } from '../debug/ClientLogger';
import { readHeapUsedMb } from './perfStats';
import { TransitInstrumentation } from '../debug/TransitInstrumentation';
import { installLongtaskObserver } from '../debug/longtaskObserver';
import { installPageLifecycleObserver } from '../debug/pageLifecycleObserver';
import { recordServerGcPause, startHealthStatsPublisher } from '../debug/healthStats';
import { GhostManager } from '../combat/GhostProjectile';
import { HITSCAN_RANGE, rayHitsSphere } from '@core/combat/Weapons';
import { getWeapon, weaponAutoFireRange, type WeaponDef } from '@core/combat/WeaponCatalogue';
import { canAfford, spendEnergy, regenEnergyStep, resolveSlotEnergyCost, BOOST_TICK_COST } from '@core/combat/Energy';
import { resolveSlotMounts } from '@shared-types/shipKinds/slots';
import { HitPredictionLedger } from '@core/combat/HitPrediction';
import {
  predictShotOutcome,
  reconcileAckToFeedback,
  reconcileDamageToFeedback,
  type PredictedFeedbackSink,
  type ReconcileFeedbackSink,
  type MountFireGeom,
} from '../combat/HitPrediction.client';
import { localFireSpawnsGhost, liveBeamVisible, LIVE_BEAM_PERSIST_MS, buildLocalAimTargets, type LocalAimTarget } from '../combat/LocalBeam';
import { tickLocalMountAngles } from '../combat/localMountAim';
import type { TouchInput } from '../input/TouchInput';
import { joystickToInput, IDLE_INPUT_STATE, type JoystickInputState } from '../input/joystickToInput';
import { decodeSwarmPacket } from './BinarySwarmDecoder';
import {
  interpolateSwarmPose,
  type InterpolatedPose,
} from './swarmInterpolation';
import { updateAnchor } from './clockAnchor';
import { getSector } from '@core/galaxy/galaxy';
import { AiController, type AiIntentSink } from '@core/ai/AiController';
import { getShipKind, SHIELD_RADIUS_PAD, type WeaponMount } from '@shared-types/shipKinds';
import {
  resolvePlacementPreviewStatus,
  type PlacementPreview,
  type PendingPlacement,
  type ShipPose,
} from '../structures/structurePlacementClient.js';
import type { StructureKindId } from '../../shared-types/structureKinds.js';
import { pickTarget, PLAYER_AIM_HEALTH_WEIGHT, PLAYER_AIM_SWITCH_MARGIN } from '@core/ai/WeaponMountController';

export interface ColyseusClientCallbacks {
  onConnectionStatus: (s: ConnectionStatus) => void;
  onPlayerId: (id: string) => void;
  /** Effects subsystem (plan `wiggly-puppy` M9). Called from
   *  `resetPredictionState()` on sector handoff alongside
   *  `rearmJoinReadiness()`. App.tsx wires this to
   *  `renderer.resetEffectsForSectorHandoff()` which delegates to
   *  `EffectsService.resetForSectorHandoff()`. Optional — callers that
   *  don't render (LocalGameClient, headless tests) can omit. */
  onSectorHandoff?: () => void;
}

/** Timestamped remote-ship state snapshot for 100 ms display-delay interpolation. */
interface RemoteEntry {
  ts: number;
  state: ShipPhysicsState;
}

const HISTORY_MAX = 30;

// Public PredictionStats interface moved to ./predictionStats.ts.
// Re-exported here so existing test imports (e.g.
// tests/e2e/input-throttle-drift.spec.ts) keep resolving via
// `import type { PredictionStats } from 'src/client/net/ColyseusClient'`.
export type { PredictionStats } from './predictionStats.js';
import type { PredictionStats } from './predictionStats.js';

/** Phase 5e DEV-only inbound bandwidth tally surfaced on `window.__EQX_BW_STATS`. */
interface BwStats {
  startedAt: number;
  swarmBytes: number;
  swarmPackets: number;
  snapshotBytes: number;
  snapshotCount: number;
  reset(): void;
}

function bwStats(): BwStats | null {
  if (!import.meta.env.DEV) return null;
  return (window as unknown as { __EQX_BW_STATS?: BwStats }).__EQX_BW_STATS ?? null;
}

// Prediction tuning constants + remoteOffsetHalfLifeForDrift moved to
// ./predictionTuning.ts — pure read-only tuning values, no `this`-state.
import {
  NOISE_THRESHOLD,
  ANGLE_NOISE_THRESHOLD,
  REMOTE_SPRING_POS_END,
  REMOTE_SPRING_VEL_END_MS,
  STAGE_3_MAX_LOOKAHEAD_TICKS,
} from './predictionTuning.js';

/** Simple monotonically incrementing shot ID generator. */
let _shotCounter = 0;
function nextShotId(): string {
  return `shot-${_shotCounter++}`;
}

// 2026-05-20 spiral fix: joystick→input thresholds (with hysteresis)
// moved into the pure `joystickToInput` helper. The single-band constants
// (TOUCH_DEADZONE, TOUCH_THRUST_MAG, TOUCH_THRUST_CONE,
// TOUCH_TURN_TOLERANCE) caused analog-noise toggles at ~10 Hz under
// steady stick use → sustained prediction-correction spiral on mobile.
// See `src/client/input/joystickToInput.ts` + its unit lock.
/** Idle-input heartbeat (network-discipline P4). When the control state has
 *  not changed for this long, we re-send the latest state once anyway, so the
 *  server can detect a missing client (idle != disconnected) and so a UDP
 *  restart-style replacement of the last-applied input still happens. 250 ms
 *  is well below `lastSentInput` perception lag for a held-key change but
 *  well above the per-tick 16.67 ms cadence — net result is a 60 → ~4 Hz
 *  drop on idle. */
const INPUT_HEARTBEAT_MS = 250;

// Pure rounding helpers used in the per-snapshot replay-grade capture
// block. Pre-fix these were declared as `const px = (n) => ...` closures
// inside `handleSnapshot`, allocating a function pair per snapshot
// (20 Hz). Both capture nothing — safe to hoist to module scope.
function _px3(n: number): number { return parseFloat(n.toFixed(3)); }
function _pa5(n: number): number { return parseFloat(n.toFixed(5)); }

// Part C — local player turret aim (tickLocalMountAim). Hoisted module consts
// so the per-tick pickTarget call allocates neither an options literal nor a
// closure (invariant #14). LocalAimTargets carry their own `hostile` flag, so
// this callback is never invoked (pickTarget reads `t.hostile`); it exists only
// to satisfy the signature. Options mirror the server's WeaponMountTicker.
const LOCAL_AIM_NOOP_HOSTILE = (): boolean => true;
const LOCAL_AIM_OPTS = {
  maxDistance: HITSCAN_RANGE,
  healthWeight: PLAYER_AIM_HEALTH_WEIGHT,
  switchMargin: PLAYER_AIM_SWITCH_MARGIN,
} as const;

export class ColyseusGameClient {
  /**
   * Plan: crispy-kazoo, Commit 6 — live-instance counter. Bumped in
   * the constructor, decremented in dispose. The respawn-memory
   * stability spec asserts this stays at 1 across N death/respawn
   * cycles — a regression to dispose ordering / leak would surface
   * as N > 1 after cycle N.
   */
  private static _liveInstanceN = 0;

  /** Plan: crispy-kazoo, Commit 6 — test surface for the
   *  respawn-memory stability assertion. Production code never reads it. */
  static getLiveInstanceCount(): number {
    return ColyseusGameClient._liveInstanceN;
  }

  /** A/B test switch: `?nohitscan=1` skips the per-mount-per-frame
   *  Rapier ray cast in updateLiveBeam. Read once at module load. */
  private static readonly SKIP_HITSCAN_VISUAL_FLAG = (() => {
    try {
      if (typeof window === 'undefined' || !window.location?.search) return false;
      return new URLSearchParams(window.location.search).get('nohitscan') === '1';
    } catch {
      return false;
    }
  })();

  /**
   * Wall-clock source. Production code uses `REAL_CLOCK` (default —
   * `this.clock.now()`). Tests / the replay harness inject a `MockClock`
   * to step time deterministically. Plan: capture-driven replay infra,
   * Phase B (2026-05-21). Every internal `this.clock.now()` call has
   * been replaced with `this.clock.now()` for replay parity.
   */
  private readonly clock: Clock;

  /**
   * Default constructor uses real wall-clock — production behaviour is
   * byte-identical. The replay harness in `tests/replay/` passes a
   * `MockClock` to drive captured timestamps.
   */
  constructor(clock: Clock = REAL_CLOCK) {
    this.clock = clock;
    ColyseusGameClient._liveInstanceN += 1;
    logEvent('client_constructed', { liveInstanceN: ColyseusGameClient._liveInstanceN });
    // Probe 6 — `?coalesce=0` disables snapshot coalescing for A/B
    // testing. Default ON. Tests construct with the mock URL absent →
    // coalesce defaults ON, matching production behaviour.
    let coalesceParam: string | null = null;
    try {
      if (typeof window !== 'undefined' && window.location?.search) {
        coalesceParam = new URLSearchParams(window.location.search).get('coalesce');
      }
    } catch {
      // Non-browser context — keep default.
    }
    this.snapshotCoalescer = new SnapshotCoalescer(coalesceParam !== '0');
    // swift-otter — WebRTC DataChannel snapshot transport. Default flipped
    // ON for real users (2026-06-06): on-device the DC carries ~99% of
    // snapshots over UDP, avoiding the WS/TCP head-of-line amplification that
    // stretches a brief WiFi-radio stall into a ~530 ms snapshot gap (the
    // on-device "jumps"). Reliable WS is retained as automatic fallback when
    // the DC can't establish (NAT/cellular), so default-on is safe. Default
    // OFF under Playwright automation (navigator.webdriver) so the E2E suite
    // stays WS-deterministic AND the netgate keeps measuring the proxied WS
    // path (the DC is P2P UDP and bypasses the injected-latency proxy).
    // `?webrtc=0`/`=1` override. Pure decision lives in `webrtcEnable.ts`.
    let webrtcEnabled = false;
    try {
      if (typeof window !== 'undefined' && window.location) {
        const isAutomation =
          typeof navigator !== 'undefined' && navigator.webdriver === true;
        webrtcEnabled = webrtcEnabledFromSearch(window.location.search, isAutomation);
      }
    } catch {
      // Non-browser context — keep default OFF (no RTCPeerConnection).
    }
    this._webrtcEnabled = webrtcEnabled;
  }

  /** Phase 6 — IAudio sink for TiDi pitch-shift. Optional: tests / headless
   *  contexts can omit it and rate-shift becomes a no-op. */
  private audio: IAudio | null = null;

  readonly mirror: RenderMirror = {
    ships: new Map(),
    swarm: new Map(),
    projectiles: new Map(),
    localPlayerId: null,
    damagedShips: new Set(),
    explodingShips: new Set(),
    liveBeams: new Map(),
    remoteLasers: new Map(),
    boostingShips: new Set(),
    thrustingShips: new Set(),
    pendingDamageNumbers: [],
    pendingDamageNumberCancels: [],
    pendingHealthBarHits: [],
    pendingWarpEvents: [],
    pendingMissileExplosions: [],
    pendingEffectTriggers: [],
  };

  /**
   * F-transit-instrument — gated single-clock timeline for the
   * inter-sector transit (warp-out → arrival → settle) path. The
   * room-swap handlers below drive the lifecycle marks; `App.tsx`
   * drives `engage` / `curtain_down` / the post-reveal frame burst via
   * `getGameClient().transitInstr`. Lives on the client (not the React
   * component) because it must survive the room hot-swap and share one
   * `this.clock.now()` clock across the whole flow. Fully no-op unless
   * `?diag=1` / WebDriver. See `debug/TransitInstrumentation.ts`.
   */
  readonly transitInstr = new TransitInstrumentation();

  /** Keys (`swarm-${entityId}`) of swarm bodies currently spawned in the prediction world. */
  private predSwarmKeys = new Set<string>();

  /**
   * No-op AI intent sink. `AiController`'s constructor requires a sink, but
   * post the drone-snapshot-interpolation pivot (2026-05-18) the client
   * NEVER ticks the drone brain — `_aiController` is a hostility ledger
   * only (see `_aiRegisteredIds`). Drones are pure snapshot-interpolated
   * from the binary swarm wire; no client AI ⇒ no divergent inputs ⇒
   * nothing to snap. The historical client-side re-sim (the
   * 2026-05-09 → 2026-05-17 Phase C / Option A architecture) was retired
   * here; see `docs/architecture/drone-snapshot-interpolation.md`.
   */
  private readonly _aiSink: AiIntentSink = { postIntent: () => {} };
  private readonly _aiController = new AiController(this._aiSink);
  /** Numeric entityIds currently registered with `_aiController`. Post the
   *  drone-snapshot-interpolation pivot (2026-05-18) `_aiController` is a
   *  HOSTILITY LEDGER ONLY — its brain is never ticked client-side. The
   *  set still tracks register/unregister so `isEntityHostileToPlayer`
   *  (HaloRadar threat colour, fed by `damage`/`bot_aggro` → `markHostile`)
   *  resolves, and so the registrations are torn down on sector handoff. */
  private readonly _aiRegisteredIds = new Set<number>();
  /** Scratch for the per-frame kinematic drone follower — `updateMirror`
   *  interpolates each in-interest drone's pose off its decoder-fed
   *  `poseRing` (display-delay + teleport guard) and drives the predWorld
   *  drone body to it so player↔drone collision stays render-consistent.
   *  Server stays hit-authoritative; this is presentation/collision only. */
  private readonly _swarmInterpScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  /** Scratch the `tickLocalMountAim` aim builder writes the resolved
   *  drone pose into. `buildLocalAimTargets` no longer interpolates — it
   *  READS the single per-frame pose `updateMirror` wrote (via
   *  `resolveEntityDisplayPose`) into this scratch. Kept distinct from
   *  `_swarmInterpScratch` so the two never alias across frame phases. */
  private readonly _aimInterpScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  /** Generic Entity Pipeline B4 — the client-side entity construction factory
   *  (the spawn-time kind→leaf routing seam, OOP peer of the server leaves). It
   *  replaces the old `swarmKindProfile` data table. `ColyseusClient` REMAINS
   *  the owner of `predSwarmKeys` / `_swarmBodyKeyCache` / `_aiRegisteredIds`;
   *  the leaves only read the reused `_clientSpawnCtx` + call predWorld /
   *  aiController (so `updateMirror`'s per-frame follower stays untouched). */
  private readonly _entityFactory = new ClientEntityFactory();
  /** Reused construction context — one instance mutated in place per entity, so
   *  swarm spawn allocates nothing (invariant #14). `predWorld` / `entry` are
   *  filled per use; `aiController` is the (constant) hostility ledger. */
  private readonly _clientSpawnCtx: ClientSpawnCtx = {
    predWorld: null as unknown as ClientSpawnCtx['predWorld'],
    aiController: this._aiController,
    entityId: 0,
    key: '',
    entry: null as unknown as ClientSpawnCtx['entry'],
    registeredAiId: null,
  };

  /** IDs of remote ships currently spawned in the prediction world. */
  private predRemoteShipIds = new Set<string>();
  /** Phase 4 — wrecks currently spawned in predWorld for client-side
   *  collision. Stored with the `wreck-` prefix so they can't collide
   *  with the playerId namespace. Despawned when removed from the
   *  schema's `state.wrecks` map. */
  private predWreckIds = new Set<string>();
  /** Phase 6b lingering-hull predWorld bridge. Owns:
   *   - `predLingeringIds` Set (which `linger-${...}` bodies are spawned)
   *   - `_lingeringShipOffsets` Map (per-frame visual lerp toward
   *     authoritative pose; avoids the visible teleport when a
   *     free-running pred body gets reconciled).
   *   - `ensure` (formerly `tryEnsureLingerPredBody`) — called from
   *     handleSnapshot AND syncMirror; no-op when the mirror entry
   *     isn't fully populated.
   *  Extracted to `colyseus/LingeringPredBodyManager.ts`. */
  private readonly lingerBodies = new LingeringPredBodyManager();

  private tryEnsureLingerPredBody(shipInstanceId: string): void {
    if (!this.predWorld) return;
    this.lingerBodies.ensure(shipInstanceId, this.predWorld, this.mirror);
  }
  /** Per-remote-ship render lerp offsets — applied in updateMirror() to smooth server corrections.
   *  Stage 1: each entry holds two critically-damped spring states (one per axis)
   *  decaying toward zero. Half-life per drift magnitude matches Reconciler. */
  private readonly _remoteShipOffsets = new Map<
    string,
    { sx: SpringState; sy: SpringState; halfLifeMs: number }
  >();

  /** Stage 2 collision-event guard — sliding rate-limit window per ship,
   *  plus latest snapshot tick for the stale-event drop check. Updated by
   *  the collision_resolved handler and by handleSnapshot. */
  private readonly _collisionGuard: CollisionGuardState = createCollisionGuard();

  /** Stage 3 — per-remote `lastInput` from the latest snapshot. Used by
   *  applyRemoteInputs() during the replay and tickPhysics input loops to
   *  forward-predict remote ships using the same input intent the server
   *  is applying. */
  private readonly _remoteLastInputs = new Map<
    string,
    { thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean }
  >();
  /** Stage 3 — per-remote count of forward-prediction ticks applied since
   *  the last snapshot. Reset on snapshot arrival; gated against
   *  STAGE_3_MAX_LOOKAHEAD_TICKS so a long network stall doesn't produce
   *  runaway speculative motion. */
  private readonly _remoteForwardTicks = new Map<string, number>();
  /** Stage 3 — hysteresis guard. Tracks recent correction magnitudes per
   *  remote and disables forward-prediction for entities whose input
   *  intent isn't tracking. */
  private readonly _predGuard: RemotePredictionGuard = createRemotePredictionGuard();

  /** Publicly readable prediction/latency stats. Updated on every snapshot. */
  readonly stats: PredictionStats = {
    rttMs: 0,
    driftUnits: 0,
    angleDriftRad: 0,
    lerping: false,
    snapshotIntervalMs: 0,
    snapshotCount: 0,
    ticksAhead: 0,
    lastServerTick: 0,
    lastAckedTick: 0,
    significantCorrectionCount: 0,
    significantAngleCorrectionCount: 0,
    maxDriftUnits: 0,
    totalDriftUnits: 0,
    maxAngleDriftRad: 0,
    totalAngleDriftRad: 0,
    snapshotJitterMs: 0,
    rollingCorrRate: 0,
    collisionEventsApplied: 0,
    rttMeanMs: 0,
    rttStdDevMs: 0,
    droppedSnapshotsRecent: 0,
    rafP50Ms: Number.NaN,
    rafP99Ms: Number.NaN,
    longtaskCount30s: 0,
    rafGapCount30s: 0,
    heapUsedMb: undefined,
  };

  private room: Room | null = null;

  /** Phase 8 sub-phase B — exposed for the in-game galaxy maps (Pixi
   *  GalaxyMapLayer + GalaxyOverviewScreen warp-mode) to call
   *  `room.send('engage_transit', ...)`. Returns null until `connect()`. */
  getRoom(): Room | null {
    return this.room;
  }

  /** Record a confirmed structure placement so `updateMirror` keeps a dim ghost
   *  at the sent point until the structure lands (playtest 2026-06-10 Issue 7).
   *  Called from `placeStructureAt` right after `place_structure` is sent. */
  notePendingPlacement(kind: StructureKindId, x: number, y: number): void {
    this._pendingPlacement = {
      kind,
      x,
      y,
      sentAtMs: Date.now(),
      baselineStructureCount: this.mirror.structures?.size ?? 0,
    };
  }
  private inputTick = 0;
  /** Raw server snapshot position — shown as the orange ghost ship. */
  private lastSnapshotPos: { x: number; y: number } | null = null;
  /**
   * Server physics tick recorded from the welcome message.
   * Used to normalise snap.serverTick into client-tick space.
   */
  private serverTickAtWelcome = 0;
  /**
   * `this.clock.now()` when the welcome message was processed. Used as the
   * initial anchor for `inputTick`; on every subsequent snapshot the anchor is
   * advanced to the snapshot's `serverTick` (`updateClockAnchor()`). See
   * `tickPhysics()`.
   */
  private welcomePerfNow = 0;
  /**
   * Plan: crispy-kazoo, Commit 3 — `local_died` timestamp anchor.
   * Set by `killEntity` when the local ship dies; consumed by
   * `respawn_clicked` (App.tsx handleRespawn + galaxy sector-pick)
   * to compute `msFromDied`. Reset to 0 on respawn.
   */
  public diedAtMs = 0;
  /**
   * Server tick recorded at `clockAnchorPerfNow` — the live reference frame
   * the client uses to compute `targetTick`. Updated on every snapshot so a
   * server that's running below 60 Hz (overloaded) drags the client's tick
   * advance down with it instead of letting `inputTick` race ahead.
   */
  private clockAnchorServerTick = 0;
  private clockAnchorPerfNow = 0;
  /** True after the first snapshot has anchored the clock. Subsequent
   *  snapshots EWMA-smooth the anchor PerfNow instead of snapping it. */
  private _anchorInitialised = false;
  /** Join-render diagnostic latch. Fires `local_pose_resolved` exactly
   *  once per (re)connect — when `tryInitPredWorld` succeeds and the
   *  local ship's pose is observable in the mirror at server-authoritative
   *  coords. Reset by `resetPredictionState` so transit + ship-swap
   *  arrivals re-fire. */
  private _localPoseResolvedLogged = false;
  /**
   * Estimated half-RTT in ticks. The client should aim to be this many ticks
   * AHEAD of the latest known server tick so its inputs arrive at the server
   * just-in-time for the corresponding server tick. Kept as a smoothed value;
   * jumpy RTT causes oscillation otherwise.
   */
  private leadTicks = 6;

  /** Stage 4 — Welford-based RTT mean + std-dev. Pushed each snapshot
   *  reconcile when `reconciler.lastRtt` is valid (>0). Drives the
   *  `mean + 2σ` lookahead formula in `lookaheadController`.
   *
   *  Mutable (not `readonly`): re-created in `resetPredictionState()` on
   *  sector handoff. The 5+ s transit gap pollutes the RTT stream, and
   *  preserving Welford state across rooms saturates `leadTicks` at the
   *  30-tick cap for tens of seconds post-arrival. See
   *  `resetPredictionState()` for the full pathology. */
  private _rttWelford: WelfordState = createWelford();
  /** Stage 4 — spring-smoothed lookahead controller. Replaces the
   *  pre-Stage-4 EWMA on `leadTicks` with a critically-damped ramp on
   *  multi-tick changes; small changes snap directly. Mutable for the
   *  same reason as `_rttWelford`. */
  private _lookaheadCtrl: LookaheadController = createLookaheadController(6);
  /** Stage 4 — sliding-window count of dropped snapshots over the last
   *  10 arrivals. Drives `computeInterpBiasMs` which biases the swarm
   *  display-delay floor when the wire is dropping packets. Mutable for
   *  the same reason as `_rttWelford`. */
  private _dropDetector: DropDetector = createDropDetector();
  /** Diagnostic — set of swarm entityIds currently within the overlap log
   *  threshold of the local ship. Used to emit `swarm_near_enter` /
   *  `swarm_near_exit` events for the "overlapping with enemy ships"
   *  diagnostic. Entry/exit semantics avoid flooding the 500-entry
   *  ring buffer with per-frame proximity logs. */
  private _swarmNearbyIds: Set<number> = new Set();
  /** 2026-05-25 heap-growth gate step 2 — second Set swapped with
   *  `_swarmNearbyIds` each RAF in the swarm-near-enter/exit diagnostic.
   *  Pre-fix allocated `new Set<number>()` per RAF. Both Sets are class
   *  fields, allocated once; the swap reassigns references. */
  private _swarmNearbySwapScratch: Set<number> = new Set();
  /** 2026-05-25 heap-growth gate step 3 — persistent Map scratch for
   *  pre-reset remote-ship positions inside handleSnapshot. Pre-fix
   *  allocated `new Map<>()` per snapshot. `.clear()` at top of use. */
  private readonly _preResetRemotePosScratch = new Map<string, { x: number; y: number }>();
  /** 2026-05-25 heap-growth gate step 3 — pool of `{x, y}` entries
   *  reused inside `_preResetRemotePosScratch`. Per-snapshot peak ==
   *  remote-ship count; grows once, never shrinks (bounded by max
   *  concurrent remotes in the room). */
  private readonly _preResetRemotePosEntries: { x: number; y: number }[] = [];
  /** 2026-05-25 heap-growth gate step 5 — pooled state object for the
   *  swarm-kinematic-follower setShipState loop in updateMirror. Pre-
   *  fix the loop allocated `{x, y, vx, vy, angle, angvel: 0}` literal
   *  PER drone PER RAF (25 × 90 = 2250/sec). Mutate, then pass; the
   *  World copies into Rapier synchronously so next iteration reuses. */
  private readonly _swarmKinematicScratch = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  /** 2026-05-25 heap-growth gate step 5 — pre-computed `swarm-${id}`
   *  body-key strings, cached on first encounter. Pre-fix the swarm-
   *  kinematic loop did `` `swarm-${entityId}` `` per drone per RAF =
   *  2250 template-literal string allocs/sec. Keyed by entityId. */
  private readonly _swarmBodyKeyCache = new Map<number, string>();
  /** 2026-05-25 heap-growth gate step 5 — persistent Set scratch for
   *  syncSwarmIntoPredWorld's per-packet "seen" sweep. Pre-fix
   *  allocated `new Set<string>()` per binary swarm packet (~60 Hz). */
  private readonly _swarmSyncSeenScratch = new Set<string>();
  /** Shield-fence plan — predWorld shield-wall body ids currently spawned, and a
   *  reused "desired this snapshot" scratch set (syncPredWalls reconciles them). */
  private readonly _predWallIds = new Set<string>();
  private readonly _predWallDesired = new Set<string>();
  /** 2026-05-25 heap-growth gate step 8 — pooled `{targetId, damage}`
   *  literal for the per-damage-event reconcileDamageToFeedback call.
   *  Under 25-drone combat at ~75 hits/sec, the pre-fix per-event
   *  literal was a real allocator. Mutate the scratch each call. */
  private readonly _damageReconcileScratch: { targetId: string; damage: number } = { targetId: '', damage: 0 };
  /** 2026-05-25 heap-growth gate steps 8-10 — 1Hz HUD-store dispatcher.
   *  Owns swarm-count + hull-pct + shield-pct dedupe + 1Hz throttle so
   *  per-event handlers (handleDamage / handleShield / swarm-decoder)
   *  pay zero Zustand-notification cost on no-op updates. Extracted to
   *  `HudDispatcher.ts`. */
  private readonly hudDispatcher = new HudDispatcher();
  /** 2026-05-26 heap-growth gate step 11 — pooled `{hit, targetId, damage}`
   *  literal for the per-hit_ack reconcileAckToFeedback call. Same shape
   *  as `_damageReconcileScratch`: `PredictedAck` consumer reads the
   *  fields synchronously inside `HitPredictionLedger.reconcileAck` and
   *  never retains the reference (verified at HitPrediction.ts:142). */
  private readonly _hitAckReconcileScratch: { hit: boolean; targetId?: string; damage?: number } = { hit: false, targetId: undefined, damage: undefined };
  /** 2026-05-26 heap-growth gate step 11 — pooled per-snapshot replay-
   *  grade serverState capture. Pre-fix `recPositions` was a 10-field
   *  object literal allocated per snapshot (20 Hz). Both consumers
   *  (`logEvent('correction', ...)` and `logEvent('snapshot', ...)`)
   *  spread the fields out by value, so the scratch identity does not
   *  matter — the LogEntry's `data` ends up with copied numbers. */
  private readonly _recPositionsScratch = {
    serverX: 0, serverY: 0,
    serverVx: 0, serverVy: 0,
    serverAngle: 0, serverAngvel: 0,
    beforeX: 0, beforeY: 0,
    afterX: 0, afterY: 0,
  };
  /** 2026-05-25 heap-growth gate step 1 — persistent Set scratch for
   *  tracking lingering shipInstanceIds seen in the current snapshot.
   *  Pre-fix allocated `new Set<string>()` per snapshot (20 Hz).
   *  Cleared via `.clear()` at the top of each handleSnapshot call. */
  private readonly _lingeringSeenScratch = new Set<string>();
  /** 2026-05-25 heap-growth gate step 1 — persistent array scratch for
   *  the lingering-eviction loop. Pre-fix used
   *  `[...this.mirror.lingeringShips.keys()]` (a per-snapshot array
   *  allocation). Cleared via `length = 0` at the eviction site. */
  private readonly _lingeringToEvictScratch: string[] = [];
  /** Phase 4 (plan: quirky-rabbit) — class-field Set scratches replacing
   *  the per-call `new Set<string>()` literals at the syncMirror /
   *  updateLiveBeam sites. Each is cleared at the top of its consumer;
   *  population is bounded by the cache it's reconciling against (wreck
   *  count, ship count, mount count) so allocations after warmup are zero. */
  private readonly _syncMirrorSeenWrecksScratch = new Set<string>();
  private readonly _syncMirrorSeenShipsScratch = new Set<string>();
  /**
   * Phase 4 iteration 3 swift-otter HYBRID (2026-05-30):
   * - `_syncMirrorRanThisRaf`: cleared at the top of `tickPhysics`,
   *   set when the inline first-onStateChange-per-frame fires
   *   syncMirror. Once true, subsequent onStateChange events in the
   *   same RAF window go through `_pendingStateForSync` instead.
   * - `_pendingStateForSync`: latest state ref from any deferred
   *   (non-first) onStateChange events. Drained at start of next
   *   `tickPhysics`.
   * Together they cap syncMirror calls at MAX 2 per RAF (one inline +
   * one drain) while preserving the synchronous-first-call semantics
   * the reconciler's drift baseline depends on.
   */
  private _syncMirrorRanThisRaf = false;
  private _pendingStateForSync: unknown = null;
  private readonly _liveBeamMountIdsScratch = new Set<string>();
  private readonly _syncProjectilesSeenScratch = new Set<string>();
  /** 2026-05-26 heap-growth gate step 12 — pre-bound method for
   *  `routeSnapshotShipStates` ctx. Pre-fix the call site allocated
   *  a fresh arrow `(id) => this.tryEnsureLingerPredBody(id)` per
   *  snapshot (20 Hz). Bound once at construction. */
  private readonly _boundTryEnsureLingerPredBody = (id: string): void => {
    this.tryEnsureLingerPredBody(id);
  };
  /** 2026-05-26 heap-growth gate step 12 — pooled ctx for
   *  `routeSnapshotShipStates`. All references stable except
   *  `predWorld` (null until first welcome), which is mutated on the
   *  ctx before each call. Pre-fix every snapshot (20 Hz) allocated
   *  a fresh 6-field ctx literal + the bound arrow above. */
  private readonly _routeSnapshotShipStatesCtx: ShipRouterCtx = {
    mirror: this.mirror,
    predWorld: null,
    lingerBodies: this.lingerBodies,
    tryEnsureLingerPredBody: this._boundTryEnsureLingerPredBody,
    lingeringSeenScratch: this._lingeringSeenScratch,
    lingeringToEvictScratch: this._lingeringToEvictScratch,
  };
  /** 2026-05-26 heap-growth gate step 12 — pooled ctx for
   *  `preResetRemoteShips`. Same pattern as above; `predWorld` is the
   *  only volatile field. Pre-fix allocated a fresh 6-field ctx per
   *  snapshot (20 Hz). */
  private readonly _preResetRemoteShipsCtx: PreResetRemoteCtx = {
    predWorld: null,
    mirror: this.mirror,
    preResetRemotePosScratch: this._preResetRemotePosScratch,
    preResetRemotePosEntries: this._preResetRemotePosEntries,
    remoteLastInputs: this._remoteLastInputs,
    remoteForwardTicks: this._remoteForwardTicks,
  };
  private disposed = false;

  // Wall-clock-anchored input loop (driven by rAF in App.tsx).
  private keyboard: { read: () => { thrust: boolean; turnLeft: boolean; turnRight: boolean; fireHeld: boolean; boost: boolean; reverse: boolean } } | null = null;
  private touchInput: TouchInput | null = null;
  private lastFiredAtTick = -999;
  /** 2026-05-20 spiral fix: previous joystick-resolved boolean state.
   *  Drives the hysteresis bands in `joystickToInput`. Reset on
   *  disconnect / death so the engaged-band re-anchors on next stick
   *  use. */
  private _joystickInputState: JoystickInputState = IDLE_INPUT_STATE;

  /** Multi-mount/turret refactor (Phase 4b.2): sticky target id chosen by
   *  the local ship's turret AI last tick. Reset to null on death, sector
   *  handoff, and respawn so a new spawn starts with no pin. Per-instance
   *  rather than per-mount because all mounts in a slot share one target
   *  (user-clarified design rule). */
  private _localSlotTarget: string | null = null;
  /** Reused scratch for the active-slot mount-id set in `tickLocalMountAim`
   *  (alloc-free per-frame membership test; invariant #14). */
  private readonly _activeMountIdsScratch = new Set<string>();
  /** Reused placement-preview object written into `mirror.pendingPlacementPreview`
   *  (Issue 5). Mutated in place each frame placement mode is active — no
   *  per-frame allocation (invariant #14). */
  private readonly _placementPreviewScratch: PlacementPreview = { kind: 'capital', x: 0, y: 0, angle: 0, pending: false };
  /** Reused ship-pose scratch for the placement-preview resolver — avoids a
   *  per-frame `{x,y,angle}` alloc during placement mode (invariant #14). */
  private readonly _placementShipScratch: ShipPose = { x: 0, y: 0, angle: 0 };
  /** A confirmed-but-not-yet-visible placement (playtest 2026-06-10 Issue 7).
   *  Keeps a dim ghost at the sent point until the structure lands or times
   *  out, so the blueprint doesn't vanish for ~1 s after Confirm. */
  private _pendingPlacement: PendingPlacement | null = null;

  // ── Auto-fire (weapon-autofire-boost-mechanics, Part B/C) ──────────────
  /** Drone-only aim targets (kind=1) built once per frame by
   *  `tickLocalMountAim` (`buildLocalAimTargets`); the once-per-RAF fire block
   *  REUSES this reference for the auto-fire pick, so no second target build /
   *  allocation (invariant #14). May be ≤1 frame stale on a zero-iteration RAF
   *  — acceptable (matches the existing aim lead-lag); the fire block guards on
   *  `.length`. */
  private _lastAimTargets: LocalAimTarget[] = [];
  /** Cached active-slot weapon resolution, keyed by (kind, slotId). Auto-fire
   *  (default ON) evaluates the fire block EVERY frame, so resolving the slot
   *  via `resolveSlotMounts` (which allocates) every frame would violate
   *  invariant #14 — recompute only when the kind or active slot changes. */
  private _afSlotKindKey: string | null = null;
  private _afSlotIdKey: string | null = null;
  private _afSlotWeaponDef: WeaponDef = getWeapon('hitscan');
  private _afSlotCooldownTicks = 0;
  /** Idle-suppression for the input upstream (network-discipline P4). The
   *  client only emits an `input` message when the control state has changed
   *  since the last send OR when {@link INPUT_HEARTBEAT_MS} has elapsed.
   *  Idle players (no keys held) drop from ~60 packets/s to ~4/s, removing
   *  the dominant chunk of upstream chatter. The server is tolerant of
   *  missing ticks: a tick with no inbound input simply gets no impulse, and
   *  drag handles the rest. Reconciliation replays only inputs we actually
   *  recorded locally (still 60 Hz), so the prediction model is unaffected. */
  private lastSentInputState: { thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean } | null = null;
  private lastSentInputAtMs = 0;
  /**
   * Per-tick scratch literals — pool everything tickPhysics's inner
   * loop builds at 60 Hz. Pre-pool the CDP allocation profile (2026-
   * 05-30) ranked `tickPhysics` rank-2 at 81 KB / 7.5 %; the bulk of
   * that was these four object literals × 60 Hz × test duration. All
   * downstream consumers (Reconciler, predWorld, room.send) read the
   * values out of the literal immediately so passing the same scratch
   * reference per tick is safe — Reconciler.recordInput copies the
   * fields into its own ring buffer; predWorld.applyInput reads them
   * into Rapier; colyseus.js room.send serialises the literal before
   * returning. Initialised once, mutated per tick.
   */
  private readonly _inputRecScratch: InputRecord = {
    tick: 0,
    thrust: false,
    turnLeft: false,
    turnRight: false,
    boost: false,
    reverse: false,
    sentAt: 0,
  };
  private readonly _applyInputScratch: {
    thrust: boolean;
    turnLeft: boolean;
    turnRight: boolean;
    boost: boolean;
    reverse: boolean;
  } = { thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false };
  private readonly _sendInputScratch: {
    type: 'input';
    tick: number;
    thrust: boolean;
    turnLeft: boolean;
    turnRight: boolean;
    boost: boolean;
    reverse: boolean;
  } = {
    type: 'input',
    tick: 0,
    thrust: false,
    turnLeft: false,
    turnRight: false,
    boost: false,
    reverse: false,
  };
  /** Elapsed ms of the last frame — used by updateMirror() for ghost advancement. */
  private lastFrameMs = 1000 / 60;

  // Prediction
  private predWorld: PhysicsWorld | null = null;
  private reconciler: Reconciler | null = null;

  /** Wall-clock at the most recent physics tick advance.
   *  Render-jitter-fix Phase 1 (2026-05-21): used in `updateMirror` to
   *  dead-reckon the rendered pose forward by `(clock.now() -
   *  _lastLocalTickAtMs) × velocity` so 0-step RAFs (RAF fires but no
   *  physics tick was due — ~58 % of mobile RAFs on 90 Hz displays
   *  with 60 Hz physics) show smooth velocity-based motion instead of
   *  a frozen pose. This addresses the user-reported "stop-start"
   *  perception — locked by `assertFramePacingSmooth` on the 2q0jxw
   *  capture. Updated inside `tickPhysics` after each `predWorld.tick`.
   *  Sentinel `-1` = "no tick has fired yet"; dead-reckon skipped. */
  private _lastLocalTickAtMs = -1;

  /** Render-jitter-fix Phase 1b instrumentation (2026-05-21): wall-clock
   *  of the most recent `room.onMessage('snapshot', ...)` arrival. Used
   *  by the new `snapshot_received` event to log the gap between
   *  successive WS-receive timestamps — distinguishes "server didn't
   *  send" from "we couldn't process in time" from "WebSocket queue
   *  bunched up". Sentinel `-1` = no snapshot yet. */
  private _lastSnapshotRecvAtMs = -1;

  /** Heap + stall instrumentation (2026-05-21, render-jitter probe).
   *  Per-RAF heap + frame-gap detector — owns the rolling
   *  swarm-decode window, the >100ms `raf_gap` log (heap delta +
   *  ms-since-last-stall) and the 30-100ms `raf_stutter` log.
   *  See `RafStallDetector.ts`. */
  private readonly rafStallDetector = new RafStallDetector();
  /** Probe 5 — rolling fields for the per-snapshot reconcile cost.
   *  Surfaced on `snapshot_applied` so a capture shows reconcile time
   *  separately from the rest of handleSnapshot. The y0eo1h capture
   *  (2026-05-24) confirmed applyMs ≈ 1.0 ms + 0.04 ms × ticksAhead —
   *  reconcile is the dominant cost, scaling linearly with the replay
   *  window. -1 sentinel when not yet measured. */
  private _lastReconcileMs = -1;
  private _lastReplayWindow = -1;

  /** Probe 6 (mobile-perf-investigation, 2026-05-24) — snapshot
   *  coalescing on receive.
   *
   *  The 2kn41x capture proved a GC-driven spiral: a ~500 ms major-GC
   *  pause queues ~10 snapshots in the WebSocket event-queue. When the
   *  main thread frees, all 10 fire `onMessage` in burst, each
   *  measuring `RTT = now - inputSentAt`, with `now` being the
   *  burst-tail time. The Welford RTT estimator absorbs 10 inflated
   *  samples, drives ticksAhead up, reconcile cost grows, more main-
   *  thread time, more frequent GC pauses → spiral.
   *
   *  Coalescing: store the latest snapshot as pending, process at the
   *  top of `tickPhysics` (next RAF). When a GC pause queues 10
   *  snapshots, the last one overwrites the first nine — they were
   *  full-state anyway, so the newest fully supersedes them. Damage
   *  events fire on a SEPARATE `onMessage('damage', ...)` channel, so
   *  no events are lost.
   *
   *  Net effect: 1 RTT sample per GC-burst instead of ~10. Welford
   *  mean stays stable. Spiral breaks.
   *
   *  Default ON. URL override: `?coalesce=0` disables for A/B testing. */
  private readonly snapshotCoalescer: SnapshotCoalescer;
  /** Phase 2 swift-otter — opt-in flag for the DataChannel transport.
   *  URL `?webrtc=1` enables. Default OFF — Phase 4 E2E evidence is
   *  required before flipping the default. */
  private readonly _webrtcEnabled: boolean;
  /** Phase 2 swift-otter — lifecycle-managed DC transport. Created in
   *  the welcome handler when `_webrtcEnabled === true`, closed on
   *  room leave / sector handoff. */
  private _dataChannelTransport: DataChannelTransport | null = null;

  // Snapshot timing
  private lastSnapshotAt = 0;
  // Rolling buffers for jitter and correction-rate metrics (last 10 snapshots).
  private readonly _recentIntervals: number[] = [];
  /** Drone snapshot-interpolation pivot (Step 4, 2026-05-18) — adaptive
   *  swarm display-delay is sized from the BINARY swarm packet
   *  inter-arrival cadence, NOT the 20 Hz JSON snapshot interval. The
   *  binary channel is what actually carries drone pose: in-interest ≈
   *  per server tick (~16 ms), out-of-interest decimated (~100–170 ms).
   *  Sizing the buffer to the JSON snapshot rate (always ~50 ms) would
   *  over-buffer the fast combat case and under-buffer decimated drones.
   *  `_swarmBinaryLastMs` = perf.now() of the previous binary packet (-1 =
   *  none yet); `_swarmBinaryEwma` = EWMA of inter-arrival ms (0 = unseeded). */
  private _swarmBinaryLastMs = -1;
  private _swarmBinaryEwma = 0;
  private readonly _recentCorrFlags: number[] = [];

  // Remote ship interpolation: per-player timestamped history
  private remoteHistory = new Map<string, RemoteEntry[]>();

  // Combat
  private readonly ghostManager = new GhostManager();
  /** Damage flash: set of player IDs currently flashing red (cleared after one frame). */
  private readonly _damageFlashFrames = new Map<string, number>();
  /** Smooth-beam (2026-05-22): scheduled visual-only damage-number spawns,
   *  drained per frame in `updateMirror`. Each predicted hit splits its
   *  damage into N small ticks spread across the cooldown window so the
   *  on-screen feel is continuous while the server cadence (and wire
   *  load) stays at the original 6 Hz. Splits share one `clientShotId`
   *  so existing `cancelByTag` / `reconcileDamageToFeedback` handle
   *  rollback / confirmation unchanged. */
  private _scheduledDamageSpawns: Array<{ atMs: number; targetId: string; x: number; y: number; damage: number; tag: string }> = [];
  /** weapon-hit-prediction — client favor-the-shooter hit-prediction ledger.
   *  Phase 2 records a prediction on every fire (presentation-only) and
   *  TTL-expires it; Phase 3 wires the hit_ack / DamageEvent reconcile so
   *  exactly one number shows per confirmed hit. The server stays 100%
   *  hit-authoritative — this only hides the RTT on the felt impact. */
  private readonly _hitLedger = new HitPredictionLedger();
  /** beam-attach fix (capture pe6rdt) — `this.clock.now()` of the last
   *  LOCAL hitscan fire. The continuous liveBeam (redrawn from
   *  `mirror.ships` every frame, so rigidly ship-attached) persists for
   *  `LIVE_BEAM_PERSIST_MS` past this so a tap / held burst reads as ONE
   *  continuous beam instead of a 1-tick flicker or a chain of frozen
   *  ghosts. Null ⇒ no live hitscan beam. */
  private _lastHitscanFireMs: number | null = null;
  /** weapon-hit-prediction Phase 3 — routes ledger reconcile corrections
   *  onto the existing mirror drains. cancel → the pendingDamageNumber-
   *  Cancels queue (renderer hard-cancels by tag); flash-clear → drop the
   *  predicted 6-frame flash. */
  private readonly _reconcileSink: ReconcileFeedbackSink = {
    cancelPredictedNumber: (id) => {
      this.mirror.pendingDamageNumberCancels?.push(id);
      // Smooth-beam (2026-05-22): also evict any not-yet-due scheduled
      // splits sharing this clientShotId so a mispredict / TTL-expiry
      // does not produce a delayed phantom number AFTER the rollback.
      // Splits already spawned into `pendingDamageNumbers` are
      // hard-cancelled by the existing `cancelByTag` queue (above).
      let cancelledScheduled = 0;
      for (let i = this._scheduledDamageSpawns.length - 1; i >= 0; i--) {
        if (this._scheduledDamageSpawns[i]!.tag === id) {
          this._scheduledDamageSpawns.splice(i, 1);
          cancelledScheduled++;
        }
      }
      // Probe 4 (mobile-perf-investigation, 2026-05-24) — surface cancels
      // so the damage_number_scheduled count vs damage_number_spawned count
      // diff is explicable. `cancelledScheduled` may be 0 (cancel arrived
      // after all splits already spawned) or up to count-1 (cancel arrived
      // after the immediate spawn but before any scheduled splits drained).
      if (cancelledScheduled > 0) {
        logEvent('damage_number_cancelled', { tag: id, cancelledScheduled });
      }
    },
    clearPredictedFlash: (tid) => {
      this._damageFlashFrames.delete(tid);
    },
  };
  /** Set when the local ship is destroyed — blocks firing until reconnect. */
  private localDead = false;

  /** Predicted energy pool for the local ship (weapons/energy/AI overhaul
   *  §3.2). Driven entirely by the player's OWN fire/boost input, so it's
   *  predictable like position: regen + boost drain in `tickPhysics`, fire
   *  drain in `sendFire`, hard-reconciled from `snap.states[localId].energy`
   *  each snapshot. NOT in Zustand — it changes per frame; the top-center
   *  EnergyBar reads it via a RAF loop + direct-DOM write. */
  private predEnergy = 0;

  /** Inject the audio sink before `connect()`. Wired by `App.tsx`'s bootstrap. */
  setAudio(audio: IAudio): void {
    this.audio = audio;
  }

  /**
   * Wipe the Stage 4 prediction-loop state so the next snapshot from a
   * fresh sector room behaves like a first-connect snapshot.
   *
   * Why this exists: the `transit_ready` handler hot-swaps the room's
   * WebSocket via `consumeSeatReservation` but reuses the same
   * `ColyseusClient` instance. Without an explicit reset, the welford
   * RTT mean/σ, the spring-smoothed `leadTicks`, the snapshot-interval
   * EWMA, the drop detector, and the clock anchor all carry across
   * the 5+ s transit gap. The first wave of post-transit snapshots
   * push gap-contaminated `lastRtt` samples (clamped to 250 ms by Stage 4
   * hotfix #1, but still pushed when `intervalMs` lands back in the
   * [35, 75] band by hotfix #3) into the surviving welford, the running
   * mean drifts up, `mean + 2σ` saturates the 30-tick `CEILING_TICKS`
   * cap in `lookaheadController`, and the client predicts ~600 ms
   * ahead of authoritative state. Symptoms: `srvTick − ackedTick` locks
   * at ~−37 for the rest of the session, the local ship renders far
   * from where the server thinks it is, large reconcile drifts, and
   * 60–70% of snapshots produce a correction that lerping must mask.
   *
   * Diagnosed from cap `2026-05-09T07-49-57-470Z-81numi` (post-warp,
   * 67% correction rate, every snapshot at offset −37); cap
   * `2026-05-09T07-51-26-622Z-wc5fm0` (steady-state long after the same
   * session, offset settled to −15) is the clean baseline.
   *
   * Spatial seed (2026-05-16 fix). The pre-2026-05-16 version reset only
   * the RTT/timing state above and left the local `predWorld` ship body
   * + the `Reconciler` instance untouched. The `transit_ready`
   * mirror-cleanup loop preserves the local ship, so `tryInitPredWorld`
   * early-returned on `predWorld.hasShip(localId)` at the destination and
   * the body arrived still at the SOURCE-sector pose. The destination's
   * first `handleSnapshot` then reconciled that stale body against the
   * arrival pose, surfacing the entire source→destination delta as
   * "drift" (210-380 u on-device, diag
   * `2026-05-16T11-59-43-103Z-tl56wa`), which the reconciler lerped out
   * over ~1.3 s post-curtain — the warp-out jank. So this also despawns
   * the local predWorld body and NULLS the reconciler: the destination's
   * first state-diff / snapshot reseeds via the existing
   * `tryInitPredWorld` path AT THE AUTHORITATIVE ARRIVAL POSE (which
   * rebuilds the `Reconciler`), making the "fresh-connect seed" the
   * comment above promises true for the spatial body too. Nulling the
   * reconciler also subsumes the old `reconciler.lastRtt = 0` (there is
   * no surviving reconciler to re-poison the welford). `handleSnapshot`
   * + `tickPhysics` both already guard `!this.reconciler` (the
   * pre-first-welcome state) — the fix re-enters that well-tested state,
   * it does not invent one. One ownership site; no second correction
   * path (Invariant #12 philosophy). Locked by
   * `ColyseusClient.transitArrivalDrift.test.ts`.
   */
  private resetPredictionState(): void {
    this._rttWelford = createWelford();
    this._lookaheadCtrl = createLookaheadController(6);
    this._dropDetector = createDropDetector();
    this.leadTicks = 6;
    this._anchorInitialised = false;
    this.lastSnapshotAt = 0;
    this._recentIntervals.length = 0;
    this._recentCorrFlags.length = 0;
    // Drone display-delay cadence tracking — reset so the destination
    // sector's binary cadence is learned fresh (a stale cross-warp gap
    // must not seed the adaptive delay at the ceiling).
    this._swarmBinaryLastMs = -1;
    this._swarmBinaryEwma = 0;
    // Spatial seed (2026-05-16) — see the method doc comment. Despawn the
    // local predWorld ship body and drop the Reconciler so the
    // destination's first state-diff / snapshot reseeds the body AT THE
    // AUTHORITATIVE ARRIVAL POSE via `tryInitPredWorld` (which rebuilds
    // the Reconciler). Without this the body carries the source pose into
    // the destination and the first reconcile lerps out the full
    // inter-sector delta — the warp-out drift jank. Subsumes the old
    // `reconciler.lastRtt = 0` (no surviving reconciler to re-poison the
    // welford).
    const localId = this.mirror.localPlayerId;
    if (localId && this.predWorld?.hasShip(localId)) {
      this.predWorld.despawnShip(localId);
    }
    this.reconciler = null;
    // Phase 3 — drop AI registrations on sector handoff. The destination
    // sector has a different swarm; old behaviours would hold stale
    // `lastFireTick` and target stale player IDs that may not exist there.
    for (const id of this._aiRegisteredIds) {
      this._aiController.unregister(`${id}`);
    }
    this._aiRegisteredIds.clear();
    // Shield-fence plan — drop predWorld shield-wall colliders on handoff; the
    // destination sector's fences re-sync from its own structure slice.
    for (const wid of this._predWallIds) this.predWorld?.removeWall(wid);
    this._predWallIds.clear();
    this._predWallDesired.clear();
    // Multi-mount/turret refactor (Phase 4b.2): drop the local ship's
    // sticky turret target on sector handoff — the destination sector has
    // a fresh swarm with different ids, so holding the previous pin would
    // mean "no target in view" until the controller times out and re-picks.
    this._localSlotTarget = null;
    // Join-render diagnostic latch — re-arm so the destination room's
    // `tryInitPredWorld` success fires a fresh `local_pose_resolved`.
    this._localPoseResolvedLogged = false;

    // Render-jitter-fix Phase 1 (2026-05-21): the dead-reckon anchor is
    // part of the prediction window — its sample is from the source
    // sector's predWorld and dead-reckoning forward from it across a
    // transit gap would produce nonsense motion. Reset to -1 sentinel;
    // next physics tick post-transit re-stamps it.
    this._lastLocalTickAtMs = -1;

    // Phase 2 swift-otter — close the DataChannel transport on sector
    // handoff. The source room's PeerConnection is torn down; the
    // destination room's welcome handler will start a fresh one when
    // the `_webrtcEnabled` flag is set. Reset the reordering guard so
    // the destination's serverTick is accepted.
    if (this._dataChannelTransport) {
      this._dataChannelTransport.close('sector-handoff');
      this._dataChannelTransport = null;
    }

    // Smooth-beam (2026-05-22): drop scheduled visual splits. The source
    // sector's prediction state is dead; any pending splits would spawn
    // damage numbers at coordinates from the source pose against the
    // destination mirror.
    this._scheduledDamageSpawns.length = 0;

    // Effects subsystem (M9 — plan wiggly-puppy). The pendingEffectTriggers
    // queue holds source-sector world coords; draining them in the
    // destination would spawn effects at the wrong place. Drop them.
    // Per-entity continuous emitters + shield rings live in the renderer's
    // EffectsService instance, which the renderer cleans up on its own
    // (PixiRenderer.dispose or syncEngine/ShieldAura's diff-against-empty-
    // mirror on the first destination frame). The mirror.ships clear that
    // happens elsewhere will already empty the diff sets that drive the
    // setContinuous calls, so emitters get unregistered naturally.
    if (this.mirror.pendingEffectTriggers) this.mirror.pendingEffectTriggers.length = 0;
  }

  async connect(
    wsUrl: string,
    storedPlayerId: string | null,
    keyboard: { read: () => { thrust: boolean; turnLeft: boolean; turnRight: boolean; fireHeld: boolean; boost: boolean; reverse: boolean } },
    callbacks: ColyseusClientCallbacks,
    roomName = 'sector',
    extraJoinOptions: Record<string, unknown> = {},
    touchInput?: TouchInput,
  ): Promise<void> {
    // Mobile main-thread block detector — see `longtaskObserver.ts` for the
    // motivating capture (`2026-05-09T07-23-39-893Z-651792`: two ~500–600 ms
    // client-receive gaps with the server emitting cleanly throughout).
    // Idempotent; safe to call again on reconnect.
    installLongtaskObserver();
    // r2 evidence pass — visibility / freeze / resume / connection
    // change listeners. Distinguishes "page backgrounded" throttle
    // from "phone CPU throttle" in effectiveHz drops.
    installPageLifecycleObserver();
    // Paradigm plan (quirky-rabbit) Phase 6 — kick the rolling-30 s
    // health-stats publisher. Idempotent at the function-level: the
    // setInterval is set per call, but every connect() call is in fact
    // a fresh ColyseusClient instance via clientSingleton, so it lands
    // exactly once per session.
    startHealthStatsPublisher((s) => useUIStore.getState().setHealthStats(s));

    // Init client-side prediction world before joining so it is ready as soon as
    // we receive our playerId.
    this.predWorld = await PhysicsWorld.create();

    callbacks.onConnectionStatus('connecting');
    logEvent('cc_connecting', { wsUrl, playerId: storedPlayerId ?? null });
    const client = new Client(wsUrl);

    let resolvedRoom: Room;
    try {
      logEvent('cc_join_attempt', {});
      const { loadToken } = await import('../auth/tokenStorage.js');
      const authToken = loadToken();
      // Pull the player's selected ship kind out of the UI store at the moment
      // we open the room. Server validates and falls back to the catalogue
      // default on any unknown id (`isShipKindId`), so a mid-build kind change
      // can't crash the spawn path. Limbo / rebind paths ignore this.
      const shipKind = useUIStore.getState().selectedShipKind;
      const joinPromise = client.joinOrCreate<unknown>(roomName, {
        playerId: storedPlayerId,
        ...(authToken ? { authToken } : {}),
        shipKind,
        ...extraJoinOptions,
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('joinOrCreate timed out after 12 s — WS proxy likely broken')), 12000),
      );
      resolvedRoom = await Promise.race([joinPromise, timeoutPromise]);
    } catch (err) {
      logEvent('cc_join_failed', { err: String(err) });
      callbacks.onConnectionStatus('error');
      throw err;
    }

    if (this.disposed) {
      resolvedRoom.leave();
      return;
    }

    this.room = resolvedRoom;
    logEvent('cc_join_resolved', { roomId: this.room.roomId });

    // Phase 5e: DEV-only inbound-bandwidth tally exposed on `window` so the
    // swarm-bandwidth E2E can sample bytes/sec without DPI-level WS plumbing.
    // Tracks `swarmBytes` (binary channel — the dominant cost) and
    // `snapshotBytes` (JSON-shape approximation). Production builds tree-
    // shake the window assignment via the import.meta.env.DEV branch.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __EQX_BW_STATS?: BwStats };
      if (!w.__EQX_BW_STATS) {
        // Closure-capture the injected clock so the `reset()` method (where
        // `this` rebinds to `stats`) still uses the right time source.
        const devClock = this.clock;
        const stats: BwStats = {
          startedAt: devClock.now(),
          swarmBytes: 0,
          swarmPackets: 0,
          snapshotBytes: 0,
          snapshotCount: 0,
          reset(): void {
            this.startedAt = devClock.now();
            this.swarmBytes = 0;
            this.swarmPackets = 0;
            this.snapshotBytes = 0;
            this.snapshotCount = 0;
          },
        };
        w.__EQX_BW_STATS = stats;
      }
    }

    // Phase 8 sub-phase B — extracted handler binding so the same set of
    // listeners can be re-attached to the destination room post-transit
    // (after `client.consumeSeatReservation`). Closure-captures
    // `storedPlayerId` / `callbacks` / `bwStats` so the body stays identical
    // to the pre-extraction version. Called once below for the initial
    // room, and again from the `transit_ready` handler for the destination.
    const bindRoomHandlers = (room: Room): void => {
      room.onMessage('welcome', (msg: WelcomeMessage) => {
      const idChanged = storedPlayerId && msg.playerId !== storedPlayerId;
      logEvent('cc_welcome', {
        playerId: msg.playerId,
        serverReassigned: Boolean(idChanged),
        serverTick: msg.serverTick,
      });
      this.serverTickAtWelcome = msg.serverTick;
      this.welcomePerfNow = this.clock.now();
      this.clockAnchorServerTick = msg.serverTick;
      this.clockAnchorPerfNow = this.welcomePerfNow;
      // The welcome handshake gives us a perfect anchor; let the next
      // snapshot drop straight into EWMA-smoothing instead of snapping.
      this._anchorInitialised = true;
      this.inputTick = msg.serverTick; // Sync to server tick space so fire messages pass temporal plausibility check.
      // Reset idle-input throttle: the first input after a (re)connect must
      // always reach the server so it has a baseline before tick advance.
      this.lastSentInputState = null;
      this.lastSentInputAtMs = 0;
      logEvent('welcome', { playerId: msg.playerId, serverTick: msg.serverTick, idReassigned: !!idChanged });
      this.mirror.localPlayerId = msg.playerId;
      // The local ACTIVE ship's id. Own-ship snapshot routing keys on this,
      // not just playerId, because a displaced player owns BOTH a lingering
      // hull and a fresh active ship under one playerId (2026-06-03 "pinned
      // in my old interceptor" bug).
      this.mirror.localShipInstanceId =
        msg.shipInstanceId && msg.shipInstanceId !== '' ? msg.shipInstanceId : null;
      callbacks.onPlayerId(msg.playerId);
      // Phase 8 — surface the stable galaxy sector key for HUD + galaxy-map
      // overlay consumers. `null` for engineering rooms. The display name is
      // also refreshed here so post-transit reconnects update the HUD; the
      // initial App.tsx setSectorName covers engineering rooms (key=null).
      const ui = useUIStore.getState();
      ui.setCurrentSectorKey(msg.sectorKey);
      if (msg.sectorKey) {
        const sec = getSector(msg.sectorKey);
        if (sec) ui.setSectorName(sec.name);
      }
      // Phase 5 — identify the ship the LOCAL browser session is bound to.
      // Distinct from any `ship.isActive` flag on the roster (which stays
      // true through the 15-min reconnect linger window even when no
      // session is driving it). The roster panel + detail modal use this
      // to drive the "Piloting" disabled state and the switch-confirm.
      // Empty string from engineering rooms or pre-Phase-5 servers ⇒ null.
      ui.setLocalShipInstanceId(msg.shipInstanceId && msg.shipInstanceId !== '' ? msg.shipInstanceId : null);

      // Plan: crispy-kazoo, Commit 8 — rescue own ship from lingeringShips.
      // Pre-welcome our own ship is `isActive=false` (server's spawn-
      // handshake design) and the snapshot translator + syncMirror both
      // route isActive=false → mirror.lingeringShips because they don't
      // yet know our localPlayerId. Now that welcome has arrived, lift
      // our ship out so `tryInitPredWorld` can find it.
      if (this.mirror.lingeringShips && this.mirror.lingeringShips.size > 0) {
        const ownShipInstanceId = msg.shipInstanceId;
        for (const [shipInstanceId, lEntry] of this.mirror.lingeringShips) {
          const matchesByInstance = ownShipInstanceId !== '' && shipInstanceId === ownShipInstanceId;
          // Only fall back to owner-match when the server sent NO instance id
          // (engineering rooms). With a real id, rescue EXACTLY the welcome's
          // active ship — never a same-player OLD lingering hull the player
          // just displaced (which `matchesByPlayer` used to wrongly grab,
          // seeding the local body at the stale hull's pose + leaving the new
          // ship stuck in lingeringShips — the 2026-06-03 displace bug).
          const matchesByPlayer = ownShipInstanceId === '' && lEntry.ownerPlayerId === msg.playerId;
          if (matchesByInstance || matchesByPlayer) {
            const mirrorEntry: ShipRenderState = {
              x: lEntry.x, y: lEntry.y, vx: lEntry.vx, vy: lEntry.vy, angle: lEntry.angle,
            };
            if (lEntry.kind !== undefined) mirrorEntry.kind = lEntry.kind;
            if (lEntry.displayName !== undefined) mirrorEntry.displayName = lEntry.displayName;
            this.mirror.ships.set(msg.playerId, mirrorEntry);
            this.mirror.lingeringShips.delete(shipInstanceId);
            logEvent('rescued_own_ship_from_lingering', {
              shipInstanceId,
              playerId: msg.playerId,
              x: lEntry.x,
              y: lEntry.y,
            });
            break;
          }
        }
      }

      // If state already arrived, bootstrap the prediction world now.
      this.tryInitPredWorld(msg.playerId);
      // Phase 2 swift-otter — kick off the DC handshake after welcome.
      // The transport's start() is idempotent so a stale call from a
      // pre-welcome retry is safe.
      if (this._webrtcEnabled && this._dataChannelTransport) {
        void this._dataChannelTransport.start();
      }
    });

    // Phase 2/4 swift-otter — instantiate the DataChannel transport
    // SYNCHRONOUSLY before any room handlers so the welcome handler is
    // guaranteed to have a non-null `_dataChannelTransport` when it
    // fires. The first Phase 4 E2E run failed because a dynamic
    // `import('./dataChannelTransport.js')` left the field null past
    // welcome; start() never ran; DC never opened. Static import has
    // no native-binding cost on the client (RTCPeerConnection is a
    // browser global; @colyseus/msgpackr is already in the Colyseus
    // import graph) so the only cost paid by non-opted-in sessions is
    // a few KB of dead JS — acceptable for measurement parity.
    if (this._webrtcEnabled) {
      this._dataChannelTransport = new DataChannelTransport({
        send: (type, payload) => room.send(type, payload),
        onSnapshot: (snap) => {
          // Phase 4 swift-otter — log transport-tagged recv telemetry
          // BEFORE the coalescer enqueue so the measurement reflects DC
          // arrival (not apply). Mirrors the WS-path call above.
          this.logSnapshotRecvTelemetry(snap, 'dc');
          // Mirror the WS-path coalescer behaviour: queue when enabled,
          // otherwise apply immediately. Both paths converge at
          // applySnapshotNow → handleSnapshot.
          if (this.snapshotCoalescer.isEnabled()) {
            this.snapshotCoalescer.enqueue(snap);
          } else {
            this.applySnapshotNow(snap);
          }
        },
        onDiag: (tag, data) => logEvent(tag, data),
      });
    }

    // Signaling handlers are registered regardless of opt-in. The server
    // won't emit these messages to non-opted-in clients (the manager has
    // no entry for them), so the handlers are no-ops in that case.
    room.onMessage('webrtc_answer', (msg: { sdp?: string }) => {
      if (!this._dataChannelTransport || typeof msg?.sdp !== 'string') return;
      void this._dataChannelTransport.handleAnswer(msg.sdp);
    });
    room.onMessage('webrtc_ice', (msg: { candidate?: string; mid?: string }) => {
      if (!this._dataChannelTransport) return;
      if (typeof msg?.candidate !== 'string') return;
      void this._dataChannelTransport.handleIce(msg.candidate, msg.mid ?? '');
    });
    room.onMessage('webrtc_fallback_ack', () => {
      this._dataChannelTransport?.handleFallbackAck();
    });

    room.onMessage('snapshot', (snap: SnapshotMessage) => {
      // Phase 4 swift-otter — transport-tagged recv telemetry.
      // Was inlined here pre-Phase-4; lifted to `logSnapshotRecvTelemetry`
      // so the DC path can call the same code with `via='dc'`. Comparing
      // recv_gap_long between transports is only valid if both paths log
      // identically (modulo the `via` discriminator).
      this.logSnapshotRecvTelemetry(snap, 'ws');

      // Probe 6 — coalesce branch: store pending, defer apply to next
      // tickPhysics. If a prior pending snapshot exists, it's discarded
      // (the newer snap supersedes; snapshots are full-state, not deltas).
      // The discarded count is logged so we can see the burst-collapse
      // happening in captures.
      if (this.snapshotCoalescer.isEnabled()) {
        this.snapshotCoalescer.enqueue(snap);
        return;
      }
      this.applySnapshotNow(snap);
    });

    // Phase 5c: binary swarm channel. Server packs asteroids/drones into a
    // fixed-stride buffer at 60 Hz (delta-encoded; full snapshot every 60th
    // tick). Decoder mutates `mirror.swarm` in place — zero per-frame alloc.
    // After decode we mirror swarm poses into predWorld so the local ship can
    // collide with them and the local hitscan can target them. The body is
    // keyed by `swarm-${entityId}` to avoid colliding with playerIds; the
    // server's `laser_fired` events use the same key for swarm hits.
    room.onMessage('swarm', (raw: unknown) => {
      const bw = bwStats();
      // Drone display-delay cadence (Step 4): EWMA of binary-packet
      // inter-arrival. This is the ACTUAL drone-pose channel the
      // interpolation buffer must cover — in-interest ≈ per server tick
      // (~16 ms), out-of-interest decimated (~100–170 ms) — unlike the
      // steady 20 Hz JSON snapshot. Sample clamped to ≤ 500 ms so one
      // tab-background / radio gap can't pin the EWMA at the ceiling (the
      // JSON drop-detector `dropBias` already biases up on loss bursts).
      const swNowMs = this.clock.now();
      if (this._swarmBinaryLastMs >= 0) {
        const dtMs = Math.min(500, swNowMs - this._swarmBinaryLastMs);
        if (dtMs > 0) {
          this._swarmBinaryEwma = this._swarmBinaryEwma === 0
            ? dtMs
            : this._swarmBinaryEwma * 0.85 + dtMs * 0.15;
        }
      }
      this._swarmBinaryLastMs = swNowMs;
      // Probe 0 (mobile-perf-investigation-review §"Confound the diagnosis
      // did not address"): the binary swarm decode + predWorld sync is the
      // uninstrumented post-pivot dominant per-frame surface. `applyMs`
      // measures only JSON `handleSnapshot`; this path runs separately at
      // ~60 Hz with the kinematic follower writing ~N drone bodies. Wrap
      // with `performance.now()` to feed rolling max/avg into `heap_sample`
      // and to log slow individual packets (> 5 ms) as discrete events.
      const decodeStartMs = performance.now();
      if (raw instanceof ArrayBuffer) {
        if (bw) { bw.swarmBytes += raw.byteLength; bw.swarmPackets += 1; }
        decodeSwarmPacket(raw, this.mirror);
      } else if (ArrayBuffer.isView(raw)) {
        if (bw) { bw.swarmBytes += raw.byteLength; bw.swarmPackets += 1; }
        decodeSwarmPacket(raw, this.mirror);
      }
      this.syncSwarmIntoPredWorld();
      const decodeMs = performance.now() - decodeStartMs;
      this.rafStallDetector.recordSwarmDecode(decodeMs);
      if (decodeMs > 5) {
        logEvent('swarm_decode_slow', {
          decodeMs: parseFloat(decodeMs.toFixed(2)),
          swarmCount: this.mirror.swarm?.size ?? 0,
        });
      }
      // Phase 6 HUD readout. mirror.swarm is the live decoded set; .size is
      // O(1). At decimation-only ticks the count stays steady (no entities
      // come and go), so updating this on every packet is cheap.
      // step 8: dedupe the Zustand dispatch — only call when the count
      // actually changed. Pre-fix this fired every 60 Hz binary packet
      // regardless of whether the value moved; Zustand subscribers
      // allocate per notification.
      this.hudDispatcher.pushSwarmCount(this.mirror.swarm?.size ?? 0);
    });

    // Structures plan, Phase 3 — discrete grid pulse: light the named
    // connection segments for FLASH_DURATION_MS. Stored on the mirror so the
    // (worker) renderer reads them; joined to structure positions by entityId.
    room.onMessage('grid_pulse', (msg: GridPulseEvent) => {
      if (!msg || !Array.isArray(msg.flashed)) return;
      let flashes = this.mirror.gridFlashes;
      if (!flashes) { flashes = new Map(); this.mirror.gridFlashes = flashes; }
      // R2.2 — recover the flow DIRECTION the sorted key throws away (the comet
      // travels source→dest). Sibling map keyed identically; value = the source.
      let flowSrc = this.mirror.gridFlowSrc;
      if (!flowSrc) { flowSrc = new Map(); this.mirror.gridFlowSrc = flowSrc; }
      // R2.2 — keep the edge lit for a FULL pulse period so consecutive 1 Hz
      // pulses read as continuous flow (not a 300 ms blink + 700 ms gap); it
      // fades ~1 s after the flow actually stops being re-stamped.
      const until = this.clock.now() + GRID_PULSE_WINDOW_MS;
      for (const pair of msg.flashed) {
        const a = pair[0];
        const b = pair[1];
        if (typeof a !== 'number' || typeof b !== 'number') continue;
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        const key = lo * 65536 + hi;
        flashes.set(key, until);
        // `a` is the route SOURCE (StructureGridSubsystem.flashRoute pushes
        // [route[i], route[i+1]] in source→dest order; SectorRoom preserves it).
        flowSrc.set(key, a);
      }
    });

    // Click-to-inspect (structures follow-up Item B5) — live stats for the
    // locally-selected entity arrive at ~5 Hz. Defensive zod parse (invariant
    // #3); on success mutate the `selectionStats` module singleton in place (NO
    // Zustand write — the panel polls the singleton ~1 Hz, avoiding 5 Hz React
    // re-renders).
    room.onMessage('entity_stats', (raw: unknown) => {
      const parsed = EntityStatsSchema.safeParse(raw);
      if (!parsed.success) return;
      applySelectionStats(parsed.data);
    });

    room.onMessage('damage', (raw: unknown) => {
      // weapon-hit-prediction Phase 3 — defensive zod parse on receive
      // (invariant #4; mirrors the collision_resolved drop-on-fail). The
      // client now CONSUMES this message for prediction de-dupe, so it
      // crosses the trust boundary.
      const parsed = DamageEventSchema.safeParse(raw);
      if (!parsed.success) return;
      const evt = parsed.data;
      // Single reconcile path: if a prediction already showed this number,
      // suppress handleDamage's duplicate. handleDamage stays the SOLE
      // HP/HUD authority — only the number push is gated.
      // step 8: pooled scratch (was per-event literal).
      this._damageReconcileScratch.targetId = evt.targetId;
      this._damageReconcileScratch.damage = evt.damage;
      const suppressNumber = reconcileDamageToFeedback(
        this._hitLedger,
        this._damageReconcileScratch,
        evt.shooterId === this.mirror.localPlayerId,
        this.clock.now(),
      );
      this.handleDamage(evt, suppressNumber);
    });

    room.onMessage('shield', (evt: ShieldEventMessage) => {
      this.handleShield(evt);
    });

    // Paradigm plan (quirky-rabbit) Phase 6 — server `gc_pause` events
    // feed the rolling 30 s health stats ring; the publisher pushes
    // the aggregate to Zustand at 1 Hz for the DevOverlay.
    //
    // plan: imperative-taco-r2 — also log to client diag so phone-smoke
    // captures can correlate server gc_pause events with client
    // recv_gap_long events. Without this, the phone capture saw 6
    // recv_gap_long events with ZERO local longtask overlap and we
    // had no direct evidence of the server-side root cause.
    room.onMessage('gc_pause', (evt: GcPauseEventMessage) => {
      recordServerGcPause(evt.durationMs);
      logEvent('gc_pause', { durationMs: evt.durationMs, kind: evt.kind });
    });
    room.onMessage('destroy', (evt: DestroyEvent) => {
      this.handleDestroy(evt);
    });

    room.onMessage('hit_ack', (raw: unknown) => {
      // weapon-hit-prediction Phase 3 — defensive zod parse (invariant #4;
      // the client now consumes hit_ack as its single reconcile path, so
      // it crosses the trust boundary). Drop-on-fail like collision_resolved.
      const parsed = HitAckSchema.safeParse(raw);
      if (!parsed.success) return;
      const ack = parsed.data;
      // THE single reconcile path — runs BEFORE ghostManager.resolve so a
      // mispredicted number is hard-cancelled the same frame the ghost
      // fades. resolve() itself is unchanged (still fades the ghost salvo
      // by clientShotId on the wire ack).
      // 2026-05-26 heap-growth gate step 11: pooled scratch instead of
      // a fresh `{hit, targetId, damage}` literal per hit_ack. Same
      // pattern as `_damageReconcileScratch` (step 8) — the consumer
      // (`HitPredictionLedger.reconcileAck`, HitPrediction.ts:142)
      // reads fields synchronously and never retains the reference.
      this._hitAckReconcileScratch.hit = ack.hit;
      this._hitAckReconcileScratch.targetId = ack.targetId;
      this._hitAckReconcileScratch.damage = ack.damage;
      reconcileAckToFeedback(
        this._hitLedger,
        ack.clientShotId,
        this._hitAckReconcileScratch,
        this._reconcileSink,
        this.clock.now(),
      );
      this.ghostManager.resolve(ack.clientShotId, ack.hit);
      if (ack.rejected) {
        // Surface rejection events in the diagnostic ring buffer. The 2026-05-06
        // cooldown-restore bug ("most/all of my shots are rejected") was diagnosed
        // by inference because no fire/hit_ack events were ever logged. Future
        // captures of similar issues should now show the rejection cluster
        // directly.
        logEvent('fireRejected', { clientShotId: ack.clientShotId, hit: ack.hit, targetId: ack.targetId });
        useUIStore.getState().setSectorAlert('shot_rejected');
        setTimeout(() => useUIStore.getState().setSectorAlert(null), 1500);
      }
    });

    room.onMessage('laser_fired', (evt: LaserFiredEvent) => {
      // Own shots are already shown as liveBeams — only store remote ones.
      if (evt.shooterId === this.mirror.localPlayerId) return;
      const dx = evt.toX - evt.fromX;
      const dy = evt.toY - evt.fromY;
      const range = Math.hypot(dx, dy);
      // Upsert: replaces the previous beam from this (shooter, mount) so
      // there is never more than one entry per mount and the TTL resets on
      // each shot. Player beams are HELD weapons (cooldown 167 ms at 60 Hz;
      // TTL 400 ms keeps the visual continuous while space is held).
      //
      // For AI shooters (`swarm-${entityId}`) the iteration we converged on:
      //   - First attempt 400 ms: the beam endpoints were stamped at fire time
      //     and stayed frozen, but the drone moved underneath, so each new
      //     fire teleported the beam origin → "jittery and laggy" (5c smoke).
      //   - Second attempt 80 ms: gave a discrete flash, but cooldown is 167 ms,
      //     so there's an 87 ms gap between flashes → visible flicker.
      //   - Settled: 250 ms TTL (overlaps cooldown by ~83 ms, no gap) AND the
      //     renderer re-derives the beam ORIGIN from `mirror.swarm[entityId]`
      //     each frame so it tracks the moving drone smoothly. Same pattern
      //     player beams use against `mirror.ships[localId]`.
      //
      // Multi-mount/turret refactor (Phase 2c): keyed by (shooterId, mountId).
      // Pre-2c servers omit `mountId`; we synthesise `'forward'` so the entry
      // still has a stable key and legacy single-mount rendering is unchanged.
      const isAiShooter = evt.shooterId.startsWith('swarm-');
      const ttlMs = isAiShooter ? 250 : 400;
      const mountKey = evt.mountId ?? 'forward';
      const lasers = (this.mirror.remoteLasers ??= new Map());
      let perShooter = lasers.get(evt.shooterId);
      if (!perShooter) {
        perShooter = new Map();
        lasers.set(evt.shooterId, perShooter);
      }
      // 2026-05-25 heap-growth gate step 7: pool the per-fire entry.
      // Pre-fix this handler allocated a fresh 8-field object literal
      // per drone fire (~150 allocs/sec under 25-drone combat).
      // Isolation experiment 2026-05-25 showed the 3 message handlers
      // (swarm/damage/laser_fired) drive 0.435 MB/s heap growth +
      // 80% of major-GC stalls. Reusing the entry object per
      // (shooter, mount) is safe — the renderer reads fields
      // synchronously each frame; upsert semantics are preserved.
      const expiresAt = this.clock.now() + ttlMs;
      const existing = perShooter.get(mountKey);
      if (existing) {
        existing.range = range;
        existing.hit = evt.hit;
        existing.targetId = evt.targetId;
        existing.expiresAt = expiresAt;
        existing.fromX = evt.fromX;
        existing.fromY = evt.fromY;
        existing.toX = evt.toX;
        existing.toY = evt.toY;
      } else {
        perShooter.set(mountKey, {
          range,
          hit: evt.hit,
          targetId: evt.targetId,
          expiresAt,
          fromX: evt.fromX,
          fromY: evt.fromY,
          toX: evt.toX,
          toY: evt.toY,
        });
      }
    });

    room.onMessage('respawn_ack', (msg: RespawnAckMessage) => {
      this.handleRespawnAck(msg);
    });

    // Missile launched — pose arrives on the snapshot's missiles[]
    // slice (NOT this event), so we don't seed the mirror here.
    // Defensive zod parse on receive. The discrete event currently has
    // no client-side subscriber (SFX launch-whoosh is a future hookup);
    // the parse + drop keeps the wire safe and ready for that hookup.
    room.onMessage('missile_fired', (raw: unknown) => {
      MissileFiredEventSchema.safeParse(raw);
    });

    // Missile detonated — remove from the mirror so the sprite stops
    // drawing the next frame, and push an explosion entry into the
    // mirror for the renderer to drain (VFX + camera shake).
    room.onMessage('missile_detonated', (raw: unknown) => {
      const result = MissileDetonatedEventSchema.safeParse(raw);
      if (!result.success) return;
      removeMissile(this.mirror, result.data.missileId);
      const list = (this.mirror.pendingMissileExplosions ??= []);
      list.push({
        x: result.data.x,
        y: result.data.y,
        splashRadius: result.data.splashRadius,
        missileId: result.data.missileId,
      });
    });

    // Stage 2 of the network-feel roadmap — server-broadcast collision
    // events. Apply post-collision velocities to predWorld immediately;
    // eliminates the ~50 ms snapshot wait for the same correction.
    // Defensive zod parse on receive: malformed payloads dropped silently
    // (mirrors the server's invariant on inbound messages).
    room.onMessage('collision_resolved', (raw: unknown) => {
      const result = CollisionResolvedMessageSchema.safeParse(raw);
      if (!result.success) return;
      if (!this.predWorld) return;
      const outcome = applyCollisionResolved(
        result.data,
        this.predWorld,
        this._collisionGuard,
        this.clock.now(),
      );
      if (outcome.applied.length > 0) {
        this.stats.collisionEventsApplied++;
      }
    });

    // Remote-warp visual broadcasts. Both `warp_in` (a ship just arrived
    // at this sector) and `warp_out` (a ship just left) push a single
    // entry onto `mirror.pendingWarpEvents` with the world position; the
    // renderer drains the array each frame and fires `triggerWarpIn`
    // (the same direction-agnostic flash + burst ripple) at each one.
    // Local-player events are never reflected here — the server's
    // `except: client` filter excludes the originating connection.
    const handleWarpEvent = (msg: WarpInEvent | WarpOutEvent, kind: 'warp_in' | 'warp_out'): void => {
      // Render-jitter-fix Phase 1b (2026-05-21): log every warp event so
      // we can correlate drone-warp triggers with RAF stalls in the
      // diag capture. PRE-FIX the handler pushed silently into
      // `pendingWarpEvents` and the renderer drained it — invisible to
      // diagnostics. Drone warps (Living World hunter migrations) fire
      // these every few seconds; if the per-event renderer cost is what
      // builds the spiral, each event will line up with the next slow
      // RAF in the trace.
      const arrivalTick = (msg as WarpInEvent).arrivalTick;
      logEvent('warp_event', {
        kind,
        x: Math.round(msg.x * 100) / 100,
        y: Math.round(msg.y * 100) / 100,
        arrivalTick: typeof arrivalTick === 'number' ? arrivalTick : null,
        isLocal: msg.playerId === this.mirror.localPlayerId,
      });
      // Plan: crispy-kazoo, Commit 9 — synchronised arrival, split
      // curtain-drop from warp-in flash.
      //
      // SEQUENCE for the joiner:
      //   T0      receive `warp_in { arrivalTick }`
      //   T0+~150ms (= arrivalTick - 450ms): curtain starts fading
      //                                     (`setArrivalAcked(true)`
      //                                     → useIsLoadingActive → false
      //                                     → useWarpOrchestration calls
      //                                     `renderer.setLoadCurtain(false)`,
      //                                     a 380 ms fade)
      //   T0+~600ms (= arrivalTick):       warp-in flash fires
      //                                     (pendingWarpEvents push;
      //                                     curtain is gone by now)
      //
      // The wall-clock-anchored server-tick estimate is mandatory:
      // `this.inputTick` is stuck at welcome's serverTick because
      // `tickPhysics` is gated by the loading-active pause boundary,
      // so it never advances. Using inputTick as the reference gives
      // a ~5 s wait instead of ~600 ms — the 2026-05-31 smoke bug.
      if (
        kind === 'warp_in'
        && msg.playerId === this.mirror.localPlayerId
        && typeof arrivalTick === 'number'
      ) {
        useUIStore.getState().setArrivalTickFromServer(arrivalTick);
        // Wall-clock-anchored estimate of CURRENT server tick. Welcome
        // gave us a perfect anchor (`serverTickAtWelcome` +
        // `welcomePerfNow`); 60 ticks/sec wall-clock advance keeps the
        // estimate accurate independent of any input-loop gating.
        const wallClockMsSinceWelcome = this.clock.now() - this.welcomePerfNow;
        const serverTickEstimate =
          this.serverTickAtWelcome + Math.floor(wallClockMsSinceWelcome * 60 / 1000);
        const ticksUntilArrival = Math.max(0, arrivalTick - serverTickEstimate);
        const msUntilArrival = ticksUntilArrival * (1000 / 60);
        // 450 ms before arrival → curtain fade-out starts (380 ms fade
        // + 70 ms slack to ensure it's fully gone before the flash).
        const CURTAIN_LEAD_MS = 450;
        const msUntilCurtainDrop = Math.max(0, msUntilArrival - CURTAIN_LEAD_MS);
        setTimeout(() => {
          if (this.disposed) return;
          useUIStore.getState().setArrivalAcked(true);
          logEvent('arrival_acked', {
            arrivalTick,
            msUntilCurtainDrop: Math.round(msUntilCurtainDrop),
            msUntilArrival: Math.round(msUntilArrival),
          });
        }, msUntilCurtainDrop);
        setTimeout(() => {
          if (this.disposed) return;
          this.mirror.pendingWarpEvents?.push({ x: msg.x, y: msg.y });
          logEvent('warp_in_flash_fired', { arrivalTick });
        }, msUntilArrival);
        return;
      }
      // Remote warp event: push immediately (legacy path).
      if (!this.mirror.pendingWarpEvents) return;
      this.mirror.pendingWarpEvents.push({ x: msg.x, y: msg.y });
    };
    room.onMessage('warp_in', (msg) => handleWarpEvent(msg, 'warp_in'));
    room.onMessage('warp_out', (msg) => handleWarpEvent(msg, 'warp_out'));

    // Wave-system Phase 5 — sector-wide warp-in warning HUD. Drives visible UI,
    // so we zod-validate + drop malformed packets (invariant #3) — a bad
    // count/countdownMs would render a garbage banner. Purity-clean: no
    // positions reach Zustand (invariant #2).
    room.onMessage('warp_warning', (raw: unknown) => {
      const parsed = WarpWarningSchema.safeParse(raw);
      if (!parsed.success) return;
      const { id, label, count, countdownMs } = parsed.data;
      useUIStore.getState().addWarpWarning({ id, label, count, countdownMs });
    });
    room.onMessage('warp_warning_clear', (raw: unknown) => {
      const parsed = WarpWarningClearSchema.safeParse(raw);
      if (!parsed.success) return;
      useUIStore.getState().removeWarpWarning(parsed.data.id);
    });

    // Living World — server→client twin of the damage→markHostile mirror.
    // When the director makes a bot proactively hostile to a player, the
    // server marks its own HostileDroneBehaviour AND broadcasts this; the
    // client feeds it into ITS predicted AiController so the in-interest
    // drone's predicted brain matches the authoritative one (no
    // swarm-wire bump — the existing, proven hostility channel). The
    // client AiController is keyed on the bare numeric entity id (see the
    // damage handler), so strip the `swarm-` prefix exactly as that path
    // does. A dropped packet self-heals on the next director re-mark.
    room.onMessage('bot_aggro', (evt: BotAggroEvent) => {
      if (!evt.botEntityId.startsWith('swarm-') || !evt.targetPlayerId) return;
      const numeric = evt.botEntityId.slice('swarm-'.length);
      this._aiController.markHostile(numeric, evt.targetPlayerId, this.inputTick);
    });

    // Phase 8 sub-phase B — transit lifecycle messages.
    room.onMessage('transit_state', (msg: TransitStateMessage) => {
      const ui = useUIStore.getState();
      ui.setTransitState(msg.state);
      // F-transit-instrument — one mark per transit_state transition.
      // `setTransitState(msg.state)` above runs unconditionally before
      // the per-state branch, so this single site captures SPOOLING /
      // IN_TRANSIT / DOCKED / ARRIVED. Gated/no-op when diag is off.
      this.transitInstr.mark(`state:${msg.state}`, {
        ...(msg.targetSectorKey !== undefined ? { target: msg.targetSectorKey } : {}),
        ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
      });
      if (msg.targetSectorKey !== undefined) ui.setTransitTargetSectorKey(msg.targetSectorKey);
      if (msg.state === 'SPOOLING') {
        ui.setTransitProgress(0);
        const start = this.clock.now();
        const dur = msg.spoolMs ?? SPOOL_DURATION_MS;
        ui.setTransitSpoolMs(dur);
        // Surface the destination once via the alert toast — the new
        // left-edge hyperspace bar is too narrow to carry the sector name,
        // and the player picked the destination on the map seconds ago, so
        // a brief reminder beats permanent overlay text.
        if (msg.targetSectorKey) {
          const dest = getSector(msg.targetSectorKey);
          ui.setSectorAlert(`Spooling to ${dest?.name ?? msg.targetSectorKey}`);
          setTimeout(() => {
            const cur = useUIStore.getState();
            // Only clear if still ours — don't clobber a later cancellation toast.
            if (cur.sectorAlert?.startsWith('Spooling to')) cur.setSectorAlert(null);
          }, 1800);
        }
        const ramp = (): void => {
          const elapsed = this.clock.now() - start;
          const cur = useUIStore.getState();
          // Ramp only while still SPOOLING — bail if cancelled or committed.
          if (cur.transitState !== 'SPOOLING') return;
          if (elapsed >= dur) {
            cur.setTransitProgress(1);
            return;
          }
          cur.setTransitProgress(elapsed / dur);
          requestAnimationFrame(ramp);
        };
        requestAnimationFrame(ramp);
      } else if (msg.state === 'DOCKED') {
        // Cancellation path. Surface the reason briefly.
        ui.setTransitProgress(0);
        ui.setTransitTargetSectorKey(null);
        ui.setTransitSpoolMs(null);
        if (msg.reason) {
          ui.setSectorAlert(`transit cancelled: ${msg.reason}`);
          setTimeout(() => useUIStore.getState().setSectorAlert(null), 2000);
        }
      } else if (msg.state === 'ARRIVED') {
        // Brief fade then back to DOCKED so the overlay clears.
        ui.setTransitProgress(1);
        ui.setTransitSpoolMs(null);
        setTimeout(() => {
          const cur = useUIStore.getState();
          cur.setTransitState('DOCKED');
          cur.setTransitProgress(0);
          cur.setTransitTargetSectorKey(null);
        }, 500);
      }
    });

    room.onMessage('transit_ready', async (msg: { reservation: unknown; targetSectorKey: string }) => {
      // CRITICAL — leave the source room BEFORE consuming the destination
      // reservation. `client.consumeSeatReservation` opens a NEW WS without
      // touching the existing one, so without an explicit `room.leave()` the
      // client ends up with two simultaneous connections, both streaming
      // `snapshot` / `swarm` / `damage` etc. into the shared `this.mirror`.
      // The visible result is the player rendered in both sectors at once.
      // (The source onLeave's existing `transitState` early-return correctly
      // suppresses the disconnected-status flicker during this window.)
      // F-transit-instrument — bracket the source-room leave. `stepMs`
      // on `leave_room:end` is its own duration.
      this.transitInstr.mark('leave_room:begin');
      try {
        await room.leave(true /* consented */);
      } catch (err) {
        logEvent('cc_transit_leave_failed', { err: String(err) });
      }
      this.transitInstr.mark('leave_room:end');

      // Wipe Stage 4 prediction-loop state so the destination sector's first
      // snapshot is treated like a fresh-connect seed. Without this, the
      // 5+ s transit gap pollutes the surviving welford RTT stream and the
      // client over-predicts ~600 ms ahead of authoritative state for
      // tens of seconds post-arrival. See `resetPredictionState()` for the
      // full pathology and the diagnostic captures that motivated the fix.
      // F-transit-instrument — bracket resetPredictionState; `stepMs`
      // on `pred_reset:end` is its duration.
      this.transitInstr.mark('pred_reset:begin');
      this.resetPredictionState();
      this.transitInstr.mark('pred_reset:end');

      // Effects subsystem (M9 plan wiggly-puppy): wipe per-entity
      // emitters + in-flight bursts + shield rings so the destination
      // sector starts with a clean effects pool. Sibling line to
      // resetPredictionState + rearmJoinReadiness — separate per SRP
      // (each method owns its zone's state).
      callbacks.onSectorHandoff?.();

      // Phase G — UI-readiness analogue of the spatial reseed above.
      // A pure inter-sector transit keeps `phase==='game'`, so
      // `setPhase` never re-arms the WarpScreen readiness flags / the
      // 5 s minimum-display floor (`setPhase`'s comment claimed it did
      // — it never fired for pure transit; same defect class as the
      // 7829d04 resetPredictionState "fresh-connect seed"). Re-arm them
      // here, exactly as a fresh connect would, so the destination's
      // first snapshot + the re-armed floor mask the post-reseed
      // reconcile settle, AND so `!gameReady` raises the load curtain
      // NOW (before the IN_TRANSIT spool-exit burst) — that ordering is
      // what collapses the "double arrival flash" to a single masked
      // hand-off. One ownership site; sibling to `resetPredictionState`
      // (NOT folded into it — that method is src/client/net prediction
      // state; SRP).
      useUIStore.getState().rearmJoinReadiness();

      // Wipe stale spatial state from the source sector. Without this, the old
      // sector's asteroids/drones (and remote ships) linger in the mirror at
      // their last-shipped world positions until the destination's first FULL
      // swarm snapshot reconciles them (~1 s) — long enough for the player to
      // see ghost entities sitting static across the new sector.
      this.mirror.swarm?.clear();
      this.mirror.projectiles?.clear();
      this.mirror.damagedShips?.clear();
      this.mirror.explodingShips?.clear();
      this.mirror.boostingShips?.clear();
      this.mirror.thrustingShips?.clear();
      this.mirror.remoteLasers?.clear();
      this.mirror.liveBeams?.clear();
      this.mirror.serverGhostPos = null;
      // Drop remote ships; the local entry is preserved so predWorld keeps
      // simulating until the destination's state patch arrives.
      const preservedLocal = this.mirror.localPlayerId;
      for (const id of [...this.mirror.ships.keys()]) {
        if (id !== preservedLocal) {
          this.mirror.ships.delete(id);
          this.remoteHistory.delete(id);
          if (this.predRemoteShipIds.has(id)) {
            this.predWorld?.despawnShip(id);
            this.predRemoteShipIds.delete(id);
            this._remoteShipOffsets.delete(id);
          }
        }
      }

      try {
        // F-transit-instrument — bracket the destination seat consume
        // (opens the new WS). `join_room` `stepMs` is the consume cost.
        this.transitInstr.mark('seat_consume');
        const newRoom = await client.consumeSeatReservation<unknown>(msg.reservation as never);
        this.room = newRoom;
        bindRoomHandlers(newRoom);
        this.transitInstr.mark('join_room');
        // Arm the destination-room one-shots NOW (handlers just bound
        // on `newRoom`). Until this, `markOnce` is inert, so the source
        // room's still-live `onStateChange` / `snapshot` handlers
        // (firing through spool) cannot steal `first_state` /
        // `first_snapshot` — they'll capture the destination's first.
        this.transitInstr.arm('first_state');
        this.transitInstr.arm('first_snapshot');
        // Server's onJoin will send a `welcome` setting currentSectorKey;
        // it'll also send `transit_state ARRIVED` once the destination
        // orchestrator marks the player landed (this path only fires on
        // the pre-consume edge — see server commitTransit). Defensive
        // fallback: if no ARRIVED arrives within 2 s, clear the overlay
        // ourselves so the player isn't stuck looking at warp-streaks.
        setTimeout(() => {
          const cur = useUIStore.getState();
          if (cur.transitState === 'IN_TRANSIT') {
            cur.setTransitState('ARRIVED');
            setTimeout(() => {
              const c2 = useUIStore.getState();
              c2.setTransitState('DOCKED');
              c2.setTransitProgress(0);
              c2.setTransitTargetSectorKey(null);
            }, 500);
          }
        }, 2000);
      } catch (err) {
        logEvent('cc_seat_reservation_failed', { err: String(err) });
        const ui = useUIStore.getState();
        ui.setTransitState('DOCKED');
        ui.setTransitProgress(0);
        ui.setTransitTargetSectorKey(null);
        ui.setSectorAlert('transit failed');
        setTimeout(() => useUIStore.getState().setSectorAlert(null), 2000);
      }
    });

    room.onStateChange((state: unknown) => {
      this.transitInstr.markOnce('first_state');
      // Phase 4 iteration 3 swift-otter HYBRID (2026-05-30):
      // First onStateChange per RAF runs inline; subsequent deferred.
      // Restored after investigation: full-defer reproduces maxDrift
      // regression ONLY in the netgate proxy environment (per-byte
      // TCP jitter); CDP-emulated latency + oscillation showed
      // maxDrift 0.351 under same gameplay. The proxy's specific
      // jitter pattern triggers something we couldn't localise without
      // proxy-level instrumentation. Hybrid is netgate-PASS-true
      // baseline.
      if (this._syncMirrorRanThisRaf) {
        this._pendingStateForSync = state;
      } else {
        this._syncMirrorRanThisRaf = true;
        this.syncMirror(state);
      }
    });

    room.onLeave((code) => {
      logEvent('cc_left_room', { code });
      logEvent('disconnected', { code });
      // Phase 2 swift-otter — close the DataChannel on every onLeave.
      // Sector handoffs short-circuit below, so the transport teardown
      // there is `resetPredictionState` (called by the transit-arrival
      // path); this is the non-transit disconnect path.
      const cur = useUIStore.getState();
      if (cur.transitState !== 'IN_TRANSIT' && cur.transitState !== 'SPOOLING') {
        if (this._dataChannelTransport) {
          this._dataChannelTransport.close('room-leave');
          this._dataChannelTransport = null;
        }
      }
      // During transit `consumeSeatReservation` we'll see an onLeave on the
      // source room as the WS is replaced. Don't flip status to disconnected
      // when a transit is mid-flight — the destination is already being
      // bound. The post-consume rebind sets connected status implicitly via
      // the new room's flow.
      if (cur.transitState === 'IN_TRANSIT' || cur.transitState === 'SPOOLING') return;
      callbacks.onConnectionStatus('disconnected');
      this.keyboard = null;
      this.touchInput = null;
    });

    room.onError((code, message) => {
      logEvent('cc_room_error', { code, message });
      logEvent('room_error', { code, message });
      callbacks.onConnectionStatus('error');
    });
    };

    bindRoomHandlers(this.room);

    callbacks.onConnectionStatus('connected');
    logEvent('cc_connected', {});
    this.keyboard = keyboard;
    this.touchInput = touchInput ?? null;
  }

  // ── Combat event handlers ────────────────────────────────────────────────

  /**
   * Discrete shield-state transition (Phase 3b). Sets the local
   * shieldPct anchor; the HUD bar tweens between anchors via CSS. On
   * 'restored' the local predWorld collider swaps back to the cheap
   * circle (authoritative; client never computes the 0-cross).
   */
  private handleShield(evt: ShieldEventMessage): void {
    // M8 (plan wiggly-puppy): handleShield ONLY receives 'restored' /
    // 'regen_complete' events (never 'broken' — the 0-cross is carried
    // by DamageEvent.newShield=0 and handled in handleDamage). So any
    // event here means the shield is back UP. Mirror the bit for ANY
    // target so the shield aura updates remote ships too.
    const targetEntry = this.mirror.ships.get(evt.targetId);
    if (targetEntry && targetEntry.shieldDown !== false) {
      targetEntry.shieldDown = false;
    }

    if (evt.targetId !== this.mirror.localPlayerId) return;
    const pct = evt.shieldMax > 0 ? Math.round((evt.shield / evt.shieldMax) * 100) : 0;
    // step 10: stash for the 1Hz dispatcher; CSS bar animates between.
    this.hudDispatcher.stashShield(pct);
    if (evt.phase === 'restored' && this.predWorld?.hasShip(evt.targetId)) {
      this.predWorld.setHullExposed(evt.targetId, false, getShipKind(this.mirror.ships.get(evt.targetId)?.kind ?? null));
    }
  }

  private handleDamage(evt: DamageEvent, suppressNumber = false): void {
    const localId = this.mirror.localPlayerId;
    if (evt.targetId === localId) {
      // Phase 7 — use the event-provided PER-KIND maxes, not the global
      // SHIP_MAX_HEALTH constant (the latent bug: a kind whose maxHealth
      // != 500 rendered a wrong %). newHealth is the HULL value.
      const hullPct = evt.hullMax > 0 ? Math.round((evt.newHealth / evt.hullMax) * 100) : 0;
      const shPct = evt.shieldMax > 0 ? Math.round((evt.newShield / evt.shieldMax) * 100) : 0;
      // step 10: just stash the latest target value; the 1Hz dispatcher
      // in updateMirror() pushes to Zustand. Bar's 1s CSS transition
      // animates smoothly between samples.
      this.hudDispatcher.stashHull(hullPct);
      this.hudDispatcher.stashShield(shPct);
      // Authoritative shield break -> mirror the collider swap into the
      // local predWorld so client hit/ramming prediction matches the
      // server. The client NEVER computes the 0-cross (reacts to the
      // authoritative event only — no predict-flap).
      if (evt.newShield === 0 && this.predWorld?.hasShip(localId)) {
        this.predWorld.setHullExposed(localId, true, getShipKind(this.mirror.ships.get(localId)?.kind ?? null));
      }
    }
    // Flash the damaged ship for 6 frames.
    this._damageFlashFrames.set(evt.targetId, 6);

    // Floating damage number at hit location. weapon-hit-prediction
    // Phase 3 — suppressed when a confirmed/settled prediction already
    // showed this number (de-dupe: exactly one number per confirmed hit).
    // Everything else in handleDamage stays unconditional — this remains
    // the SOLE HP/HUD/flash/healthbar/hostility authority.
    if (!suppressNumber && this.mirror.pendingDamageNumbers) {
      const targetShip = this.mirror.ships.get(evt.targetId);
      const x = evt.hitX ?? targetShip?.x ?? 0;
      const y = evt.hitY ?? targetShip?.y ?? 0;
      this.mirror.pendingDamageNumbers.push({ targetId: evt.targetId, x, y, damage: evt.damage });
    }

    // Health bar on hit — only show for targets the local player is shooting.
    // Push BOTH hull% AND shield% so HealthBarManager can render a
    // two-segment bar. Without the shield half, shield damage on drones
    // looks like zero damage: the hull bar stays at 100% while shield
    // absorbs (no-spillover) the first N hits, and drones have no other
    // shield-feedback surface (only player ships have a HUD ShieldHullBar).
    if (evt.shooterId === localId && this.mirror.pendingHealthBarHits) {
      const healthPct = evt.hullMax > 0 ? Math.max(0, evt.newHealth / evt.hullMax) : 0;
      const shieldPct = evt.shieldMax > 0 ? Math.max(0, evt.newShield / evt.shieldMax) : 0;
      this.mirror.pendingHealthBarHits.push({ entityId: evt.targetId, healthPct, shieldPct });
    }

    // Impact sparks — visual-effects subsystem M7 (plan wiggly-puppy).
    // Push to the pending queue; the renderer drains it inside update()
    // on shouldRender frames (perFrameTriggers gate). Authoritative-only
    // on first pass per the plan's asymmetry with damage numbers
    // (predicted hits get the number immediately but sparks follow the
    // server's DamageEvent — RTT/2 lag is acceptable for the decorative
    // spark vs the load-bearing damage number).
    if (this.mirror.pendingEffectTriggers) {
      const targetShipForFallback = this.mirror.ships.get(evt.targetId);
      const sparkX = evt.hitX ?? targetShipForFallback?.x ?? 0;
      const sparkY = evt.hitY ?? targetShipForFallback?.y ?? 0;
      const tint = evt.hitLayer === 'shield' ? 0x88ddff : 0xff8844;
      this.mirror.pendingEffectTriggers.push({
        kind: 'impact',
        worldX: sparkX,
        worldY: sparkY,
        tint,
        entityId: evt.targetId, // for shield-ring pulse on shield-layer hits
      });
    }

    // Shield-layer hit → flag the target's shield-down state in the
    // mirror (M8 wiggly-puppy). The handleShield event is local-only
    // (line 1479 returns when targetId !== localPlayerId), but every
    // DamageEvent carries `newShield` for every target — so this is the
    // single ownership site for ALL ships' shieldDown bit. The
    // shieldDown=false case (regen back above 0) lands in handleShield
    // for the local player; remote players' regen ramps don't broadcast,
    // so a remote ship's ring will linger UP until its next DamageEvent
    // — accepted limitation, documented in src/client/CLAUDE.md Effects
    // section.
    const targetEntry = this.mirror.ships.get(evt.targetId);
    if (targetEntry) {
      const wasDown = targetEntry.shieldDown === true;
      const isDown = evt.newShield <= 0;
      if (isDown !== wasDown) targetEntry.shieldDown = isDown;
    }

    // Phase 1 AI: mirror the server's hostility-marking on every damage
    // event for swarm targets. Server fires the same call from its own
    // `applyDamage`. Both sides receive identical events so each drone's
    // per-instance `hostileTo` set converges without a wire-format bump.
    // Client AI controller is keyed on the bare numeric id (see register
    // call `\`${entityId}\``), so strip the `swarm-` prefix here.
    if (evt.targetId.startsWith('swarm-') && evt.shooterId) {
      const numeric = evt.targetId.slice('swarm-'.length);
      this._aiController.markHostile(numeric, evt.shooterId, this.inputTick);
    }
  }

  /**
   * Single authoritative path for removing any entity from the simulation.
   * Called immediately on destroy event for both local and remote ships.
   * syncMirror acts as a defensive fallback only.
   */
  private killEntity(id: string): void {
    // Trigger explosion sprite on this frame (renderer consumes then App.tsx clears).
    this.mirror.explodingShips?.add(id);

    // Immediately remove physics body so hitscan and collisions cannot hit it.
    this.predWorld?.despawnShip(id);

    // Remove from render mirror so the sprite is culled this frame.
    this.mirror.ships.delete(id);

    if (id === this.mirror.localPlayerId) {
      this.localDead = true;
      this.diedAtMs = this.clock.now();
      // Plan: crispy-kazoo, Commit 3 — death is the cascade trigger.
      // Pre-Commit 3 the capture lifecycle.ndjson had ZERO local_died
      // events; we reconstructed death from indirect breadcrumbs
      // (GalaxyOverviewScreen mount in 'spawn' mode). This event lets
      // future captures measure death-to-respawn directly.
      const msSinceWelcome = this.welcomePerfNow > 0
        ? Math.round(this.diedAtMs - this.welcomePerfNow)
        : -1;
      logEvent('local_died', { playerId: id, msSinceWelcome });
      this.mirror.liveBeams?.clear();
      this._localSlotTarget = null;
      this.ghostManager.clearForShip(id);
      useUIStore.getState().setHullPct(0);
      useUIStore.getState().setDead(true);
      useUIStore.getState().setSectorAlert('SHIP DESTROYED');
      setTimeout(() => useUIStore.getState().setSectorAlert(null), 3000);
    } else {
      this.predRemoteShipIds.delete(id);
      this.remoteHistory.delete(id);
      this._remoteShipOffsets.delete(id);
    }
  }

  private handleDestroy(evt: DestroyEvent): void {
    if (evt.targetId.startsWith('swarm-')) {
      this.killSwarmEntity(evt.targetId);
      return;
    }
    this.killEntity(evt.targetId);
  }

  /**
   * Remove a swarm entity (drone) immediately on a destroy event. Sweeps the
   * mirror entry, the predWorld body, and the damage-flash tracker. The next
   * binary swarm packet will confirm the entity is gone (delta packets won't
   * mention it; the next 60-tick full snapshot will sweep on the server's say-so).
   */
  private killSwarmEntity(wireId: string): void {
    const entityIdStr = wireId.slice('swarm-'.length);
    const entityId = parseInt(entityIdStr, 10);
    if (Number.isNaN(entityId)) return;
    this.mirror.swarm?.delete(entityId);
    if (this.predWorld?.hasShip(wireId)) this.predWorld.despawnShip(wireId);
    this.predSwarmKeys.delete(wireId);
    this._damageFlashFrames.delete(wireId);
    // Reuse the explosion sprite path — the renderer keys explosions off
    // sprite position (looked up by id), and `swarm-${entityId}` is the
    // sprite key, so the existing explosion machinery just works.
    this.mirror.explodingShips?.add(wireId);
    useUIStore.getState().setSwarmCount(this.mirror.swarm?.size ?? 0);
  }

  private handleRespawnAck(msg: RespawnAckMessage): void {
    const playerId = this.mirror.localPlayerId;
    if (!playerId || !this.predWorld) return;

    // Spawn new physics body at server-assigned position.
    this.predWorld.spawnShip(playerId, msg.x, msg.y);

    // Re-initialise reconciler so it doesn't try to replay inputs from before death.
    this.reconciler = new Reconciler(this.predWorld, playerId, this.clock);

    // Sync input tick to server tick so first fire passes temporal plausibility,
    // and re-anchor the clock so tickPhysics()'s `targetTick` derivation stays
    // consistent with the new tick base.
    this.inputTick = msg.serverTick;
    this.serverTickAtWelcome = msg.serverTick;
    this.welcomePerfNow = this.clock.now();
    this.clockAnchorServerTick = msg.serverTick;
    this.clockAnchorPerfNow = this.welcomePerfNow;
    this._anchorInitialised = true;
    // Reset the idle-input throttle so the first post-respawn input always sends.
    this.lastSentInputState = null;
    this.lastSentInputAtMs = 0;

    // Bootstrap mirror so the renderer shows the ship immediately (before next syncMirror).
    this.mirror.ships.set(playerId, { x: msg.x, y: msg.y, vx: 0, vy: 0, angle: 0 });

    this.localDead = false;
    useUIStore.getState().setDead(false);
    useUIStore.getState().setHullPct(100);
    useUIStore.getState().setSectorAlert(null);

    logEvent('cc_respawned', { x: msg.x, y: msg.y });
  }

  /** Send a respawn request to the server. Only valid while the local ship is dead. */
  respawnShip(): void {
    if (!this.room || !this.localDead) return;
    this.room.send('respawn', { type: 'respawn' });
  }

  /**
   * Plan: crispy-kazoo, Commit 2 — synchronised warp-in handshake.
   *
   * Tells the server "I have finished bootstrapping; please activate
   * my ship and broadcast the warp-in". Idempotent: a second call
   * (e.g. from the per-RAF trigger in gameRafLoop after the first
   * fire) is a no-op. The Zustand `clientReadySent` flag flips here
   * so future callers also short-circuit.
   *
   * Called from the per-RAF check in `gameRafLoop` once all
   * bootstrap gates pass (`computeBootstrapReadyFromState === true`).
   */
  sendClientReady(): void {
    if (!this.room || this.disposed) return;
    const state = useUIStore.getState();
    if (state.clientReadySent) return;
    state.setClientReadySent(true);
    this.room.send('client_ready', { type: 'client_ready' });
    const msSinceWelcome = this.welcomePerfNow > 0
      ? Math.round(this.clock.now() - this.welcomePerfNow)
      : -1;
    logEvent('client_ready_sent', { msSinceWelcome });
  }

  // ── Prediction bootstrap ────────────────────────────────────────────────

  private tryInitPredWorld(playerId: string): void {
    if (!this.predWorld || this.predWorld.hasShip(playerId)) return;
    const existing = this.mirror.ships.get(playerId);
    if (!existing) {
      // Telemetry: tryInitPredWorld was called but the local ship's
      // mirror entry isn't ready yet. Common during the 1-tick window
      // between welcome and the first state-diff for the local ship.
      logEvent('predworld_init_deferred', { playerId, reason: 'no-mirror-entry' });
      return;
    }
    this.predWorld.spawnShip(playerId, existing.x, existing.y, existing.kind);
    this.predWorld.setShipState(playerId, existing);
    this.reconciler = new Reconciler(this.predWorld, playerId, this.clock);
    logEvent('predworld_init', {
      playerId,
      x: existing.x, y: existing.y, kind: existing.kind ?? null,
    });
    // Join-render diagnostic: this is the moment the local ship's
    // pose is observable in the mirror at server-authoritative coords.
    // Fire ONCE per (re)connect — `resetPredictionState` resets the latch.
    if (!this._localPoseResolvedLogged) {
      this._localPoseResolvedLogged = true;
      const msSinceWelcome = this.welcomePerfNow > 0
        ? Math.round(this.clock.now() - this.welcomePerfNow)
        : -1;
      logEvent('local_pose_resolved', {
        playerId,
        x: existing.x,
        y: existing.y,
        kind: existing.kind ?? null,
        msSinceWelcome,
      });
    }
    // Plan: crispy-kazoo, Commit 2 — surface the localPoseResolved
    // gate to Zustand so `computeBootstrapReadyFromState` flips true
    // when the predWorld + reconciler are live. Idempotent; the
    // setter is a no-op if already true.
    useUIStore.getState().setLocalPoseResolved(true);
    logEvent('cc_predworld_init', { x: existing.x, y: existing.y });
    // Retrospectively spawn any remote ships that arrived in the initial Colyseus
    // state patch (before localId was set, so syncMirror skipped predWorld spawn).
    for (const [id, state] of this.mirror.ships) {
      if (id === playerId) continue;
      if (this.predWorld.hasShip(id) || this.predRemoteShipIds.has(id)) continue;
      this.predWorld.spawnShip(id, state.x, state.y, state.kind);
      this.predWorld.setShipState(id, state);
      this.predRemoteShipIds.add(id);
    }
    // Likewise for swarm entries: a binary `swarm` packet may have arrived
    // before predWorld existed; bring those bodies up now.
    this.syncSwarmIntoPredWorld();
  }

  // ── Snapshot / reconciliation ───────────────────────────────────────────

  /**
   * Probe 6 — extracted apply path. Wraps `handleSnapshot` with the
   * bandwidth + applyMs instrumentation that used to live inline in
   * the onMessage handler. Called either:
   *   - Immediately in onMessage when `?coalesce=0` (legacy mode), or
   *   - From `processPendingSnapshot()` at the top of tickPhysics
   *     (default coalesced mode).
   */
  /**
   * Phase 4 swift-otter — transport-aware recv telemetry. Called from BOTH
   * the WS `room.onMessage('snapshot', ...)` handler AND the DataChannel
   * transport's onSnapshot callback BEFORE the coalescer enqueue, so the
   * measurement counts arrival not apply. Was inlined in the WS handler
   * pre-Phase-4 — moving it here was the fix for the "DC arm shows fewer
   * snapshot_received events" measurement bug surfaced by the first
   * Phase 4 E2E run.
   *
   * The `via` field distinguishes which transport delivered the frame;
   * the test code uses it to gate on dc-route fraction.
   */
  private logSnapshotRecvTelemetry(snap: SnapshotMessage, via: 'ws' | 'dc'): void {
    const recvAtMs = this.clock.now();
    const recvGapMs = this._lastSnapshotRecvAtMs >= 0
      ? recvAtMs - this._lastSnapshotRecvAtMs
      : -1;
    this._lastSnapshotRecvAtMs = recvAtMs;
    const serverSendPerfNow = (snap as { serverSendPerfNow?: number }).serverSendPerfNow;
    const wsBufferedAmountBytes = (snap as { wsBufferedAmountBytes?: number }).wsBufferedAmountBytes;
    logEvent('snapshot_received', {
      serverTick: snap.serverTick,
      via,
      recvGapMs: recvGapMs >= 0 ? Math.round(recvGapMs * 100) / 100 : -1,
      serverSendPerfNow: typeof serverSendPerfNow === 'number'
        ? Math.round(serverSendPerfNow * 100) / 100
        : null,
      clientRecvPerfNow: Math.round(recvAtMs * 100) / 100,
      wsBufferedAmountBytes: typeof wsBufferedAmountBytes === 'number' ? wsBufferedAmountBytes : null,
    });
    if (recvGapMs > 200) {
      const heap = readHeapUsedMb();
      const serverToClientDeltaMs = typeof serverSendPerfNow === 'number'
        ? Math.round((recvAtMs - serverSendPerfNow) * 100) / 100
        : null;
      logEvent('recv_gap_long', {
        via,
        recvGapMs: Math.round(recvGapMs * 100) / 100,
        heapUsedMb: heap !== undefined ? parseFloat(heap.toFixed(2)) : null,
        serverSendPerfNow: typeof serverSendPerfNow === 'number'
          ? Math.round(serverSendPerfNow * 100) / 100
          : null,
        clientRecvPerfNow: Math.round(recvAtMs * 100) / 100,
        serverToClientDeltaMs,
        wsBufferedAmountBytes: typeof wsBufferedAmountBytes === 'number' ? wsBufferedAmountBytes : null,
      });
    }
  }

  private applySnapshotNow(snap: SnapshotMessage): void {
    const bw = bwStats();
    const snapJson = bw ? JSON.stringify(snap) : null;
    if (bw && snapJson) {
      bw.snapshotBytes += snapJson.length;
      bw.snapshotCount += 1;
    }
    const applyStart = this.clock.now();
    this.handleSnapshot(snap);
    const applyMs = this.clock.now() - applyStart;
    logEvent('snapshot_applied', {
      serverTick: snap.serverTick,
      applyMs: Math.round(applyMs * 100) / 100,
      reconcileMs: this._lastReconcileMs >= 0 ? Math.round(this._lastReconcileMs * 100) / 100 : -1,
      replayWindow: this._lastReplayWindow,
      snapBytes: snapJson ? snapJson.length : -1,
      // Phase 4 iteration 3 swift-otter maxDrift investigation (2026-05-30) —
      // per-snapshot drift + timing context. Lets us correlate big drift
      // events with snapshot indices / ticksAhead / replay windows.
      driftUnits: this.stats.driftUnits,
      ticksAhead: this.stats.ticksAhead,
      snapshotIndex: this.stats.snapshotCount,
    });
  }

  /**
   * Probe 6 — drain the coalesced-pending snapshot. Called once at the
   * top of `tickPhysics()` per RAF. If the WebSocket has queued multiple
   * snapshots since the last RAF (e.g., during a 500 ms GC pause), all
   * but the newest were discarded in the `onMessage` handler; only the
   * newest is processed here.
   *
   * Logs `snapshot_coalesced` when one or more snapshots were discarded
   * in the burst so captures show how often the burst-collapse fires.
   * The event includes `dropped` (count discarded) and `newestServerTick`.
   *
   * No-op when `?coalesce=0`.
   */
  processPendingSnapshot(): void {
    this.snapshotCoalescer.drain((snap) => this.applySnapshotNow(snap));
  }

  private handleSnapshot(snap: SnapshotMessage): void {
    const localId = this.mirror.localPlayerId;
    const now = this.clock.now();

    // Join-render readiness signal: the FIRST snapshot tick after a
    // (re)connect is when the reconciler/predWorld pipeline is fully
    // primed and the renderer can start drawing authoritative state.
    // Flag is reset by `setPhase('game')` for the next room. Only
    // flips when we know who we are (skip the initial state patch that
    // arrives before welcome).
    if (localId !== null && !useUIStore.getState().firstSnapshotApplied) {
      useUIStore.getState().setFirstSnapshotApplied(true);
      // Plan: crispy-kazoo, Commit 3 — first-snapshot edge log lets a
      // diag capture pinpoint when the join's bootstrap reaches the
      // "I have the world state" gate. Fires exactly once per
      // (re)connect — `commonReadinessRearm` flips the flag back on
      // every phase change / transit.
      const msSinceWelcome = this.welcomePerfNow > 0
        ? Math.round(this.clock.now() - this.welcomePerfNow)
        : -1;
      logEvent('respawn_first_snapshot', { msSinceWelcome });
    }

    // Phase 6a / 6b — translate the shipInstanceId-keyed wire format
    // to a playerId-keyed local view + route inactive (lingering)
    // hulls to mirror.lingeringShips. See snapshotShipRouter.ts.
    // Ctx pooled to `this._routeSnapshotShipStatesCtx` (heap-growth
    // gate step 12). `predWorld` is the only volatile field — mutate
    // before the call. Other fields, including the pre-bound
    // `tryEnsureLingerPredBody` arrow, are stable.
    this._routeSnapshotShipStatesCtx.predWorld = this.predWorld;
    routeSnapshotShipStates(snap, this._routeSnapshotShipStatesCtx);

    // Wire-discipline P3: projectiles arrive on the snapshot, interest-filtered
    // per recipient. Sync into the mirror first so the rest of this handler can
    // assume the projectile map matches the snapshot's tick.
    this.syncProjectiles(snap.projectiles);

    // Missiles: per-recipient AOI-filtered slice. Sliding-window apply
    // for interpolation; stale-eviction backstop covers AOI exits.
    applyMissileSnapshot(snap.missiles, this.mirror, snap.serverTick, now);

    // Phase 4 — sync wreck poses into the mirror. Identity (kind, health,
    // maxHealth) flows via the Colyseus schema diff on `state.wrecks`
    // (see syncMirror); this just refreshes per-frame pose.
    this.syncWreckPoses(snap.wrecks);

    // Structures plan, Phase 3 — mirror the slim grid slice (web + power +
    // construction). Pose lives in `mirror.swarm` (kind=2); joined by entityId.
    this.syncStructures(snap.structures);

    // Server-authoritative boost + thrust sets — exhaust-trail renderer.
    applyBoostingThrustingSets(snap, this.mirror);

    // Phase 6 — surface the server's TiDi rate to the HUD + audio,
    // and drive the Temporal Anomaly banner with hysteresis. See
    // tidiSync.ts.
    syncTidiFromRoom(this.room, this.audio);

    // Per-snapshot perf stats (rolling RAF/longtask/heap, server-tick
    // EWMA, jitter, swarm display-delay sizing, collision stale-guard).
    // See snapshotPerfStats.ts.
    // Phase 4 iteration 3 swift-otter — pass `_lastSnapshotRecvAtMs`
    // (wire-recv time) so `intervalMs` reflects the WIRE cadence not the
    // RAF apply cadence. Without this, the coalescer + deferred
    // syncMirror push apply timing to RAF boundaries, the RTT updater's
    // steady-state band rejects most samples, and lookahead inflates.
    // See applySnapshotPerfStats jsdoc for the netgate evidence.
    const wireArrivalAtMs = this._lastSnapshotRecvAtMs >= 0
      ? this._lastSnapshotRecvAtMs
      : now;
    const intervalMs = applySnapshotPerfStats(snap, now, this.lastSnapshotAt, wireArrivalAtMs, {
      stats: this.stats,
      recentIntervals: this._recentIntervals,
      collisionGuard: this._collisionGuard,
      dropDetector: this._dropDetector,
      swarmBinaryEwma: this._swarmBinaryEwma,
    });
    this.lastSnapshotAt = wireArrivalAtMs;

    // Re-anchor the input clock against this snapshot. Phase 6.5 Sub-phase B
    // EWMA-smooths the anchor instead of snapping on every packet — a 30 ms-
    // early arrival followed by a 30 ms-late one used to yank `targetTick`
    // back and forth, blowing up the reconciler replay window into a 90 %
    // correction storm under server-clock skew. Logic lives in `clockAnchor.ts`
    // for unit-testability; see that module for the mechanic + thresholds.
    if (this._anchorInitialised) {
      const next = updateAnchor(
        { anchorServerTick: this.clockAnchorServerTick, anchorPerfNow: this.clockAnchorPerfNow },
        snap.serverTick,
        now,
      );
      this.clockAnchorServerTick = next.anchorServerTick;
      this.clockAnchorPerfNow = next.anchorPerfNow;
    } else {
      this.clockAnchorServerTick = snap.serverTick;
      this.clockAnchorPerfNow = now;
      this._anchorInitialised = true;
    }
    // Stage 4 — jitter-aware lookahead with the three RTT hotfixes.
    // See rttLookaheadUpdater.ts for the full rationale.
    this.leadTicks = updateRttAndLookahead(intervalMs, {
      reconciler: this.reconciler,
      stats: this.stats,
      rttWelford: this._rttWelford,
      lookaheadCtrl: this._lookaheadCtrl,
      leadTicks: this.leadTicks,
      lastFrameMs: this.lastFrameMs,
    });
    this.stats.droppedSnapshotsRecent = this._dropDetector.dropCount;

    if (!localId || !this.reconciler) {
      if (this.predWorld) {
        // Sync remote ships — keep them at their latest server position until
        // the reconciler bootstraps so they don't drift before the first reconcile.
        // Phase 5c: swarm entities (asteroids, drones) are not in predWorld;
        // they live render-only in mirror.swarm and lerp between binary
        // swarm packets server-authoritatively.
        // step 4: for…in (no tuple-array alloc).
        for (const remoteId in snap.states) {
          if (remoteId === localId) continue;
          const state = snap.states[remoteId]!;
          if (this.predWorld.hasShip(remoteId)) this.predWorld.setShipState(remoteId, state);
        }
      }
      return;
    }

    const serverState = snap.states[localId];
    const ackedTick = snap.ackedTick;
    if (serverState && ackedTick !== undefined) {
      // Stage 4 hotfix #2 — recover from inputTick starvation. On slow-
      // rafTick devices under server burst-recovery the held-ack-advance
      // contract can race ackedTick past inputTick, collapsing the
      // prediction window and producing a cascade of position corrections.
      // Detect and snap forward. See `inputTickRecovery.ts` for the full
      // mechanism and the 2026-05-08 diagnostic that motivated the fix.
      const recovered = recoverInputTickFromStarvation(this.inputTick, ackedTick, this.leadTicks);
      if (recovered !== this.inputTick) {
        this.inputTick = recovered;
        // Re-anchor the wall-clock so subsequent rafTicks don't try to
        // catch up the gap we just skipped over.
        this.clockAnchorServerTick = snap.serverTick;
        this.clockAnchorPerfNow = now;
      }
      this.stats.lastAckedTick = ackedTick;
      this.stats.ticksAhead = this.inputTick - ackedTick;

      // Reset remote ships to serverTick state BEFORE reconcile +
      // stash pre-reset poses for the post-reconcile lerp-offset
      // computation. See snapshotRemoteSync.ts.
      // Ctx pooled to `this._preResetRemoteShipsCtx`. `predWorld` is
      // the only volatile field; mutate before call.
      this._preResetRemoteShipsCtx.predWorld = this.predWorld;
      const preResetRemotePos = preResetRemoteShips(snap, localId, this._preResetRemoteShipsCtx);

      this.lastSnapshotPos = { x: serverState.x, y: serverState.y };

      // Energy reconcile (weapons/energy/AI overhaul §3.2): hard-set the
      // predicted pool from the authoritative own-ship value. A 1-frame snap
      // on a 0-100 bar is invisible. Also (re)seed the Zustand `energyMax`
      // denominator from the local kind — cheap + idempotent.
      if (typeof serverState.energy === 'number') {
        this.predEnergy = serverState.energy;
        const localKind = getShipKind(this.mirror.ships.get(localId)?.kind ?? null);
        const max = localKind.energyMax ?? 100;
        if (useUIStore.getState().energyMax !== max) useUIStore.getState().setEnergyMax(max);
      }

      // Drone snapshot slice (slim turret/shield slice; pose flows on the
      // binary swarm wire). See snapshotRemoteSync.ts.
      applyDroneMountAngles(snap, this.mirror);
      // WS-4 Phase 6 — slim MINED-asteroid resource slice → swarm mirror (R2.23
      // enabler; feeds the WS-9 inspector). Pose stays on the binary channel.
      applyAsteroidResources(snap, this.mirror);

      // Probe 5 (mobile-perf-investigation, 2026-05-24) — instrument
      // reconcile separately from the rest of handleSnapshot. The
      // y0eo1h capture (Pixel 6, fpscap=10) showed applyMs growing
      // linearly with ticksAhead (1.0 ms + 0.04 ms × ticksAhead),
      // confirming reconcile is the dominant cost. `replayWindow` and
      // `reconcileMs` go onto the snapshot_applied event so a single
      // capture distinguishes reconcile time from everything-else time.
      const replayWindow = this.inputTick - ackedTick;
      const reconcileStartMs = this.clock.now();
      this.reconciler.reconcile(
        serverState,
        snap.serverTick,
        this.inputTick,
        ackedTick,
        () => {
          // Remote-ship Stage-3 forward-prediction only. Drones carry no
          // client brain post-pivot — they are interpolated from the wire,
          // never re-simmed in replay. One path: interpolation (the
          // chapter-2 dual-correction-path concern dissolves for drones —
          // there is no second path left to fight).
          this.applyRemoteInputs();
        },
      );
      this._lastReconcileMs = this.clock.now() - reconcileStartMs;
      this._lastReplayWindow = replayWindow;

      // Post-reconcile remote-ship render lerp offsets — see
      // remoteLerpOffsets.ts.
      if (this.predWorld) {
        computeRemoteLerpOffsets({
          predWorld: this.predWorld,
          preResetRemotePos,
          remoteShipOffsets: this._remoteShipOffsets,
          predGuard: this._predGuard,
        });
      }

      const drift = this.reconciler.lastDrift;
      const angleDrift = this.reconciler.lastAngleDrift;
      // F-transit-instrument — first DESTINATION-room snapshot
      // reconcile. The `snapshot` handler is bound on both rooms;
      // `markOnce` is inert until `arm('first_snapshot')` at the room
      // swap, so a source-room snapshot during spool can't steal it.
      // Drift is already in hand (cheap) — a large first-correction
      // here would explain a post-reveal stall.
      this.transitInstr.markOnce('first_snapshot', {
        serverTick: snap.serverTick,
        driftUnits: parseFloat(drift.toFixed(4)),
        angleDriftRad: parseFloat(angleDrift.toFixed(4)),
      });
      this.stats.rttMs = Math.round(this.reconciler.lastRtt);
      this.stats.driftUnits = drift;
      this.stats.angleDriftRad = angleDrift;
      this.stats.lerping = this.reconciler.isLerping;
      this.stats.totalDriftUnits += drift;
      this.stats.totalAngleDriftRad += angleDrift;
      if (drift > this.stats.maxDriftUnits) this.stats.maxDriftUnits = drift;
      if (angleDrift > this.stats.maxAngleDriftRad) this.stats.maxAngleDriftRad = angleDrift;

      const posCorrection = drift > NOISE_THRESHOLD;
      const angCorrection = angleDrift > ANGLE_NOISE_THRESHOLD;
      if (posCorrection) {
        this.stats.significantCorrectionCount++;
      }
      if (angCorrection) {
        this.stats.significantAngleCorrectionCount++;
      }

      // Rolling correction rate over the last 10 snapshots.
      this._recentCorrFlags.push(posCorrection || angCorrection ? 1 : 0);
      if (this._recentCorrFlags.length > 10) this._recentCorrFlags.shift();
      this.stats.rollingCorrRate = this._recentCorrFlags.length > 0
        ? this._recentCorrFlags.reduce((a, b) => a + b, 0) / this._recentCorrFlags.length
        : 0;
      const rec = this.reconciler;
      // Replay-grade serverState capture (plan: capture-driven replay
      // Phase A.1, 2026-05-21). The reconciler's `lastServerState` is
      // the authoritative pose for the LOCAL player at this snapshot.
      // Captured here so the replay harness can synthesize a minimal
      // SnapshotMessage and drive `handleSnapshot()` deterministically.
      // 2026-05-26 heap-growth gate step 11: mutate the persistent
      // `_recPositionsScratch` instead of allocating a fresh literal
      // per snapshot. Both `logEvent` consumers spread the fields out
      // by value, so identity does not matter. Rounding helpers are
      // module-level (`_px3`/`_pa5`) — capture nothing, no closure
      // allocation per snapshot.
      const _ss = rec.lastServerState as { x: number; y: number; vx?: number; vy?: number; angle?: number; angvel?: number };
      const recPositions = this._recPositionsScratch;
      recPositions.serverX      = _px3(_ss.x);
      recPositions.serverY      = _px3(_ss.y);
      recPositions.serverVx     = _px3(_ss.vx ?? 0);
      recPositions.serverVy     = _px3(_ss.vy ?? 0);
      recPositions.serverAngle  = _pa5(_ss.angle ?? 0);
      recPositions.serverAngvel = _pa5(_ss.angvel ?? 0);
      recPositions.beforeX      = _px3(rec.lastBeforePos.x);
      recPositions.beforeY      = _px3(rec.lastBeforePos.y);
      recPositions.afterX       = _px3(rec.lastAfterPos.x);
      recPositions.afterY       = _px3(rec.lastAfterPos.y);

      if (posCorrection || angCorrection) {
        logEvent('correction', {
          n: this.stats.significantCorrectionCount,
          nAngle: this.stats.significantAngleCorrectionCount,
          serverTick: snap.serverTick,
          ackedTick,
          ticksAhead: this.stats.ticksAhead,
          driftUnits: parseFloat(drift.toFixed(6)),
          angleDriftRad: parseFloat(angleDrift.toFixed(6)),
          lerping: this.reconciler.isLerping,
          // Stage 1: replaced Stage 0's frame counter with a critically-
          // damped spring half-life. Surfaced here so e2e specs can verify
          // the half-life selection survives through the production
          // reconcile call path.
          lerpHalfLifeMs: this.reconciler.lerpHalfLifeMs,
          ...recPositions,
        });
      }

      logEvent('snapshot', {
        n: this.stats.snapshotCount,
        serverTick: snap.serverTick,
        ackedTick,
        ticksAhead: this.stats.ticksAhead,
        intervalMs: parseFloat(intervalMs.toFixed(1)),
        rttMs: this.stats.rttMs,
        driftUnits: parseFloat(drift.toFixed(6)),
        angleDriftRad: parseFloat(angleDrift.toFixed(6)),
        maxDriftUnits: parseFloat(this.stats.maxDriftUnits.toFixed(6)),
        maxAngleDriftRad: parseFloat(this.stats.maxAngleDriftRad.toFixed(6)),
        corrections: this.stats.significantCorrectionCount,
        angleCorrections: this.stats.significantAngleCorrectionCount,
        lerping: this.reconciler.isLerping,
        // Render-jitter-fix Phase 1b: client-side perf metrics
        // (already on `this.stats` since perf-floor Phase 1; never
        // emitted to the capture stream). Fills the diagnostic gap
        // for the af742v-style spiral where RTT climbed 50ms→10s on
        // WiFi and the cause was invisible from the capture alone.
        rafP50Ms: Number.isFinite(this.stats.rafP50Ms) ? parseFloat(this.stats.rafP50Ms.toFixed(2)) : null,
        rafP99Ms: Number.isFinite(this.stats.rafP99Ms) ? parseFloat(this.stats.rafP99Ms.toFixed(2)) : null,
        longtaskCount30s: this.stats.longtaskCount30s,
        rafGapCount30s: this.stats.rafGapCount30s,
        heapUsedMb: this.stats.heapUsedMb !== undefined ? parseFloat(this.stats.heapUsedMb.toFixed(2)) : null,
        ...recPositions,
      });

      // 2026-05-26 heap-growth gate step 11: gate the per-snapshot
      // setDevData dispatch on the Debug tab actually being mounted.
      // The sole reader (`ConnectionDiagnostics`) lives inside
      // `DebugTab`, which returns `null` when `!isDrawerOpen` (see
      // `src/client/layout/Drawer/tabs/DebugTab.tsx:43`). With the
      // drawer closed OR on a non-debug tab, no subscriber exists, so
      // pushing a fresh 19-field object into Zustand at 20 Hz pays
      // allocation + diff-check cost for nothing. Reading the gate
      // via `getState()` (non-subscribing, sync) is the established
      // pattern in this file (see clientSingleton.ts).
      const _ui = useUIStore.getState();
      if (_ui.isDrawerOpen && _ui.drawerTab === 'debug') {
        _ui.setDevData({
          rtt: this.stats.rttMs,
          drift: drift,
          angleDrift: angleDrift,
          lerping: this.reconciler.isLerping,
          snapshotIntervalMs: intervalMs,
          ticksAhead: this.stats.ticksAhead,
          snapshotCount: this.stats.snapshotCount,
          significantCorrectionCount: this.stats.significantCorrectionCount,
          significantAngleCorrectionCount: this.stats.significantAngleCorrectionCount,
          maxDriftUnits: this.stats.maxDriftUnits,
          maxAngleDriftRad: this.stats.maxAngleDriftRad,
          ackedTick: ackedTick,
          inputTick: this.inputTick,
          serverTick: snap.serverTick,
          serverX: this.reconciler.lastServerState.x,
          serverY: this.reconciler.lastServerState.y,
          beforeX: this.reconciler.lastBeforePos.x,
          beforeY: this.reconciler.lastBeforePos.y,
          afterX: this.reconciler.lastAfterPos.x,
          afterY: this.reconciler.lastAfterPos.y,
        });
      }
    }
  }

  /**
   * Sync swarm entries into the prediction world. Called after every binary
   * `swarm` packet decode. New entries spawn predWorld bodies (so the local
   * ship can collide with them and the local hitscan can target them);
   * existing entries get setShipState; entries that vanish from the mirror
   * get despawned. The predWorld key is `swarm-${entityId}`, matching the
   * sprite key in PixiRenderer and the `targetId` the server emits in
   * `laser_fired` for swarm hits.
   */
  private syncSwarmIntoPredWorld(): void {
    if (!this.predWorld || !this.mirror.swarm) return;
    // 2026-05-25 heap-growth gate step 5: persistent scratch Set +
    // cached key strings (shared with the updateMirror kinematic loop).
    const seen = this._swarmSyncSeenScratch;
    seen.clear();
    const keyCache = this._swarmBodyKeyCache;
    // Generic Entity Pipeline B4: route construction through the client
    // EntityFactory (the OOP peer of the server leaves). The reused ctx keeps
    // this allocation-free (invariant #14); `ColyseusClient` stays the owner of
    // predSwarmKeys / _swarmBodyKeyCache / _aiRegisteredIds — the leaves only
    // read the ctx and call predWorld / aiController. `staticBody` (lock + pose)
    // is now derived from the core descriptor inside the leaf base; the per-kind
    // collider / mass / AI-ledger / shield-swap details live in the leaves.
    const ctx = this._clientSpawnCtx;
    ctx.predWorld = this.predWorld;
    for (const [entityId, entry] of this.mirror.swarm) {
      // HC#2: an unrecognised pose-core kind resolves to `null` and is SKIPPED —
      // it never falls through to the drone path (the old `else`-is-drone branch
      // that would mis-register a kind=2 structure as a HostileDroneBehaviour).
      const leaf = this._entityFactory.leafFor(entry.kind);
      if (leaf === null) continue;
      let key = keyCache.get(entityId);
      if (key === undefined) {
        key = `swarm-${entityId}`;
        keyCache.set(entityId, key);
      }
      seen.add(key);
      ctx.entityId = entityId;
      ctx.key = key;
      ctx.entry = entry;
      if (!this.predWorld.hasShip(key)) {
        ctx.registeredAiId = null;
        leaf.spawnBody(ctx);
        // Fold any AI-ledger registration the leaf made (drone only) into the
        // client-owned set — single cache ownership stays here.
        if (ctx.registeredAiId !== null) {
          this._aiRegisteredIds.add(ctx.registeredAiId);
        }
        this.predSwarmKeys.add(key);
      }
      // Idempotent per-sync upkeep: shield-collider swap (drone) or static
      // repose (asteroid / structure). Drones are NOT re-posed here — the
      // `updateMirror` kinematic follower is the single per-frame pose writer
      // (one-pose-per-frame rule); the leaf's onSync only swaps the shield.
      leaf.onSync(ctx);
    }
    // Sweep predWorld bodies whose entityId no longer appears in mirror.swarm.
    for (const key of this.predSwarmKeys) {
      if (!seen.has(key)) {
        this.predWorld.despawnShip(key);
        this.predSwarmKeys.delete(key);
        // If the swept body was a drone, unregister it from the hostility
        // ledger (`_aiController` is ledger-only post-pivot — never ticked).
        // Numeric entityId is encoded in the key as `swarm-${id}`.
        const idStr = key.startsWith('swarm-') ? key.slice(6) : '';
        const id = Number(idStr);
        if (Number.isFinite(id)) {
          // Step 5 cleanup: also evict the cached key string so the
          // cache doesn't grow unbounded across entity churn.
          this._swarmBodyKeyCache.delete(id);
        }
        if (Number.isFinite(id) && this._aiRegisteredIds.has(id)) {
          this._aiController.unregister(`${id}`);
          this._aiRegisteredIds.delete(id);
        }
      }
    }
  }

  /** Sync authoritative projectile positions from the per-recipient snapshot.
   *  Wire-discipline P3: projectiles no longer live on the Colyseus schema —
   *  the server includes only the in-interest subset on each snapshot, so a
   *  projectile leaving interest will simply disappear from `seen` and be
   *  removed from the mirror. Ghost projectiles (`isGhost: true`) are
   *  preserved; the GhostManager re-adds them per-frame anyway. */
  private syncProjectiles(projectiles: SnapshotMessage['projectiles']): void {
    syncProjectiles(this.mirror, projectiles, this._syncProjectilesSeenScratch);
  }

  private syncWreckPoses(wrecks: SnapshotMessage['wrecks']): void {
    syncWreckPoses(this.mirror, wrecks, this.predWorld, this.predWreckIds);
  }

  // ── State mirror ────────────────────────────────────────────────────────

  /** Last grid net power pushed to the HUD store (avoid 20 Hz store churn). */
  private _lastGridNetPower: number | null = null;
  /** Last mineral bank pushed to the HUD store (avoid 20 Hz store churn). */
  private _lastMinerals: number | null = null;

  /** Structures plan, Phase 3 — mirror the `structures[]` slice into
   *  `mirror.structures` (rebuilt each snapshot — it's low-cadence + small) and
   *  dispatch the player's grid net power to the HUD store on change. */
  private syncStructures(slice: SnapshotMessage['structures']): void {
    if (slice && slice.length > 0) {
      let map = this.mirror.structures;
      if (!map) { map = new Map(); this.mirror.structures = map; }
      map.clear();
      let netPower: number | null = null;
      let minerals = 0;
      for (const s of slice) {
        map.set(s.id, {
          powered: s.powered,
          netPower: s.netPower ?? 0,
          connTo: s.connTo ?? [],
          built: s.built ?? false,
          buildPct: s.built ? 1 : (s.buildPct ?? 0),
          deconstructPct: s.deconstructPct ?? 0,
          ...(s.miningTargetId !== undefined ? { miningTargetId: s.miningTargetId } : {}),
          ...(s.turretTargetId !== undefined ? { turretTargetId: s.turretTargetId } : {}),
          ...(s.storedPower !== undefined ? { storedPower: s.storedPower } : {}),
          ...(s.storedPowerMax !== undefined ? { storedPowerMax: s.storedPowerMax } : {}),
          ...(s.minerals !== undefined ? { minerals: s.minerals } : {}), // WS-9 R2.12 (capital readout)
          ...(s.shieldWallTo !== undefined ? { shieldWallTo: s.shieldWallTo } : {}),
          ...(s.wallActive !== undefined ? { wallActive: s.wallActive } : {}),
        });
        // Surface the powered grid's net power (members share a component, so
        // the max powered netPower represents the player's live grid).
        if (s.powered && (netPower === null || (s.netPower ?? 0) > netPower)) {
          netPower = s.netPower ?? 0;
        }
        // The mineral bank is the Capital's store (the largest minerals value).
        if ((s.minerals ?? 0) > minerals) minerals = s.minerals ?? 0;
      }
      const resolved = netPower ?? 0;
      if (resolved !== this._lastGridNetPower) {
        this._lastGridNetPower = resolved;
        useUIStore.getState().setGridNetPower(resolved);
      }
      if (minerals !== this._lastMinerals) {
        this._lastMinerals = minerals;
        useUIStore.getState().setMinerals(minerals);
      }
    } else {
      if (this.mirror.structures && this.mirror.structures.size > 0) this.mirror.structures.clear();
      if (this._lastGridNetPower !== null) {
        this._lastGridNetPower = null;
        useUIStore.getState().setGridNetPower(0);
      }
      if (this._lastMinerals !== null) {
        this._lastMinerals = null;
        useUIStore.getState().setMinerals(0);
      }
    }
    this.syncPredWalls();
  }

  /**
   * Shield-fence plan — keep the local predWorld's shield-wall colliders in sync
   * with the active fences (the "every collidable entity must be in predWorld"
   * rule), so the LOCAL player is predicted-blocked by an up wall instead of
   * predicting through it and rubber-banding to the server. Snapshot cadence
   * (NOT the per-frame loop): walls are static + low-count, so a reconcile here
   * is cheap. Geometry derived from the two pylon poses (`mirror.swarm`), exactly
   * like the server collider + the rendered span. A down wall (stunned /
   * unpowered) has NO collider so the player passes — matching the server.
   */
  private syncPredWalls(): void {
    if (!this.predWorld) return;
    const structures = this.mirror.structures;
    const swarm = this.mirror.swarm;
    const desired = this._predWallDesired;
    desired.clear();
    if (structures && swarm) {
      for (const [id, st] of structures) {
        if (st.shieldWallTo === undefined || !st.wallActive) continue;
        if (id >= st.shieldWallTo) continue; // once per pair (lower id wins)
        const a = swarm.get(id);
        const b = swarm.get(st.shieldWallTo);
        if (!a || !b) continue;
        const wid = `predwall-${id}-${st.shieldWallTo}`;
        desired.add(wid);
        if (!this._predWallIds.has(wid)) {
          this.predWorld.spawnWall(wid, a.x, a.y, b.x, b.y, SHIELD_WALL_THICKNESS);
          this._predWallIds.add(wid);
        }
      }
    }
    for (const wid of this._predWallIds) {
      if (!desired.has(wid)) {
        this.predWorld.removeWall(wid);
        this._predWallIds.delete(wid);
      }
    }
  }

  private syncMirror(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const ships = s['ships'] as Map<string, unknown> | undefined;
    // Projectiles are no longer on the Colyseus schema — see syncProjectiles
    // call inside the snapshot handler.
    if (!ships) return;

    // Phase 4 — sync wreck identity (kind, health, maxHealth). Pose
    // arrives separately in the snapshot's `wrecks` slice. Entries here
    // are seeded with x:0, y:0 etc. until the next snapshot fills them.
    const wreckMap = s['wrecks'] as Map<string, unknown> | undefined;
    if (!this.mirror.wrecks) this.mirror.wrecks = new Map();
    if (wreckMap) {
      const seenWrecks = this._syncMirrorSeenWrecksScratch;
      seenWrecks.clear();
      for (const [shipInstanceId, w] of wreckMap.entries()) {
        const wr = w as Record<string, unknown>;
        seenWrecks.add(shipInstanceId);
        // Probe 8 — pool the wreck entry. Schema-diff path fires on
        // wreck identity updates (kind/health/maxHealth); pose comes
        // from syncWreckPoses. Mutating preserves pose (pose-write
        // happens elsewhere) and avoids the per-update allocation.
        let wreckEntry = this.mirror.wrecks.get(shipInstanceId);
        const kindVal = typeof wr['kind'] === 'string' ? (wr['kind'] as string) : 'fighter';
        const healthVal = Number(wr['health'] ?? 0);
        const maxHealthVal = Number(wr['maxHealth'] ?? 100);
        if (!wreckEntry) {
          wreckEntry = {
            shipInstanceId,
            x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
            kind: kindVal,
            health: healthVal,
            maxHealth: maxHealthVal,
          };
          this.mirror.wrecks.set(shipInstanceId, wreckEntry);
        } else {
          wreckEntry.kind = kindVal;
          wreckEntry.health = healthVal;
          wreckEntry.maxHealth = maxHealthVal;
          // x/y/vx/vy/angle/angvel are pose — owned by syncWreckPoses,
          // do not touch here.
        }
      }
      for (const id of this.mirror.wrecks.keys()) {
        if (!seenWrecks.has(id)) {
          this.mirror.wrecks.delete(id);
          // Despawn the predWorld body so local collision stops resolving
          // against a wreck that's no longer in the sector.
          const bodyId = `wreck-${id}`;
          if (this.predWreckIds.has(bodyId)) {
            this.predWorld?.despawnShip(bodyId);
            this.predWreckIds.delete(bodyId);
          }
        }
      }
    } else if (this.mirror.wrecks.size > 0) {
      this.mirror.wrecks.clear();
      // Mirror cleared entirely (e.g. left the room) — drop every wreck body.
      for (const bodyId of this.predWreckIds) {
        this.predWorld?.despawnShip(bodyId);
      }
      this.predWreckIds.clear();
    }

    const localId = this.mirror.localPlayerId;
    const now = this.clock.now();
    const seen = this._syncMirrorSeenShipsScratch;
    seen.clear();

    // Phase 6b — state.ships is now shipInstanceId-keyed on the wire.
    // The iteration variable would be misnamed if we still called it
    // `playerId`; rename and resolve the owner via the `playerId` field
    // on the schema entry. Mirror / predWorld / remoteHistory remain
    // playerId-keyed internally (C-ii strategy), matching the snapshot
    // ingest translation in handleSnapshot. Lingering hulls (isActive
    // === false) get routed into `mirror.lingeringShips` (shipInstanceId-
    // keyed) so they don't collide with the active hull's playerId in
    // `mirror.ships`.
    if (!this.mirror.lingeringShips) this.mirror.lingeringShips = new Map();
    for (const [shipInstanceId, ship] of ships.entries()) {
      const sh = ship as Record<string, unknown>;
      // Skip all dead ships — killEntity handles immediate cleanup when the destroy
      // event arrives; this guard is a defensive fallback for the case where the
      // state patch arrives before the destroy message.
      const alive = (sh['alive'] as boolean | undefined) !== false;
      if (!alive) continue;
      const playerId = sh['playerId'] as string | undefined;
      if (!playerId) continue;
      const isActive = (sh['isActive'] as boolean | undefined) !== false;
      // Plan: crispy-kazoo, Commit 8 — local-self exemption.
      // Joiner's OWN ship MUST stay in `mirror.ships` during the
      // pending-join handshake. Matching exemption lives in
      // `snapshotShipRouter.routeSnapshotShipStates`.
      const isOwnShip = playerId === this.mirror.localPlayerId;
      if (!isActive && !isOwnShip) {
        // Phase 6b — populate identity for the lingering hull. Pose
        // arrives separately in the snapshot's `states` slice and is
        // mirrored in handleSnapshot. We only set kind / displayName /
        // ownerPlayerId here from the schema diff (low-frequency).
        // Probe 8 — pool the entry; identity fields update, pose owned
        // by handleSnapshot (sibling path), preserved by NOT touching.
        const kind = typeof sh['kind'] === 'string' ? (sh['kind'] as string) : undefined;
        const displayName = typeof sh['displayName'] === 'string' ? (sh['displayName'] as string) : undefined;
        let lEntry = this.mirror.lingeringShips.get(shipInstanceId);
        if (!lEntry) {
          lEntry = {
            x: 0, y: 0, vx: 0, vy: 0, angle: 0,
            ownerPlayerId: playerId,
          };
          this.mirror.lingeringShips.set(shipInstanceId, lEntry);
        } else {
          lEntry.ownerPlayerId = playerId;
        }
        if (kind !== undefined) lEntry.kind = kind;
        if (displayName !== undefined) lEntry.displayName = displayName;
        // Laser-"ghost-at-(0,0)" fix (2026-06-03). This path is now
        // IDENTITY-ONLY — it does NOT spawn the predWorld body. The
        // snapshot path (snapshotShipRouter.routeSnapshotShipStates →
        // tryEnsureLingerPredBody) is the SOLE spawn site, exactly like
        // wrecks (SnapshotSyncHelpers.syncWreckPoses spawns the wreck
        // body only from the snapshot pose). Removed: the old Phase-6b
        // race-fallback spawn here.
        //
        // Why removed: this entry is seeded at (0,0) above (the schema
        // diff carries no pose). The old race-fallback spawned the body
        // from that seed, parking an invisible, shootable body at world
        // ORIGIN whenever the schema diff beat the first snapshot — the
        // on-device "live beam stops short at (0,0), no damage" ghost
        // (intermittent: the schema-diff-before-first-snapshot window).
        // The fallback never even met its own "don't fly through my
        // freshly-displaced hulk" goal: it spawned the body at (0,0),
        // NOT at the hull. Deferring the body to the first snapshot is
        // both correct (a hull with no authoritative pose has no known
        // position to collide with) and bounded — ships are not
        // interest-filtered and snapshots flow at 20 Hz while a client
        // is connected, so the no-body window is one ~50 ms interval.
        // Regression lock: ColyseusClient.lingeringJitter.test.ts.
        continue;
      }

      const parsed: ShipPhysicsState = {
        x: Number(sh['x'] ?? 0),
        y: Number(sh['y'] ?? 0),
        angle: Number(sh['angle'] ?? 0),
        vx: Number(sh['vx'] ?? 0),
        vy: Number(sh['vy'] ?? 0),
        angvel: sh['angvel'] !== undefined ? Number(sh['angvel']) : undefined,
      };
      // Carry the ship's kind alongside the spatial state so the renderer can
      // pick the correct silhouette / colour. Read once when the sprite is
      // built; re-reading on every state patch is wasted work.
      const kind = typeof sh['kind'] === 'string' ? (sh['kind'] as string) : undefined;
      // Phase 1 ship labels: pull the display name through to the render
      // mirror so the LabelManager can paint it above remote ships. The
      // server populates this in `SectorRoom.onJoin`; an empty string
      // means anonymous and the renderer falls back to a `Pilot ${id}`
      // label.
      const displayName = typeof sh['displayName'] === 'string' ? (sh['displayName'] as string) : undefined;
      const mirrorEntry: ShipRenderState = { ...parsed };
      if (kind !== undefined) mirrorEntry.kind = kind;
      if (displayName !== undefined) mirrorEntry.displayName = displayName;
      seen.add(playerId);

      if (playerId !== localId) {
        // Store timestamped entry for spawn-detection fallback.
        const hist = this.remoteHistory.get(playerId) ?? [];
        hist.push({ ts: now, state: parsed });
        if (hist.length > HISTORY_MAX) hist.shift();
        this.remoteHistory.set(playerId, hist);
        this.mirror.ships.set(playerId, mirrorEntry);

        // Guard: only spawn if we know who the local player is.
        if (this.predWorld && !this.predWorld.hasShip(playerId) && localId !== null) {
          this.predWorld.spawnShip(playerId, parsed.x, parsed.y, kind);
          this.predWorld.setShipState(playerId, parsed);
          this.predRemoteShipIds.add(playerId);
        }
      } else if (!this.predWorld?.hasShip(playerId)) {
        this.mirror.ships.set(playerId, mirrorEntry);
        this.tryInitPredWorld(playerId);
      }
    }

    // Remove departed ships.
    for (const key of this.mirror.ships.keys()) {
      if (!seen.has(key)) {
        this.mirror.ships.delete(key);
        this.remoteHistory.delete(key);
        if (this.predRemoteShipIds.has(key)) {
          this.predWorld?.despawnShip(key);
          this.predRemoteShipIds.delete(key);
          this._remoteShipOffsets.delete(key);
        }
        // Phase 1 AI: a player has left the sector (transit out, disconnect,
        // or fell out of state). Mirror the server's `purgeHostility` call
        // so client-side drones forget them at the same Colyseus state-diff
        // point the server forgets them at its own `onLeave`.
        this._aiController.purgeHostility(key);
      }
    }

    useUIStore.getState().setShipCount(this.mirror.ships.size);
  }

  /**
   * Called once per render frame by App.tsx before renderer.update().
   */
  updateMirror(): void {
    // step 10: 1Hz HUD dispatcher — drains pending hull/shield pct to
    // Zustand at most once per second. Bar's CSS transition animates
    // smoothly between samples. Per-event handlers (handleDamage,
    // handleShield) just stash the latest pending value; this is the
    // single dispatch site. Owned by `HudDispatcher.ts`.
    this.hudDispatcher.tick(this.clock.now());
    // F1 (warp-spool perf — `docs/HANDOFF-warp-spool-perf-followup.md`).
    // Per-frame mirror rebuild + snapshot-apply is a candidate for the
    // in-game-vs-sandbox differential (sandbox has 1 ship). Single exit
    // point (no early `return` in this method), so a start-stamp +
    // tail-emit is exact. GATED behind `isDiagEnabled()` so a normal
    // session pays nothing — when off, `mirrorRebuildStart` stays -1 and
    // the tail `logEvent` is skipped.
    const mirrorRebuildStart = isDiagEnabled() ? this.clock.now() : -1;
    const localId = this.mirror.localPlayerId;

    // Smooth-beam (2026-05-22): drain scheduled visual damage-number
    // spawns whose time has come. See `_scheduledDamageSpawns` field
    // declaration for the why; the splits are seeded inside
    // `sendFire` per predicted hit, share one `clientShotId`, and ride
    // the existing pendingDamageNumbers pipeline (which DamageNumberManager
    // drains in its own update() — cancelByTag on a mispredict cancels
    // ALREADY-SPAWNED numbers; the loop below also evicts not-yet-due
    // entries for the cancelled tag so a misprediction never produces
    // a delayed visual after the rollback). Bounded array (max ~5 ×
    // active predictions); the `cancelScheduledDamageSpawnsByTag`
    // hook is invoked from the existing reconcile path.
    if (this._scheduledDamageSpawns.length > 0) {
      const now = this.clock.now();
      const pending = this.mirror.pendingDamageNumbers;
      // Iterate from the tail so splice() is O(1) and ordering is
      // preserved for the kept entries.
      for (let i = this._scheduledDamageSpawns.length - 1; i >= 0; i--) {
        const s = this._scheduledDamageSpawns[i]!;
        if (s.atMs <= now) {
          pending?.push({ targetId: s.targetId, x: s.x, y: s.y, damage: s.damage, tag: s.tag });
          this._scheduledDamageSpawns.splice(i, 1);
          // Probe 4 (mobile-perf-investigation, 2026-05-24) — log spawn
          // separately from schedule. Previously `damage_number_predicted`
          // fired at SCHEDULE time, making it look like 5 damage numbers
          // spawned simultaneously per shot (confusing the "laser damage
          // applying inconsistently" investigation). Now schedule fires
          // once per shot with `count`, and spawn fires per actual emit
          // with `lateMs` (time between scheduled `atMs` and actual spawn
          // — measures how late the drain ran).
          logEvent('damage_number_spawned', {
            damage: s.damage,
            tag: s.tag,
            lateMs: parseFloat((now - s.atMs).toFixed(2)),
          });
        }
      }
    }

    // Local ship — prediction + lerp correction.
    if (localId && this.predWorld && this.reconciler) {
      const state = this.predWorld.getShipState(localId);
      if (state) {
        const ox = this.reconciler.lerpOffset.x;
        const oy = this.reconciler.lerpOffset.y;
        const oa = this.reconciler.lerpAngleOffset;
        this.reconciler.advanceLerp(this.lastFrameMs);

        // Render-jitter-fix Phase 1 (2026-05-21): dead-reckon the
        // rendered pose forward by `(clock.now() - _lastLocalTickAtMs) ×
        // velocity` so 0-step RAFs show smooth motion instead of a
        // frozen pose. The pre-fix renderer composed `predWorld + lerp`
        // each RAF — but on a 90 Hz mobile display with 60 Hz physics,
        // some RAFs fire without advancing a physics tick, so the
        // rendered pose was identical to the prior frame. Cluster of
        // 0-step RAFs = sprite holds for 3-5 display frames = user-
        // perceived "stop-start" jitter. Locked by `assertFramePacingSmooth`
        // on the 2q0jxw capture.
        //
        // Dead-reckon dt is capped at 32 ms (~2 ticks) to avoid wild
        // extrapolation across multi-second stalls (tab background,
        // OS process reap) — those become discrete "freeze events"
        // visually, not glide-overshoot artifacts.
        //
        // When the next physics tick fires, `state.x` will equal
        // `prev_state.x + vx × dt + accel × dt²/2` ≈ the dead-reckoned
        // pose (acceleration term is sub-pixel for typical ship
        // accelerations over 16.7 ms), so the transition from dead-
        // reckon to authoritative tick is visually continuous.
        const tickElapsedMs = this._lastLocalTickAtMs >= 0
          ? Math.max(0, Math.min(32, this.clock.now() - this._lastLocalTickAtMs))
          : 0;
        const dtSec = tickElapsedMs / 1000;
        const drX = state.x + state.vx * dtSec;
        const drY = state.y + state.vy * dtSec;
        const drAngle = state.angle + (state.angvel ?? 0) * dtSec;

        // Preserve non-spatial fields across per-frame rewrites so the
        // renderer keeps drawing the correct silhouette and the local-
        // turret rotation state survives the per-frame mirror rebuild.
        // `kind` was the first such field; `displayName` follows the same
        // pattern; `mountAngles` (Phase 4b.2) is critical — `tickLocalMountAim`
        // writes it on the same frame and `updateLiveBeam` re-derives the
        // beam geometry from it, so wiping it here makes the visible beam
        // flip back to baseAngle every render frame (visible bug: a solid
        // unrotated beam under the flickering correctly-rotated ghost).
        // Probe 7 (mobile-perf-investigation, 2026-05-24) — mutate
        // the existing entry in place instead of allocating a new
        // object literal per RAF. Non-spatial fields (`kind`,
        // `displayName`, `mountAngles`) are PRESERVED by not touching
        // them — they were written previously by `syncMirror` (kind/
        // displayName) and `tickLocalMountAim` (mountAngles) and stay
        // on the entry across rebuilds. Pre-fix the conditional-spread
        // pattern allocated 2-4 objects per ship per RAF, ~9000
        // allocations/sec at 25 in-interest entities. Pooling eliminates
        // these allocations entirely after the first-spawn create.
        let entry = this.mirror.ships.get(localId);
        if (!entry) {
          entry = {
            x: drX + ox,
            y: drY + oy,
            vx: state.vx,
            vy: state.vy,
            angle: drAngle + oa,
          };
          this.mirror.ships.set(localId, entry);
        } else {
          entry.x = drX + ox;
          entry.y = drY + oy;
          entry.vx = state.vx;
          entry.vy = state.vy;
          entry.angle = drAngle + oa;
        }

        // Structure placement ghost preview (smoke handoff 2026-06-06, Issue 5;
        // post-Confirm "pending" ghost added playtest 2026-06-10 Issue 7). The
        // live (positioning) ghost is anchored to the RENDERED local-ship pose
        // (the same dead-reckoned + lerp pose the sprite is drawn at) so it
        // tracks the ship; the dim "pending" ghost sits at the sent point until
        // the structure lands (slice count grows) or times out — bridging the
        // RTT+snapshot gap where the blueprint used to vanish. Spatial pose →
        // render mirror, NOT Zustand (#2 — only the discrete `placementKind` id
        // lives in Zustand). The resolver reuses `computePlacementPose` so the
        // live ghost lands EXACTLY where Confirm sends (no preview/commit drift).
        const placementKind = useUIStore.getState().placementKind;
        const ship = this._placementShipScratch;
        ship.x = entry.x;
        ship.y = entry.y;
        ship.angle = entry.angle;
        // R2.1 — a structure RENDERS only when its entityId has a swarm pose
        // (mirror.swarm, kind 2); the JSON structures slice that grows the count
        // arrives on a SEPARATE channel. The pending ghost must persist until the
        // structure is actually renderable (every slice entry has a swarm pose),
        // not merely until the slice count grew, or it vanishes for the channel
        // gap. Computed alloc-free (Map keys() iterator, reused maps) and ONLY
        // while a placement is pending — the common no-pending frame pays nothing.
        let allRenderable = true;
        if (this._pendingPlacement) {
          const structs = this.mirror.structures;
          const sw = this.mirror.swarm;
          if (structs && structs.size > 0) {
            if (!sw) {
              allRenderable = false;
            } else {
              for (const id of structs.keys()) {
                if (!sw.has(id)) {
                  allRenderable = false;
                  break;
                }
              }
            }
          }
        }
        const placementStatus = resolvePlacementPreviewStatus(
          placementKind,
          placementKind ? ship : null,
          this._pendingPlacement,
          Date.now(),
          this.mirror.structures?.size ?? 0,
          allRenderable,
          this._placementPreviewScratch,
        );
        if (placementStatus === 'active' || placementStatus === 'pending') {
          this.mirror.pendingPlacementPreview = this._placementPreviewScratch;
        } else {
          if (placementStatus === 'cleared') this._pendingPlacement = null;
          if (this.mirror.pendingPlacementPreview) this.mirror.pendingPlacementPreview = null;
        }

        // Replay-grade per-RAF rendered-pose capture (plan: replay infra
        // Phase A, 2026-05-21). This is the EXACT position+angle the
        // renderer will draw this frame — dead-reckoned predWorld +
        // lerpOffset. The GROUND TRUTH for the on-device user experience
        // and the basis for `assertFramePacingSmooth` (plan: render-
        // jitter-fix Phase 0a) and `assertNoTeleport`.
        // HIGH_VOLUME_TAGS gate (Phase 5e — invariant #14). `logEvent`
        // would discard this in production but the object literal was
        // being built per-RAF regardless. Gate at the callsite so the
        // literal is never even allocated on a production session.
        if (isFullDiagMode()) {
          logEvent('local_pose_rendered', {
            inputTick: this.inputTick,
            x: Math.round((drX + ox) * 1000) / 1000,
            y: Math.round((drY + oy) * 1000) / 1000,
            angle: Math.round((drAngle + oa) * 10000) / 10000,
            lerpOffsetX: Math.round(ox * 1000) / 1000,
            lerpOffsetY: Math.round(oy * 1000) / 1000,
            lerpAngleOffset: Math.round(oa * 10000) / 10000,
          });
        }

        // 2026-05-28 — Ramming probe: per-frame snapshot of all the
        // pose surfaces that could contribute to visual-vs-physics
        // divergence during a player ↔ drone collision. Logged ONLY
        // when the player is within 400 u of the nearest drone (the
        // only situation where the gap matters — otherwise this
        // would flood the diag at 60 Hz). Used by
        // `tests/e2e/ramming-probe-armpit.spec.ts` and on-device
        // smoke captures to diagnose the 2026-05-28 "fly inside the
        // T-ship" report (user observation: speed-dependent visible
        // penetration into the rendered hull silhouette).
        //
        // TODO: alloc-debt (Invariant #14) — this block runs every
        // frame within 1500 u of any drone and builds a ~12-field
        // diagnostic object literal that feeds `logEvent`. Should be
        // gated on `isFullDiagMode()` so production never allocates
        // here. Deferred per fuzzy-gray integration plan; sweep with
        // `grep -rn 'TODO: alloc-debt' src/` follow-up.
        //
        // Captured surfaces:
        //   - physPos     : local player predWorld position (collider).
        //   - physVel/Spd : predWorld velocity (drives dead-reckon).
        //   - visPos      : what the renderer DRAWS (= drX + ox).
        //   - drOffset    : dead-reckon contribution = vel × dtSec.
        //   - lerpOffset  : reconciliation smoothing residue (ox, oy).
        //   - dronePos    : drone's interpolated/rendered position
        //                   (same value the kinematic-follower will
        //                   write to predWorld this frame).
        //   - physDist    : center-to-center physics distance.
        //   - visDist     : center-to-center visual distance.
        //   - visVsPhys   : |visDist − physDist| — pure visual vs
        //                   physics divergence, the smoking-gun
        //                   number for "I see myself inside but
        //                   physics says I'm not". Always ≥ 0.
        //
        // Gated on isRammingProbeEnabled() (2026-05-29, plan: lazy-mochi
        // — supersedes the 2026-05-28 isFullDiagMode() gate). Capture
        // ilhqk6 surfaced the unconditional alloc cost; b7b18d1 gated it
        // on isFullDiagMode but Playwright auto-enables diag via
        // navigator.webdriver, so every E2E spec that touches drones
        // (combat-heap-growth, heap-growth-gate, every netgate rep,
        // every smoke spec) still paid the ~12-field nested literal
        // per RAF — driving updateMirror's share of CDP-sampled
        // allocation from 4.6 % on main to 15.1 % on integration HEAD
        // (lazy-mochi P2). Opt-in via `?probe=ram` only; the ramming-
        // probe-armpit.spec.ts sets it explicitly. No E2E that isn't
        // investigating ramming behaviour pays anything now.
        if (isRammingProbeEnabled() && this.mirror.swarm) {
          let nearestId = -1;
          let nearestDx = 0;
          let nearestDy = 0;
          let nearestDistSq = Infinity;
          for (const [entityId, entry] of this.mirror.swarm) {
            if (entry.kind !== 1) continue;
            const dx = entry.x - state.x;
            const dy = entry.y - state.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < nearestDistSq) {
              nearestDistSq = distSq;
              nearestId = entityId;
              nearestDx = dx;
              nearestDy = dy;
            }
          }
          // 1500 u threshold accommodates gigantic test ships like the
          // L-shape (polygon extent ~2000 from body center). For normal
          // gameplay this still filters out most far-off drones — only
          // ones the player could plausibly collide with get logged.
          if (nearestId >= 0 && nearestDistSq < 1500 * 1500) {
            const droneEntry = this.mirror.swarm.get(nearestId);
            if (droneEntry) {
              const physDist = Math.sqrt(nearestDistSq);
              const visDx = (drX + ox) - droneEntry.x;
              const visDy = (drY + oy) - droneEntry.y;
              const visDist = Math.sqrt(visDx * visDx + visDy * visDy);
              const physSpd = Math.sqrt(state.vx * state.vx + state.vy * state.vy);
              void nearestDx; void nearestDy; // diagnostics: relative direction kept here for callsites that need it
              logEvent('ramming_probe', {
                inputTick: this.inputTick,
                physPos: {
                  x: Math.round(state.x * 1000) / 1000,
                  y: Math.round(state.y * 1000) / 1000,
                },
                physVel: {
                  x: Math.round(state.vx * 1000) / 1000,
                  y: Math.round(state.vy * 1000) / 1000,
                },
                physSpd: Math.round(physSpd * 10) / 10,
                visPos: {
                  x: Math.round((drX + ox) * 1000) / 1000,
                  y: Math.round((drY + oy) * 1000) / 1000,
                },
                drOffset: {
                  x: Math.round((drX - state.x) * 1000) / 1000,
                  y: Math.round((drY - state.y) * 1000) / 1000,
                },
                lerpOffset: {
                  x: Math.round(ox * 1000) / 1000,
                  y: Math.round(oy * 1000) / 1000,
                },
                droneId: nearestId,
                dronePos: {
                  x: Math.round(droneEntry.x * 1000) / 1000,
                  y: Math.round(droneEntry.y * 1000) / 1000,
                },
                droneShieldDown: droneEntry.shieldDown ?? false,
                droneKind: droneEntry.shipKind ?? null,
                physDist: Math.round(physDist * 100) / 100,
                visDist: Math.round(visDist * 100) / 100,
                visVsPhys: Math.round(Math.abs(visDist - physDist) * 100) / 100,
                // 2026-05-28 contact-state probe — directly ask Rapier what
                // the resolver produced THIS tick for the player ball:
                //   - normal       : world-space normal the resolver chose
                //                    to push the player along (should point
                //                    AWAY from the polygon edge).
                //   - penetration  : Rapier's own measured overlap (negative
                //                    contactDist, in world units). If this
                //                    matches the body-local penetration we
                //                    compute geometrically, the resolver is
                //                    SEEING the overlap correctly. If the
                //                    resolver reports 0 while we measure 20u
                //                    geometrically, the contact isn't even
                //                    being generated → polygon decomposition
                //                    seam problem.
                //   - impulse      : the impulse magnitude applied this step.
                //                    If thrust = 9000 N and impulse < 9000,
                //                    the resolver is under-pushing → param /
                //                    iteration count too low.
                //   - contactCount : number of contact points (multi-edge =
                //                    concave-corner contact).
                //   - otherBodyId  : which body the player is contacting
                //                    (sanity-check it's a swarm drone, not
                //                    something else).
                contactState: this.predWorld.queryContactState(localId) ?? null,
              });
            }
          }
        }

        // Diagnostic — track swarm entities entering/leaving overlap range.
        // The user reported "overlapping with enemy ships" (drones, since
        // ship-on-ship interactions wouldn't show in single-player rooms).
        // We log entry/exit events for any swarm entity within
        // SWARM_OVERLAP_LOG_DIST of the local ship's RENDERED position
        // (mirror, includes lerp). Entry and exit are logged with both
        // the rendered local position AND the predWorld position so we
        // can tell if the overlap is real (predWorld distance also small)
        // or render-only (predWorld distance fine, lerp pulled the sprite).
        if (this.mirror.swarm) {
          const renderedX = state.x + ox;
          const renderedY = state.y + oy;
          const SWARM_OVERLAP_LOG_DIST = 100; // ~ ship radius + drone radius + buffer
          // 2026-05-25 heap-growth gate step 2: two-Set swap.
          const nowNear = this._swarmNearbySwapScratch;
          nowNear.clear();
          for (const [entityId, entry] of this.mirror.swarm) {
            const dx = entry.x - renderedX;
            const dy = entry.y - renderedY;
            if (dx * dx + dy * dy < SWARM_OVERLAP_LOG_DIST * SWARM_OVERLAP_LOG_DIST) {
              nowNear.add(entityId);
              if (!this._swarmNearbyIds.has(entityId)) {
                logEvent('swarm_near_enter', {
                  entityId,
                  kind: entry.kind,
                  swarmPos: {
                    x: parseFloat(entry.x.toFixed(2)),
                    y: parseFloat(entry.y.toFixed(2)),
                  },
                  rendered: {
                    x: parseFloat(renderedX.toFixed(2)),
                    y: parseFloat(renderedY.toFixed(2)),
                  },
                  predWorld: {
                    x: parseFloat(state.x.toFixed(2)),
                    y: parseFloat(state.y.toFixed(2)),
                  },
                  lerpOffset: {
                    x: parseFloat(ox.toFixed(2)),
                    y: parseFloat(oy.toFixed(2)),
                  },
                  distRendered: parseFloat(Math.sqrt(dx * dx + dy * dy).toFixed(2)),
                });
              }
            }
          }
          for (const oldId of this._swarmNearbyIds) {
            if (!nowNear.has(oldId)) {
              logEvent('swarm_near_exit', { entityId: oldId });
            }
          }
          const oldActive = this._swarmNearbyIds;
          this._swarmNearbyIds = nowNear;
          this._swarmNearbySwapScratch = oldActive;
        }
      }
    }

    // Server ghost position — orange diamond drawn at the raw snapshot coords.
    this.mirror.serverGhostPos = this.lastSnapshotPos;
    // Snapshot the user's debug visibility preference into the mirror once per
    // frame so the Pixi renderer never reaches into the Zustand subscription
    // path (per src/client/CLAUDE.md Zustand-purity rule).
    this.mirror.showServerGhost = useUIStore.getState().showServerGhost;

    // Phase 5c: swarm entities (asteroids, drones) live in mirror.swarm,
    // populated by `decodeSwarmPacket` on every binary 'swarm' message. They
    // have no client prediction — server-authoritative @ 60 Hz lerped between
    // received frames. The renderer reads mirror.swarm directly each frame.

    // Drones (kind=1): PURE snapshot interpolation off the decoder-fed
    // `poseRing` (drone-snapshot-interpolation pivot, 2026-05-18). The
    // SAME `interpolateSwarmPose` the renderer uses (display-delay buffer
    // + teleport guard), computed ONCE here and written into the mirror
    // entry so every reader — renderer, HaloRadar, labels, health bars,
    // MountVisualManager, damage numbers — sees one consistent pose. We
    // also drive the predWorld drone body KINEMATICALLY to that same
    // interpolated pose so the local player's predicted ship collides
    // with the drone where it is drawn (the folded "kinematic follower").
    // No client AI, no re-sim, no reconcile anchor — the server stays
    // fully hit-authoritative (there is no client drone ray), so this
    // body is presentation/collision only.
    //
    // Asteroids (kind=0) keep their predWorld pose from the binary packet
    // (set in `syncSwarmIntoPredWorld`) and the renderer interpolates them
    // off the same poseRing — nothing to do for them here.
    if (this.predWorld && this.mirror.swarm) {
      const nowMs = this.clock.now();
      // 2026-05-25 heap-growth gate step 5: pooled outer state object
      // + cached `swarm-${id}` keys. Per drone per RAF, this loop was
      // the biggest single allocator in the combat repro (25 × 90 ≈
      // 2250 object literals + 2250 strings/sec). Both pooled now.
      const kinematicScratch = this._swarmKinematicScratch;
      const keyCache = this._swarmBodyKeyCache;
      for (const [entityId, entry] of this.mirror.swarm) {
        if (entry.kind !== 1) continue;
        interpolateSwarmPose(entry, nowMs, this._swarmInterpScratch);
        entry.x = this._swarmInterpScratch.x;
        entry.y = this._swarmInterpScratch.y;
        entry.angle = this._swarmInterpScratch.angle;
        let bodyKey = keyCache.get(entityId);
        if (bodyKey === undefined) {
          bodyKey = `swarm-${entityId}`;
          keyCache.set(entityId, bodyKey);
        }
        if (this.predWorld.hasShip(bodyKey)) {
          kinematicScratch.x = entry.x;
          kinematicScratch.y = entry.y;
          kinematicScratch.vx = entry.vx;
          kinematicScratch.vy = entry.vy;
          kinematicScratch.angle = entry.angle;
          kinematicScratch.angvel = 0;
          this.predWorld.setShipState(bodyKey, kinematicScratch);
        }
      }
    }

    // Remote ships — read from predWorld at 60 Hz with decaying lerp offsets.
    if (this.predWorld) {
      for (const remoteId of this.predRemoteShipIds) {
        if (remoteId === localId) continue;
        const s = this.predWorld.getShipState(remoteId);
        if (!s) continue;
        const off = this._remoteShipOffsets.get(remoteId);
        let ox = 0, oy = 0;
        if (off) {
          // Stage 1: critically-damped spring. Frame-rate independent and
          // matches Reconciler's local-ship offset shape. Threshold-based
          // termination ends the spring once both axes are at the noise
          // floor (position and velocity).
          springStep(off.sx, 0, off.halfLifeMs, this.lastFrameMs);
          springStep(off.sy, 0, off.halfLifeMs, this.lastFrameMs);
          ox = off.sx.x;
          oy = off.sy.x;
          const stillMoving =
            Math.abs(off.sx.x) > REMOTE_SPRING_POS_END ||
            Math.abs(off.sy.x) > REMOTE_SPRING_POS_END ||
            Math.abs(off.sx.v) > REMOTE_SPRING_VEL_END_MS ||
            Math.abs(off.sy.v) > REMOTE_SPRING_VEL_END_MS;
          if (!stillMoving) this._remoteShipOffsets.delete(remoteId);
        }
        // Probe 7 — mutate in place. Same rationale as the local-ship
        // pooling above: non-spatial fields (kind, displayName,
        // mountAngles) are preserved by NOT touching them.
        let entry = this.mirror.ships.get(remoteId);
        if (!entry) {
          entry = {
            x: s.x + ox,
            y: s.y + oy,
            vx: s.vx,
            vy: s.vy,
            angle: s.angle,
          };
          this.mirror.ships.set(remoteId, entry);
        } else {
          entry.x = s.x + ox;
          entry.y = s.y + oy;
          entry.vx = s.vx;
          entry.vy = s.vy;
          entry.angle = s.angle;
        }
      }
    }

    // Phase 6b (2026-05-13, third iteration) — lingering hull
    // visualised with the same predict-and-reconcile pattern as
    // remote player ships. Body integrates physics locally between
    // snapshots; snapshot arrival reconciles the body to the
    // server-authoritative pose and registers a spring-decayed lerp
    // offset on the sprite. Sprite = body pose + decaying offset,
    // smoothly converging to the body's true position over ~200 ms.
    //
    // Why not just teleport the body and snap the sprite?
    //   First iteration: sprite at snapshot pose, body integrating
    //     → fly-through (sprite static, body collision elsewhere).
    //   Second iteration: sprite tracking body → snap-back (body
    //     drifts forward of snapshot, every snapshot teleports both
    //     backwards).
    //   This iteration: sprite = body + offset → body always tracks
    //     server reality; offset smooths the visual after each
    //     reconcile so the user doesn't see the teleport directly.
    //     Exactly how remote ships have always worked.
    if (this.predWorld) {
      this.lingerBodies.applyPerFrameOffsets(this.predWorld, this.mirror, this.lastFrameMs);
    }

    // Ghost projectiles — advance and write to mirror.projectiles.
    if (this.mirror.projectiles) {
      this.ghostManager.update(this.lastFrameMs, this.mirror.projectiles);

      // Authoritative projectile extrapolation. Snapshots arrive at 20 Hz, but
      // we render at RAF cadence — without per-frame integration the bolt is
      // frozen between snapshots and visibly stutters. Server-side projectiles
      // are constant-velocity (no forces), so straight-line extrapolation is
      // exact between snapshots. Ghosts are advanced by GhostManager above.
      const dtSec = this.lastFrameMs / 1000;
      for (const entry of this.mirror.projectiles.values()) {
        if (entry.isGhost) continue;
        entry.x += entry.vx * dtSec;
        entry.y += entry.vy * dtSec;
      }
    }

    // Damage flash — advance counters, populate mirror.damagedShips.
    this.mirror.damagedShips?.clear();
    for (const [id, frames] of this._damageFlashFrames) {
      if (frames <= 0) {
        this._damageFlashFrames.delete(id);
      } else {
        this.mirror.damagedShips?.add(id);
        this._damageFlashFrames.set(id, frames - 1);
      }
    }

    // weapon-hit-prediction Phase 2 — TTL-expire predictions whose
    // confirmation never arrived and hard-cancel their predicted numbers
    // (lost-ack / projectile-that-missed failsafe). Phase 3 adds the
    // hit_ack/DamageEvent-driven cancels on top of this one channel.
    const expiredShots = this._hitLedger.tick(this.clock.now());
    if (expiredShots.length > 0) {
      const cancels = this.mirror.pendingDamageNumberCancels;
      if (cancels) for (const e of expiredShots) cancels.push(e.clientShotId);
    }

    // beam-attach fix (capture pe6rdt): expire the persisted local
    // hitscan beam once its post-fire window has elapsed. While within
    // the window the renderer keeps drawing `mirror.liveBeams` from
    // `mirror.ships` every frame (ship-attached); past it, clear so a
    // released / switched weapon doesn't leave a beam lingering.
    if (
      this.mirror.liveBeams &&
      this.mirror.liveBeams.size > 0 &&
      !liveBeamVisible(this.clock.now(), this._lastHitscanFireMs, LIVE_BEAM_PERSIST_MS)
    ) {
      this.mirror.liveBeams.clear();
    }

    // explodingShips is cleared in App.tsx AFTER renderer.update() so the renderer
    // actually sees the set on the frame it was populated.

    // Expire remote lasers past their TTL. Per-mount, so different mounts on
    // the same shooter independently fade out as their cooldown windows end.
    if (this.mirror.remoteLasers && this.mirror.remoteLasers.size > 0) {
      const now = this.clock.now();
      for (const [shooterId, perShooter] of this.mirror.remoteLasers) {
        for (const [mountId, laser] of perShooter) {
          if (laser.expiresAt <= now) perShooter.delete(mountId);
        }
        if (perShooter.size === 0) this.mirror.remoteLasers.delete(shooterId);
      }
    }

    // Phase F — drone hostility flag, driven by the per-drone AI behaviour's
    // `hostileTo` set. The radar (and any future hostility-aware surface)
    // reads `entry.isHostileToLocal` to colour entities. O(N) per frame
    // over registered drones; the underlying lookup is a Set.has().
    if (this.mirror.swarm && localId) {
      for (const [entityId, entry] of this.mirror.swarm) {
        if (entry.kind !== 1) continue; // asteroid — no hostility concept
        entry.isHostileToLocal = this._aiController.isEntityHostileToPlayer(
          `${entityId}`,
          localId,
        );
      }
    }

    // F1 — close the mirror-rebuild bracket opened at method entry.
    // Only emitted when diagnostics are enabled (see note at the top).
    if (mirrorRebuildStart >= 0) {
      logEvent('mirror_rebuild', { totalMs: this.clock.now() - mirrorRebuildStart });
    }
  }

  // ── Input loop (server-tick-anchored, driven by rAF in App.tsx) ───────

  /**
   * Called once per rAF frame. Catches `inputTick` up to the server-tick-
   * derived target (re-anchored on every snapshot), at most
   * `MAX_CATCH_UP_TICKS` per frame.
   *
   * Why we anchor on the latest `serverTick` instead of the welcome time:
   * if the server falls below 60 Hz (over-budget AI tick, swarm physics, etc.)
   * a wall-clock-from-welcome anchor advances `inputTick` at 60 Hz regardless,
   * leaving it tens of ticks ahead of the server within a few seconds. The
   * reconciler then replays a huge input window every snapshot and `corr`
   * climbs to 30-60% (May 2026 mobile capture: server measured at 46.3 Hz).
   *
   * Anchoring on the snapshot's server tick + half-RTT lead means a slow
   * server drags the client's tick advance down with it, keeping the replay
   * window small. `MAX_CATCH_UP_TICKS = 4` per RAF still bounds CPU after a
   * long background-tab pause.
   */
  /**
   * Plan: crispy-kazoo, Commit 8 — inbound-drain prelude extracted so
   * it can run every RAF EVEN WHILE LOADING (the pause boundary in
   * gameRafLoop gates only `tickPhysics`, not this). Without this
   * extraction, `processPendingSnapshot` wouldn't fire during the
   * curtain window, the joiner's first snapshot would queue
   * indefinitely, `firstSnapshotApplied` never flips, and the
   * bootstrap chain stalls forever (the 2026-05-31 second-order bug
   * surfaced by spawn-handshake.spec.ts).
   *
   * Idempotent + cheap when nothing's pending. Calls:
   *   - DataChannel raw-bytes drain (decode + dispatch latest frame).
   *   - Hybrid syncMirror pending-state drain (Phase 4 iteration 3).
   *   - Snapshot coalescer drain (queues snapshots → handleSnapshot).
   *   - RAF stall detector probes (heap + frame-gap).
   */
  tickInbound(elapsedMs: number): void {
    if (!this.room) return;
    this._dataChannelTransport?.drainPending();
    if (this._pendingStateForSync !== null) {
      const pending = this._pendingStateForSync;
      this._pendingStateForSync = null;
      this.syncMirror(pending);
    }
    this._syncMirrorRanThisRaf = false;
    this.processPendingSnapshot();
    this.rafStallDetector.sampleHeapIfDue();
    this.rafStallDetector.detectGap(elapsedMs, this.inputTick, this.clock.now());
  }

  tickPhysics(elapsedMs: number): void {
    if (!this.room || !this.keyboard) return;
    this.lastFrameMs = elapsedMs;
    if (this.welcomePerfNow === 0) return; // welcome not yet received
    // Inbound-drain is now done by `tickInbound` (called from
    // gameRafLoop above the loading pause boundary). tickPhysics is
    // the input-loop + physics-step portion only.
    const FIXED_MS = 1000 / 60;
    const MAX_CATCH_UP_TICKS = 4;
    // Spiral fix (plan: spiral-fix, Phase 2): cap inputTick over-prediction
    // at 60 ticks beyond ackedTick (~1 sec at 60 Hz). 2× the healthy-network
    // CEILING_TICKS=30 ticksAhead ceiling, so the cap never engages on the
    // healthy local profile but bounds bufferbloat-induced spiral on mobile
    // networks. NOT capping inputTick itself (the 6e4d9c2 anti-pattern) —
    // capping the CONDITION `inputTick - ackedTick`. Companion change:
    // `keyboard.read()` hoisted out of the loop so cap-engaged RAFs still
    // emit a sentinel input + diagnostic log.
    const MAX_OVER_PREDICTION_TICKS = 60;
    const ticksSinceAnchor = Math.floor((this.clock.now() - this.clockAnchorPerfNow) / FIXED_MS);
    const targetTick = this.clockAnchorServerTick + ticksSinceAnchor + this.leadTicks;
    const tickDeficitBefore = targetTick - this.inputTick;
    let stepsThisFrame = 0;
    let capEngaged = false;
    // Hoist Keyboard.read() out of the loop — Keyboard.ts read() returns
    // current boolean state with no internal mutation (stateless). CRITICAL:
    // do NOT also hoist the joystick block below — `joystickToInput` reads
    // per-iteration `localShip.angle` (which advances via `predWorld.tick`
    // each step) and its hysteresis bands (TURN_OFF_RAD=0.04, …) track those
    // rotation-induced threshold crossings. Hoisting joystick would cause
    // phantom over-rotation on held-stick inputs; the hysteresis mechanism is
    // locked by `joystickToInput.test.ts` and a resulting corr-rate spiral
    // would trip the netcode-health gate (`pnpm e2e:netgate`).
    const kb = this.keyboard.read();
    while (this.inputTick < targetTick && stepsThisFrame < MAX_CATCH_UP_TICKS) {
      // Over-prediction cap. `lastAckedTick > 0` excludes the
      // welcome-to-first-snapshot window (~50 ms; too short to spiral).
      if (this.stats.lastAckedTick > 0
          && this.inputTick >= this.stats.lastAckedTick + MAX_OVER_PREDICTION_TICKS) {
        capEngaged = true;
        break;
      }
      stepsThisFrame++;
      let tcThrust = false, tcTurnLeft = false, tcTurnRight = false, tcFire = false;
      if (this.touchInput) {
        tcFire = this.touchInput.getFireHeld();
        const v = this.touchInput.getJoystickVector();
        const localId = this.mirror.localPlayerId;
        // Render-jitter-fix Phase 1: read REAL-TIME predWorld angle for
        // the joystick hysteresis. The mirror angle now carries the
        // dead-reckon term (up to 32 ms × angvel ≈ 0.08 rad at max
        // turn rate), which is 2× the joystick hysteresis band
        // (TURN_OFF_RAD=0.04 in joystickToInput). Reading the mirror
        // could perturb the engaged/disengaged crossing and cause
        // phantom turn-direction reversal under sustained held input —
        // exactly the spiral-fix bug class the joystick hysteresis was
        // built to prevent. Mirror fallback covers the boot window
        // before predWorld has a ship body.
        const predState = localId ? this.predWorld?.getShipState(localId) ?? null : null;
        const localShip = localId ? this.mirror.ships.get(localId) : null;
        const realAngle = predState?.angle ?? localShip?.angle ?? null;
        if (realAngle !== null) {
          // 2026-05-20 spiral fix: pure resolver with HYSTERESIS bands.
          // Pre-fix `delta > TOUCH_TURN_TOLERANCE` had no off-threshold;
          // as the ship rotated toward target, delta crossed 0.08 rad,
          // turn toggled — analog stick noise then nudged it back across,
          // toggled again. Empirical ~10 Hz state-change rate → sustained
          // ~45-70 % rollingCorrRate spiral. Unit-locked in
          // src/client/input/joystickToInput.test.ts.
          const next = joystickToInput(v, realAngle, this._joystickInputState);
          this._joystickInputState = next;
          tcTurnLeft = next.turnLeft;
          tcTurnRight = next.turnRight;
          tcThrust = next.thrust;
        }
      }
      const thrust    = kb.thrust    || tcThrust;
      const turnLeft  = kb.turnLeft  || tcTurnLeft;
      const turnRight = kb.turnRight || tcTurnRight;
      const fireHeld  = kb.fireHeld  || tcFire;
      const boost     = kb.boost || (this.touchInput?.getBoostHeld() ?? false);
      // Reverse is keyboard-only in v1 — no on-screen button on touch yet.
      const reverse   = kb.reverse;
      const tick = this.inputTick++;

      // Replay-grade input-intent capture (plan: replay infra Phase A).
      // This is the EXACT raw input state for this tick — what the user
      // pressed at this client-side wall-clock moment. Required by the
      // deterministic replay harness to drive the same input stream into
      // a Node-side ColyseusGameClient instance. Logged BEFORE the
      // throttle check (`inputSent` is sampled / state-change-gated; this
      // is the ground truth of what the loop SAW). Joystick vector pulled
      // raw via `getJoystickVector()` so the replay can reconstruct
      // analog stick motion (not just the booleans it resolved to).
      // HIGH_VOLUME_TAGS gate (Phase 5e — invariant #14). Skip the
      // joystick-vector read + object literal when not in diag mode.
      if (isFullDiagMode()) {
        const _jv = this.touchInput?.getJoystickVector() ?? null;
        logEvent('input_intent', {
          tick,
          thrust,
          turnLeft,
          turnRight,
          boost,
          reverse,
          fireHeld,
          joystickX: _jv ? Math.round(_jv.x * 1000) / 1000 : null,
          joystickY: _jv ? Math.round(_jv.y * 1000) / 1000 : null,
        });
      }

      // No client-side drone AI tick (drone-snapshot-interpolation pivot,
      // 2026-05-18). Drones are pure snapshot-interpolated from the binary
      // swarm wire; the server simulates every drone authoritatively. No
      // client brain ⇒ no divergent inputs ⇒ nothing to reconcile/snap.
      if (!this.localDead && this.predWorld && this.reconciler && this.mirror.localPlayerId) {
        const nowMs = this.clock.now();
        // Boost is now an independent every-tick forward impulse (no longer
        // gated on thrust), so it MUST be energy-gated to match the server:
        // `InputHandler` strips the boost bit when the pool can't afford
        // BOOST_TICK_COST. Predicting an un-gated boost while the server
        // applies none = continuous per-tick velocity divergence once the
        // pool empties (the netgate's rollingCorrRate / maxDriftUnits class).
        // `predEnergy` is hard-reconciled to server energy each snapshot, so
        // this gate tracks the server's; the fire path gates the same way.
        // We predict, record, SEND and drain on the SAME gated value so client
        // and server stay byte-aligned (minimises corrections).
        const boostApplied = boost && canAfford(this.predEnergy, BOOST_TICK_COST);
        // Pooled per-tick scratches (data-driven from the 2026-05-30 CDP
        // profile — `tickPhysics` was rank-2 at 81 KB / 7.5 %). The
        // Reconciler copies `rec` into its own ring buffer; predWorld
        // applyInput reads the fields into Rapier. Both safe to reuse.
        const rec = this._inputRecScratch;
        rec.tick = tick;
        rec.thrust = thrust;
        rec.turnLeft = turnLeft;
        rec.turnRight = turnRight;
        rec.boost = boostApplied;
        rec.reverse = reverse;
        rec.sentAt = nowMs;
        const applyArg = this._applyInputScratch;
        applyArg.thrust = thrust;
        applyArg.turnLeft = turnLeft;
        applyArg.turnRight = turnRight;
        applyArg.boost = boostApplied;
        applyArg.reverse = reverse;
        this.predWorld.applyInput(this.mirror.localPlayerId, applyArg);
        this.reconciler.recordInput(rec);
        // Idle-suppression — narrowed (2026-05-06): throttle ONLY when current
        // AND last-sent state are both fully idle (all-false). Why: when ANY
        // key is held, the server's worker queue stays populated and the
        // held-input branch never fires; if we throttled in that state, the
        // worker would synthesise an ack trail across held re-applications,
        // and a subsequent state-change message would jump the ack past the
        // intermediate synthesised ticks — skipping a tick of physics
        // application that the client's prediction DID apply locally. Result:
        // ~8 u of drift per release event on a fast-moving ship. The
        // all-idle restriction keeps throttling safe because held all-idle
        // adds zero impulse, so a skipped tick is physically equivalent.
        const last = this.lastSentInputState;
        const allIdle = !thrust && !turnLeft && !turnRight && !boostApplied && !reverse;
        const lastAllIdle = !!last && !last.thrust && !last.turnLeft && !last.turnRight && !last.boost && !last.reverse;
        const stateChanged = !last
          || last.thrust !== thrust
          || last.turnLeft !== turnLeft
          || last.turnRight !== turnRight
          || last.boost !== boostApplied
          || last.reverse !== reverse;
        const heartbeatDue = nowMs - this.lastSentInputAtMs >= INPUT_HEARTBEAT_MS;
        const throttle = allIdle && lastAllIdle && !stateChanged && !heartbeatDue;
        if (!throttle) {
          // Pooled send payload — colyseus.js serialises the literal
          // before returning so reusing the scratch ref is safe.
          const sendArg = this._sendInputScratch;
          sendArg.tick = tick;
          sendArg.thrust = thrust;
          sendArg.turnLeft = turnLeft;
          sendArg.turnRight = turnRight;
          sendArg.boost = boostApplied;
          sendArg.reverse = reverse;
          this.room.send('input', sendArg);
          // lastSentInputState retains state ACROSS ticks — must NOT
          // alias the per-tick scratch (would mutate the stored
          // last-state on the next tick). Reuse the existing record if
          // present (first-tick falls through to fresh alloc).
          const stored = this.lastSentInputState;
          if (stored) {
            stored.thrust = thrust;
            stored.turnLeft = turnLeft;
            stored.turnRight = turnRight;
            stored.boost = boostApplied;
            stored.reverse = reverse;
          } else {
            this.lastSentInputState = { thrust, turnLeft, turnRight, boost: boostApplied, reverse };
          }
          this.lastSentInputAtMs = nowMs;
          if ((stateChanged || (tick % 60) === 0) && isFullDiagMode()) {
            logEvent('inputSent', { tick, thrust, turnLeft, turnRight, boost: boostApplied, reverse });
          }
        }
        // Show the local exhaust trail without waiting an RTT for the server
        // to confirm — the next snapshot will overwrite from server truth.
        // Boost is now thrust-independent, so the trail shows whenever boost is
        // actually applied (energy-affordable), matching the server's
        // `boostingPlayers` membership + the predEnergy drain below.
        if (this.mirror.boostingShips) {
          if (boostApplied) this.mirror.boostingShips.add(this.mirror.localPlayerId);
          else this.mirror.boostingShips.delete(this.mirror.localPlayerId);
        }
        if (this.mirror.thrustingShips) {
          if (thrust) this.mirror.thrustingShips.add(this.mirror.localPlayerId);
          else this.mirror.thrustingShips.delete(this.mirror.localPlayerId);
        }
      }
      // Stage 3 — apply each remote ship's last-known input before advancing
      // physics, so remote bodies forward-predict in lockstep with the local
      // input loop. Bounded by STAGE_3_MAX_LOOKAHEAD_TICKS per snapshot;
      // remotes whose intent isn't tracking (3 consecutive corrections > 5 u)
      // skip this and integrate with damping only.
      this.applyRemoteInputs();
      // (Phase 3 AI tick now runs at the TOP of this iteration, before
      // applyInput, to match the server's "post-step state → AI" ordering.)
      // Always advance physics — remote ships and obstacles must keep moving even while dead.
      if (this.predWorld) {
        this.predWorld.tick(1 / 60);
        // Render-jitter-fix Phase 1: stamp wall-clock at this tick so
        // `updateMirror`'s dead-reckon term knows how stale the latest
        // predWorld pose is. All ticks within a single RAF's catch-up
        // burst share the same `clock.now()` — that's correct, because
        // they all happened at the same wall-clock instant; the
        // dead-reckon dt is 0 for the burst-final RAF and accumulates
        // only on subsequent 0-step RAFs.
        this._lastLocalTickAtMs = this.clock.now();
      }

      // Replay-grade per-tick predicted-pose capture (plan: replay infra
      // Phase A). After `applyInput` + `world.tick`, the local ship's
      // predWorld pose IS the prediction for this tick. The replay harness
      // re-runs the same predWorld through the same input stream and
      // compares against THIS value to confirm bit-identical simulation
      // (the ground-truth check that makes the harness a faithful
      // surrogate for on-device behaviour). Skip-safe when localDead /
      // pre-init: predWorld may not have a ship body yet.
      // HIGH_VOLUME_TAGS gate (Phase 5e — invariant #14). Skip the
      // predWorld read + object literal when not in diag mode.
      if (!this.localDead && this.predWorld && this.mirror.localPlayerId && isFullDiagMode()) {
        const _ps = this.predWorld.getShipState(this.mirror.localPlayerId);
        if (_ps) {
          logEvent('local_pose_predicted', {
            tick,
            x: Math.round(_ps.x * 1000) / 1000,
            y: Math.round(_ps.y * 1000) / 1000,
            vx: Math.round(_ps.vx * 1000) / 1000,
            vy: Math.round(_ps.vy * 1000) / 1000,
            angle: Math.round(_ps.angle * 10000) / 10000,
            angvel: _ps.angvel !== undefined ? Math.round(_ps.angvel * 10000) / 10000 : 0,
          });
        }
      }

      // Multi-mount/turret refactor (Phase 4b.2): client-side turret aim
      // update for the local ship. Runs every physics tick so the
      // rotation stays continuous and the beams emerge from the slewed
      // mount direction. Skipped while dead (no aim to compute) and when
      // the player has no predWorld state yet.
      this.tickLocalMountAim(1 / 60);

      // (Fire dispatch HOISTED out of this loop — see below. It gates on
      //  wall-clock cooldown so a stalled inputTick can't suppress fires
      //  the user feels they've earned. Loop body kept lean.)

      // beam-attach fix (capture pe6rdt): NO hard-clear when fire isn't
      // held. The local hitscan beam persists ~LIVE_BEAM_PERSIST_MS past
      // the last shot (expired in updateMirror) and is redrawn from
      // `mirror.ships` every frame, so a tap / held burst reads as ONE
      // continuous SHIP-ATTACHED beam — server lag/correction invisible.
      // Death still clears it via killEntity's liveBeams.clear().
    }

    // ── Fire dispatch (hoisted from the catch-up loop, 2026-05-27) ──
    //
    // PREVIOUSLY this lived INSIDE the `while (inputTick < targetTick)`
    // loop. When `deficitBefore` went negative (inputTick ≥ targetTick
    // — happens whenever the lookahead controller bumps `leadTicks`
    // or `clockAnchor` re-stabilises after a snapshot), the loop body
    // skipped entirely → fire dispatch skipped too → fires were silently
    // dropped on those RAFs. The smoke-test class: "if I hold the fire
    // button it doesn't refire when the cooldown ring shows ready, I
    // have to tap repeatedly." Diagnostic capture
    // `2026-05-27T16-33-40Z-r0r701` + E2E spec `held fire auto-refires…`
    // pinned it: 180-tick cooldown was taking 5-6 s wall-clock when
    // inputTick advanced at 30-50/sec.
    //
    // The fix has two parts:
    //   1. Run fire dispatch ONCE per RAF (here), not per inner loop
    //      iteration — independent of inputTick advancement.
    //   2. Gate on WALL-CLOCK cooldown (`cooldownMs`) so the user feels
    //      the catalogue's promised cooldown interval regardless of
    //      what inputTick is doing.
    //
    // Server compatibility: `PlayerFireResolver` rejects fires whose
    // `tick - lastFireClientTick < cooldownTicks` (tick-based rate
    // limit, still load-bearing for anti-spam). When the client's
    // wall-clock gate opens BEFORE inputTick has advanced by
    // `cooldownTicks`, we bump the `sendTick` to satisfy the server
    // check. This keeps the temporal-plausibility CLAMP (`clampFireTick`,
    // src/core/combat/fireTemporal.ts) happy too — futures still pass
    // through unchanged; we're just not waiting for inputTick to ratchet
    // up before honouring the player's held input.
    // fireHeld combines keyboard Space + touch FIRE button. Forgetting
    // the touch branch broke firing entirely on phone (the smoke-test
    // class that surfaced this hoist's regression — kb.fireHeld is
    // always false on touch devices).
    const manualFire = kb.fireHeld || (this.touchInput?.getFireHeld() ?? false);
    // Auto-fire (default ON): fire automatically at an in-range HOSTILE without
    // any input. Manual fire (Space / FIRE button) still works as an override.
    const autoFireEnabled = useUIStore.getState().autoFireEnabled;
    if ((manualFire || autoFireEnabled) && this.mirror.localPlayerId && !this.localDead && this.predWorld && this.room) {
      // Weapons/energy/AI overhaul (§5.2): the firing weapon is the active
      // SLOT's bound weapon, not a per-weapon picker. Slot cooldown = max
      // over the slot's mounts (mirrors the server gate); the energy gate
      // mirrors the server's so a depleted pool stops local ghost spam.
      const kindStr = this.mirror.ships.get(this.mirror.localPlayerId)?.kind ?? null;
      const localKind = getShipKind(kindStr);
      const activeSlotId = useUIStore.getState().activeSlotId;
      // Cache the slot weapon resolution by (kind, slot). Auto-fire evaluates
      // this block EVERY frame, and `resolveSlotMounts` allocates a small
      // array — recompute only when the kind or slot changes (invariant #14).
      if (this._afSlotKindKey !== kindStr || this._afSlotIdKey !== activeSlotId) {
        const slotMounts = resolveSlotMounts(localKind, activeSlotId);
        const weaponDef = getWeapon(slotMounts[0]?.weaponId ?? 'hitscan');
        let cd = 0;
        for (let i = 0; i < slotMounts.length; i++) {
          const c = getWeapon(slotMounts[i]!.weaponId).cooldownTicks;
          if (c > cd) cd = c;
        }
        this._afSlotWeaponDef = weaponDef;
        this._afSlotCooldownTicks = cd === 0 ? weaponDef.cooldownTicks : cd;
        this._afSlotKindKey = kindStr;
        this._afSlotIdKey = activeSlotId;
      }
      const slotWeaponDef = this._afSlotWeaponDef;
      const slotCooldownTicks = this._afSlotCooldownTicks;

      // Fire INTENT: manual override OR auto-fire when a HOSTILE drone is within
      // this weapon's auto-fire range. Scans the per-frame `_lastAimTargets`
      // (drone-only, kind=1 — never asteroids/structures) reading the carried
      // `isHostile` flag ⇒ allocation-free, no ledger lookup / id parsing
      // (invariant #14). `_lastAimTargets` may be ≤1 frame stale on a
      // zero-iteration RAF; the cooldown gate makes that harmless. Auto-fire
      // only decides WHEN to fire — the server stays the hit authority via its
      // own mount angles; turret aim/fire-target unification is Part C.
      let fireWanted = manualFire;
      if (!fireWanted && autoFireEnabled) {
        const st = this.predWorld.getShipState(this.mirror.localPlayerId);
        if (st) fireWanted = this.hasHostileInRange(st.x, st.y, weaponAutoFireRange(slotWeaponDef));
      }
      if (fireWanted) {
        if (slotWeaponDef.mode === 'hitscan') {
          this.updateLiveBeam();
        } else {
          // Projectile / missile has no continuous beam — clear so a
          // mid-hold slot switch can't leave a stale hitscan beam.
          this.mirror.liveBeams?.clear();
          this._lastHitscanFireMs = null;
        }
        const cooldownMs = (slotCooldownTicks * 1000) / 60;
        const nowMs = this.clock.now();
        // Use the Zustand-mirrored `lastFireMs` as the wall-clock anchor
        // — set by `sendFire`, cleared by `setActiveSlotId`, so a slot swap
        // implicitly resets the gate. First-fire short-circuits when null.
        const lastFireMs = useUIStore.getState().lastFireMs;
        const wallclockReady = lastFireMs === null || (nowMs - lastFireMs) >= cooldownMs;
        // Energy gate (predicted) — don't fire a ghost the server would reject.
        const energyReady = canAfford(this.predEnergy, resolveSlotEnergyCost(localKind, activeSlotId));
        if (wallclockReady && energyReady) {
          // Bump sendTick if inputTick hasn't yet caught up to the
          // server-side cooldown floor. This is the "give the player
          // their fire even if inputTick stalled" branch.
          const tickFloor = this.lastFiredAtTick + slotCooldownTicks;
          const sendTick = Math.max(this.inputTick, tickFloor);
          this.sendFire(sendTick);
          this.lastFiredAtTick = sendTick;
          if (slotWeaponDef.mode === 'hitscan') this._lastHitscanFireMs = this.clock.now();
        } else if (!energyReady && slotWeaponDef.mode === 'hitscan') {
          // Out of energy mid-hold: drop the continuous beam too.
          this.mirror.liveBeams?.clear();
          this._lastHitscanFireMs = null;
        }
      }
    }

    // Predict the energy pool for the frame (weapons/energy/AI overhaul
    // §3.2): regen every stepped tick + drain a boost tick while boosting,
    // mirroring the server's tickEnergy. Fire drain happens in sendFire. The
    // snapshot reconcile hard-sets the value, so this only smooths the bar
    // between snapshots. Scalar core helpers ⇒ no allocation.
    if (this.mirror.localPlayerId && stepsThisFrame > 0) {
      const ek = getShipKind(this.mirror.ships.get(this.mirror.localPlayerId)?.kind ?? null);
      const emax = ek.energyMax ?? 100;
      const eregen = ek.energyRegenRate ?? 0.25;
      const boosting = this.mirror.boostingShips?.has(this.mirror.localPlayerId) ?? false;
      for (let s = 0; s < stepsThisFrame; s++) {
        this.predEnergy = regenEnergyStep(this.predEnergy, emax, eregen);
        if (boosting) this.predEnergy = spendEnergy(this.predEnergy, BOOST_TICK_COST);
      }
    }

    // Sentinel input on zero-iteration cap-engaged RAFs (plan: spiral-fix,
    // Phase 2 step 3). When the cap stops the catch-up loop on its FIRST
    // check, no `inputSent` would fire — which is the 6e4d9c2 starvation
    // class. Sentinel keeps RAF-rate input flow alive (at 60 Hz that's
    // 60 `inputSent`/sec, well over `assertInputFlowMaintained`'s 30/sec
    // floor) and gives the server something fresh to ack. Server's
    // `tickInputQueue` handles same-tick re-applies (`max(entry.tick,
    // baseline)` — no ack regression, idempotent boolean re-apply).
    // Throttle replicates the in-loop idle-suppression to avoid spamming
    // the server with stale all-idle inputs.
    if (
      stepsThisFrame === 0
      && capEngaged
      && !this.localDead
      && this.predWorld
      && this.reconciler
      && this.mirror.localPlayerId
    ) {
      let tcThrust2 = false, tcTurnLeft2 = false, tcTurnRight2 = false, tcFire2 = false;
      if (this.touchInput) {
        tcFire2 = this.touchInput.getFireHeld();
        const v = this.touchInput.getJoystickVector();
        // Render-jitter-fix Phase 1: same rule as the in-loop joystick
        // read — hysteresis MUST track REAL-TIME predWorld angle, not
        // the dead-reckoned mirror angle.
        const predState = this.predWorld?.getShipState(this.mirror.localPlayerId) ?? null;
        const localShip = this.mirror.ships.get(this.mirror.localPlayerId);
        const realAngle = predState?.angle ?? localShip?.angle ?? null;
        if (realAngle !== null) {
          const next = joystickToInput(v, realAngle, this._joystickInputState);
          this._joystickInputState = next;
          tcTurnLeft2 = next.turnLeft;
          tcTurnRight2 = next.turnRight;
          tcThrust2 = next.thrust;
        }
      }
      const thrust    = kb.thrust    || tcThrust2;
      const turnLeft  = kb.turnLeft  || tcTurnLeft2;
      const turnRight = kb.turnRight || tcTurnRight2;
      // tcFire2 is sampled for parity with the in-loop block but the
      // sentinel never spawns a fire — fire is per-tick and we're not
      // advancing inputTick. Reading it (rather than dropping the var)
      // keeps the touch state machine consistent with the in-loop path.
      void tcFire2;
      const boost     = kb.boost || (this.touchInput?.getBoostHeld() ?? false);
      // Energy-gate boost identically to the per-tick path so the sentinel
      // re-send carries the same value the server will apply (and that the
      // per-tick path predicted) — keeps `lastSentInputState` consistent.
      const boostApplied = boost && canAfford(this.predEnergy, BOOST_TICK_COST);
      const reverse   = kb.reverse;
      const tick = this.inputTick; // NOT incremented; sentinel rides at the last-sent tick
      const nowMs = this.clock.now();
      const last = this.lastSentInputState;
      const allIdle = !thrust && !turnLeft && !turnRight && !boostApplied && !reverse;
      const lastAllIdle = !!last && !last.thrust && !last.turnLeft && !last.turnRight && !last.boost && !last.reverse;
      const stateChanged = !last
        || last.thrust !== thrust
        || last.turnLeft !== turnLeft
        || last.turnRight !== turnRight
        || last.boost !== boostApplied
        || last.reverse !== reverse;
      const heartbeatDue = nowMs - this.lastSentInputAtMs >= INPUT_HEARTBEAT_MS;
      const throttle = allIdle && lastAllIdle && !stateChanged && !heartbeatDue;
      if (!throttle) {
        // Pooled send payload — reuses the same scratch as the per-tick
        // path. cap-engaged sentinel fires at-most-once per RAF (60-120
        // /sec) so the alloc rate here is lower than the per-tick path,
        // but the pattern duplicates — keep the pool consistent.
        const sendArg = this._sendInputScratch;
        sendArg.tick = tick;
        sendArg.thrust = thrust;
        sendArg.turnLeft = turnLeft;
        sendArg.turnRight = turnRight;
        sendArg.boost = boostApplied;
        sendArg.reverse = reverse;
        this.room.send('input', sendArg);
        // lastSentInputState retains state across ticks — mutate in
        // place to avoid aliasing the per-tick scratch.
        const stored = this.lastSentInputState;
        if (stored) {
          stored.thrust = thrust;
          stored.turnLeft = turnLeft;
          stored.turnRight = turnRight;
          stored.boost = boostApplied;
          stored.reverse = reverse;
        } else {
          this.lastSentInputState = { thrust, turnLeft, turnRight, boost: boostApplied, reverse };
        }
        this.lastSentInputAtMs = nowMs;
        // Always log on sentinel send (no stateChanged / tick%60 gate) so
        // `assertInputFlowMaintained` sees the per-RAF cadence during a
        // sustained cap engagement — this is the explicit anti-regression
        // for the 6e4d9c2 class. Gated by full-diag-mode at the callsite
        // (Phase 5e — invariant #14); the assertion only runs under diag.
        if (isFullDiagMode()) {
          logEvent('inputSent', { tick, thrust, turnLeft, turnRight, boost: boostApplied, reverse });
        }
      }
    }

    // One ring-buffer entry per RAF — diagnostic + replay anchor data.
    // Plan: replay infra Phase A (2026-05-21) — UNSAMPLED. Was every 6th
    // RAF, now every frame. Deterministic replay requires the full clock
    // trajectory so the harness can reconstruct wall-clock timing
    // identically. Cost: ~60/s extra entries; accommodated by the
    // PROD_MAX_ENTRIES bump in ClientLogger.ts (25000). Added
    // `clockAnchorPerfNow` for replay-side time-base reconstruction.
    // HIGH_VOLUME_TAGS gate (Phase 5e — invariant #14). Fires per-RAF
    // (60-90 fps on a typical client). Object literal skipped in
    // production where logEvent would drop the entry anyway.
    if (isFullDiagMode()) {
      logEvent('rafTick', {
        elapsedMs: Math.round(elapsedMs * 100) / 100,
        targetTick,
        inputTick: this.inputTick,
        deficitBefore: tickDeficitBefore,
        stepsThisFrame,
        capped: stepsThisFrame >= MAX_CATCH_UP_TICKS && this.inputTick < targetTick,
        overPredictionCapped: capEngaged,
        anchorServerTick: this.clockAnchorServerTick,
        anchorPerfNow: Math.round(this.clockAnchorPerfNow * 100) / 100,
        leadTicks: this.leadTicks,
      });
    }
  }

  /**
   * Stores the hit distance for the live hitscan beam. The renderer reads the
   * shooter's current pose from `mirror.ships[localId]` (which already includes
   * any active reconciler lerp offsets) and projects forward by `dist` — so the
   * beam stays glued to the ship sprite frame-by-frame even during corrections.
   * The hitscan query itself runs against raw predWorld state, which is what
   * the server's lag-comp will validate against.
   */
  /**
   * Stage 3 — apply each remote ship's last-known input intent to predWorld
   * for one tick of forward-prediction. Called once per replay tick (from
   * Reconciler.reconcile's perReplayTick hook) and once per tickPhysics
   * input loop iteration.
   *
   * Two guards bound the speculation:
   *
   *   1. **Hysteresis** — `shouldForwardPredict` returns false for remotes
   *      whose last 3 corrections exceeded 5 u. Skipped remotes integrate
   *      with damping only (pre-Stage-3 behaviour).
   *   2. **Lookahead cap** — per-remote `_remoteForwardTicks` counter is
   *      reset on every snapshot. Once it hits STAGE_3_MAX_LOOKAHEAD_TICKS
   *      we stop applying input for that remote until the next snapshot.
   *      A long network stall otherwise would let speculation run away.
   */
  private applyRemoteInputs(): void {
    if (!this.predWorld) return;
    for (const remoteId of this.predRemoteShipIds) {
      const lastInput = this._remoteLastInputs.get(remoteId);
      if (!lastInput) continue;
      if (!shouldForwardPredict(this._predGuard, remoteId)) continue;
      const ticks = this._remoteForwardTicks.get(remoteId) ?? 0;
      if (ticks >= STAGE_3_MAX_LOOKAHEAD_TICKS) continue;
      this.predWorld.applyInput(remoteId, lastInput);
      this._remoteForwardTicks.set(remoteId, ticks + 1);
    }
  }

  /**
   * Multi-mount/turret refactor (Phase 4b.2): client-side rotation preview
   * for the local player's mounts.
   *
   * Each tick (called from `tickPhysics` after `applyInput` but before the
   * fire dispatch), this:
   *
   *   1. Filters the swarm mirror down to drone targets (kind === 1).
   *   2. Calls `WeaponMountController.pickTarget` with `_localSlotTarget`
   *      as the sticky pin — same module the drone AI uses, same sticky
   *      hysteresis policy.
   *   3. For each mount in the local ship's active slot, computes the
   *      desired bearing (target-relative to ship-forward, minus
   *      `mount.baseAngle` so the bearing is expressed in the mount's
   *      arc-local frame) and slews the cached angle via
   *      `rotateMountToward`.
   *   4. Writes the new angles back to `mirror.ships.get(localId)
   *      .mountAngles`.
   *
   * 4b.2 is **client-only** — the server doesn't yet compute or anchor
   * mount angles, so the visible rotation is presentation. Other clients
   * see this player's barrels at `baseAngle` until 4b.3 ships the
   * snapshot extension that broadcasts the authoritative angles.
   *
   * Hostility: every drone in the mirror is a candidate (the player has
   * no individualised hostility set). Future PvP would require a richer
   * filter; for solo combat "any drone, nearest one" is the right model.
   */
  /**
   * Auto-fire predicate: is any HOSTILE drone within `range` of (x, y)?
   * Allocation-free scan over the per-frame `_lastAimTargets` (drone-only,
   * kind=1), reading the carried `isHostile` flag and a squared-distance
   * compare (no sqrt) — safe for the per-frame fire-decision hot path
   * (invariant #14). Returns false when auto-fire should hold (no hostile in
   * reach) so the ship doesn't auto-engage neutral ambient drones or waste the
   * energy pool. Drone-vs-drone hit authority stays server-side.
   */
  private hasHostileInRange(x: number, y: number, range: number): boolean {
    const r2 = range * range;
    const targets = this._lastAimTargets;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      if (!t.hostile) continue;
      const dx = t.x - x;
      const dy = t.y - y;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }

  private tickLocalMountAim(dtSec: number): void {
    const localId = this.mirror.localPlayerId;
    if (!localId || !this.predWorld) return;
    const ship = this.mirror.ships.get(localId);
    if (!ship) return;
    const state = this.predWorld.getShipState(localId);
    if (!state) return;
    // `mountAngles` is CATALOGUE-indexed everywhere it is READ (the
    // renderer beam direction + the turret sprites). Size + write the
    // array by the FULL kind.mounts; only the ACTIVE SLOT's mounts aim
    // (the rest slew to base). Indexing by the active-slot order instead
    // is the latent index bug — see combat/localMountAim.ts.
    const catalogueMounts = getShipKind(ship.kind ?? null).mounts ?? [];
    if (catalogueMounts.length === 0) {
      if (ship.mountAngles) ship.mountAngles = undefined;
      return;
    }
    // Active-slot mount ids — reused scratch set (alloc-free, invariant #14).
    const activeMountIds = this._activeMountIdsScratch;
    activeMountIds.clear();
    for (const m of this.localShipMounts()) activeMountIds.add(m.id);

    // Gather drone auto-aim targets from the SINGLE per-frame display
    // pose. `buildLocalAimTargets` reads the pose `updateMirror` already
    // resolved into `entry.x/y` (the one `interpolateSwarmPose` per
    // frame; the same value the sprite + predWorld collision body + laser
    // beam use) — it does NOT re-interpolate. tickLocalMountAim runs in
    // tickPhysics, *earlier* in the frame than updateMirror/the renderer;
    // re-interpolating here resolved the pose at a different `now` than
    // the frame's single resolution, so the turret aimed where the drone
    // *wasn't drawn* and the beam jittered against the sprite ("two
    // things fighting"; capture jfagww). Reading the one written pose
    // makes aim == draw == collide by construction (≤1-frame smooth
    // lead-lag, never per-frame jitter). 0e24448's "aim the drawn pose,
    // not the raw/ahead one" guarantee is preserved — updateMirror wrote
    // the display-delayed pose there.
    const targets = this.mirror.swarm
      ? buildLocalAimTargets(this.mirror.swarm, this._aimInterpScratch)
      : [];
    // Cache the (drone-only, kind=1) target list so the once-per-RAF fire
    // block can reuse it for the auto-fire pick without a second build/alloc
    // (invariant #14). buildLocalAimTargets already runs each aim tick.
    this._lastAimTargets = targets;

    // Part C — hostile-only, health-weighted, commitment-sticky aim so the
    // turret tracks (and the beam hits) the wounded hostile the auto-fire is
    // engaging. Targets carry their own `hostile` + `health` (LocalAimTarget),
    // so the callback is never consulted (pickTarget reads `t.hostile`) — the
    // single-viewer alloc-free path. Options + the hostility VALUES match the
    // server's `WeaponMountTicker.tickPlayer` (shared PLAYER_AIM_* constants +
    // the synced markHostile ledger / drone-hp), keeping the predicted beam and
    // the authoritative mount angle in lockstep (Invariant #12). Out-of-range /
    // no-hostile ⇒ null ⇒ mounts slew back to forward.
    // Pick + aim from the RENDERED (mirror) pose the beam is DRAWN from
    // (`ship.x/y/angle`), NOT the predicted pose (`state.*`). The predWorld
    // body is kept as the hitscan collision world (the `state` guard above),
    // but its pose lags the mirror by the reconciler lerp offset (up to
    // ~0.5 rad mid-turn), so aiming the turret from it leaks that offset
    // into the beam direction — the secondary laser-detach cause (on-device
    // smoke handoff 2026-06-06, Issue 1 Bug #2). Locked by
    // ColyseusClient.liveBeamMountAimPose.test.ts.
    const target = pickTarget(
      ship.x, ship.y, targets, this._localSlotTarget, LOCAL_AIM_NOOP_HOSTILE, LOCAL_AIM_OPTS,
    );
    this._localSlotTarget = target?.id ?? null;

    // Allocate / resize the per-ship mountAngles array to the FULL
    // catalogue length (the index space every reader uses). number[] is
    // fine — N is small (1–3) and the array survives multiple frames.
    let angles = ship.mountAngles;
    if (!angles || angles.length !== catalogueMounts.length) {
      angles = new Array<number>(catalogueMounts.length).fill(0);
      ship.mountAngles = angles;
    }

    // Slew each catalogue mount: the active-slot mounts aim at the target,
    // the rest return to base. Catalogue-indexed write — see
    // combat/localMountAim.ts for the index-space contract.
    tickLocalMountAngles(
      angles, catalogueMounts, activeMountIds, target,
      ship.x, ship.y, ship.angle, dtSec,
    );
  }

  /** Compute (and cache in `mirror.liveBeams`) the local player's hitscan
   *  beam state — one entry per mount in the firing slot. Multi-mount/turret
   *  refactor (Phase 2c): replaces the pre-2c single `liveBeam` write. For
   *  legacy single-mount ships the map has exactly one entry keyed by
   *  `'forward'`; multi-mount kinds (interceptor / gunship, Phase 3) get one
   *  entry per barrel so each renders independently.
   *
   *  Mount origin = `ship.pos + rotate(mount.local, ship.angle)`. Mount fire
   *  direction = `ship.angle + mount.baseAngle + currentMountAngle` (4b.2
   *  adds rotation; pre-4b.2 the current angle was always 0). The 20 u
   *  barrel offset is applied along the mount's world fire direction. */
  private updateLiveBeam(): void {
    const localId = this.mirror.localPlayerId;
    if (!localId || !this.predWorld) return;
    // Cast the visual beam from the SAME rendered (mirror) pose the
    // renderer draws it from (PixiRenderer `applyMountOffset(ship.x/y/angle)`
    // + `mirror.liveBeams[mount].dist`), NOT the raw predWorld pose. The
    // predicted pose lags the mirror by the reconciler lerp offset (up to
    // ~45 u during a correction), so casting `dist` from predWorld made it
    // belong to a different ray than the one drawn — the far endpoint
    // popped frame-to-frame (laser detach/jitter; on-device capture
    // 2026-06-02T15-04-54Z-e628gi). Locked by
    // ColyseusClient.liveBeamPose.test.ts.
    const ship = this.mirror.ships.get(localId);
    // The predWorld body is the collision world the ray is cast INTO; it
    // must still exist, but its POSE is not used for the beam geometry.
    if (!ship || !this.predWorld.getShipState(localId)) return;

    const liveBeams = (this.mirror.liveBeams ??= new Map());
    const mounts = this.localShipMounts();
    if (mounts.length === 0) {
      // Defensive: ship-kind has no mounts. Clear any stale beams.
      liveBeams.clear();
      return;
    }

    // ?nohitscan=1 — A/B switch to bypass the per-mount-per-frame Rapier
    // ray cast against predWorld. Beam length defaults to full
    // HITSCAN_RANGE (beams visually shoot through everything). The
    // hitscan is suspected of being a non-trivial per-frame cost under
    // heavy combat (35 drones × 1 cast against 40+ bodies). PURE
    // VISUAL test; server-authoritative hit resolution is unaffected.
    const skipHitscan = ColyseusGameClient.SKIP_HITSCAN_VISUAL_FLAG;

    // Drop entries for mounts no longer present (e.g. ship-kind changed
    // mid-life — currently impossible but cheap to guard).
    const mountIds = this._liveBeamMountIdsScratch;
    mountIds.clear();
    for (const m of mounts) mountIds.add(m.id);
    for (const id of liveBeams.keys()) if (!mountIds.has(id)) liveBeams.delete(id);

    const cosA = Math.cos(ship.angle);
    const sinA = Math.sin(ship.angle);
    const mountAngles = ship.mountAngles;
    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]!;
      const mountWorldX = ship.x + (mount.localX * cosA - mount.localY * sinA);
      const mountWorldY = ship.y + (mount.localX * sinA + mount.localY * cosA);
      const currentMountAngle = mountAngles?.[i] ?? 0;
      const mountAngle = ship.angle + mount.baseAngle + currentMountAngle;
      const fwdX = -Math.sin(mountAngle);
      const fwdY = Math.cos(mountAngle);
      const fromX = mountWorldX + fwdX * 20;
      const fromY = mountWorldY + fwdY * 20;
      const hit = skipHitscan ? null : this.predWorld.hitscan(fromX, fromY, fwdX, fwdY, HITSCAN_RANGE, localId);
      // `?probe=ghost` diagnostic (laser "ghost at (0,0)" investigation,
      // 2026-06-03). When the beam stops on a body whose pose is within
      // ε of world origin, log the hitId — its namespace prefix names the
      // culprit class (`linger-`/`swarm-`/`wreck-`/raw playerId). Gate is
      // cached + webdriver-OFF, so production / E2E / netgate allocate
      // nothing here; the object literal is only built on a rare actual
      // origin-hit while the probe is on. Confirms the lingering-hull fix
      // on-device (and would surface any OTHER origin-body path).
      if (isGhostProbeEnabled() && hit) {
        const hitPose = this.predWorld.getShipState(hit.hitId);
        if (hitPose && Math.abs(hitPose.x) < 2 && Math.abs(hitPose.y) < 2) {
          logEvent('beam_hit_origin', { hitId: hit.hitId, x: hitPose.x, y: hitPose.y });
        }
      }
      liveBeams.set(mount.id, {
        dist: hit ? this.shieldEdgeDist(hit, fromX, fromY, fwdX, fwdY) : HITSCAN_RANGE,
        hitId: hit?.hitId,
      });
    }
  }

  /**
   * Snap the visible beam endpoint to the rendered SHIELD ring when the
   * ray stops on a shield-up target (2026-06-03). The shield collider IS
   * `targetRadius + SHIELD_RADIUS_PAD` — the same radius the cyan aura is
   * drawn at — but the predWorld collider can lag the shield by one
   * physics step right after a shield 0-cross or a drone's first
   * in-interest tick (Rapier query-pipeline lag), so the raw
   * `timeOfImpact` makes the endpoint pop slightly off the aura edge.
   * Recomputing the distance to the shield sphere ANALYTICALLY guarantees
   * the beam terminates exactly on the ring. Returns the predWorld dist
   * unchanged for a shield-DOWN/hull hit, an asteroid, or a miss.
   * Allocation-free — `rayHitsSphere` is pure scalar (Invariant #14).
   */
  private shieldEdgeDist(
    hit: { hitId: string; dist: number },
    fromX: number, fromY: number, fwdX: number, fwdY: number,
  ): number {
    const hitId = hit.hitId;
    if (hitId.startsWith('swarm-')) {
      const sw = this.mirror.swarm?.get(Number(hitId.slice(6)));
      // Drones only (kind===1); asteroids (kind===0) have no shield.
      if (sw && sw.kind === 1 && sw.shieldDown !== true) {
        const d = rayHitsSphere(fromX, fromY, fwdX, fwdY, HITSCAN_RANGE, sw.x, sw.y, sw.radius + SHIELD_RADIUS_PAD);
        if (d !== null) return d;
      }
      return hit.dist;
    }
    const ship = this.mirror.ships.get(hitId);
    if (ship && ship.shieldDown !== true) {
      const r = getShipKind(ship.kind ?? null).radius + SHIELD_RADIUS_PAD;
      const d = rayHitsSphere(fromX, fromY, fwdX, fwdY, HITSCAN_RANGE, ship.x, ship.y, r);
      if (d !== null) return d;
    }
    return hit.dist;
  }

  /** Resolve the local player's currently-active slot's mount list. Returns
   *  the first slot's mounts when no `slotId` is in play (today's only path;
   *  multi-slot UI lands in a future phase). Empty array if the ship-kind
   *  has no mounts/slots or the local player hasn't joined yet. */
  private localShipMounts(): ReadonlyArray<WeaponMount> {
    const localId = this.mirror.localPlayerId;
    if (!localId) return [];
    const kindId = this.mirror.ships.get(localId)?.kind ?? null;
    // Active-slot mounts (weapons/energy/AI overhaul §5.2). The pilot selects
    // the slot; the server fires each mount's bound weapon. Same shared
    // resolver the server uses so client ghost geometry matches.
    return resolveSlotMounts(getShipKind(kindId), useUIStore.getState().activeSlotId);
  }

  /**
   * Test-only fire trigger. Sets `activeWeapon` in Zustand and calls
   * `sendFire(inputTick)` directly, sidestepping the keyboard event
   * pipeline AND the wall-clock-anchored catch-up loop's fire
   * dispatch (ColyseusClient.ts:3051, which is silently skipped when
   * `inputTick > targetTick` — a Playwright headless quirk that
   * blocks every heat-seeker fire in the E2E spec).
   *
   * DEV-only — exposed on `window.__eqxClient` so E2E specs can call
   * `__eqxClient.triggerFireForTest('heat-seeker')`. Production tree-
   * shakes the App.tsx assignment that exposes the client.
   *
   * Returns `true` if `sendFire` ran (predWorld + ship + room present),
   * `false` if it bailed early. The test asserts the return value AND
   * polls `/dev/events` for `missile_spawned` to confirm the round-trip.
   */
  /** Current predicted energy pool for the local ship (weapons/energy/AI
   *  overhaul §3.2). Read per-frame by the top-center `<EnergyBar />` RAF
   *  loop + direct-DOM write — never via Zustand (it changes every frame). */
  public getPredictedEnergy(): number {
    return this.predEnergy;
  }

  public triggerFireForTest(weaponId: 'hitscan' | 'laser' | 'heat-seeker'): boolean {
    // Post weapons/energy/AI overhaul the weapon is bound to the ship's
    // loadout (the server ignores any claimed weapon), so `weaponId` no
    // longer selects — the spec must spawn the matching ship-kind. Kept in
    // the signature for back-compat with existing E2E call sites.
    void weaponId;
    const localId = this.mirror.localPlayerId;
    if (!localId || !this.predWorld || !this.room) return false;
    if (!this.predWorld.getShipState(localId)) return false;
    this.sendFire(this.inputTick);
    this.lastFiredAtTick = this.inputTick;
    // Drive the same continuous-beam visual the per-RAF fire dispatch does
    // for a hitscan loadout — `sendFire` alone only spawns the projectile
    // ghost (by design), so without this a beam ship's test never sees
    // `data-beam-active`. Projectile/missile loadouts are unaffected.
    const mounts = this.localShipMounts();
    if (getWeapon(mounts[0]?.weaponId ?? 'hitscan').mode === 'hitscan') {
      this._lastHitscanFireMs = this.clock.now();
      this.updateLiveBeam();
    }
    return true;
  }

  private sendFire(tick: number): void {
    const localId = this.mirror.localPlayerId;
    if (!localId || !this.predWorld || !this.room) return;
    const state = this.predWorld.getShipState(localId);
    if (!state) return;
    const activeSlotId = useUIStore.getState().activeSlotId;
    const shotId = nextShotId();

    // Multi-mount/turret refactor (Phase 3 fix-up): spawn one ghost per mount
    // in the active slot, at each mount's world origin. Pre-fix the single
    // ghost spawned at `state.x/y + 20 u forward` rendered a third visual
    // between the two wing beams on the interceptor (and similarly between
    // the gunship's fore/aft mounts) because the ghost sat at the ship
    // centre rather than at the firing barrel. All N ghosts share one wire
    // `clientShotId` (shotGroup) so the single `hit_ack` fades the whole
    // salvo together.
    const mounts = this.localShipMounts();
    // Each barrel fires its catalogue-bound weapon (slots are homogeneous
    // today, so the first mount's weapon sets the salvo's ghost sprite + the
    // hitscan/projectile branch). Replaces the removed client weapon picker.
    const slotWeapon = mounts[0]?.weaponId ?? 'hitscan';
    const cosA = Math.cos(state.angle);
    const sinA = Math.sin(state.angle);
    const localShip = this.mirror.ships.get(localId);
    const mountAngles = localShip?.mountAngles;
    // weapon-hit-prediction Phase 2 — collect each mount's fire ray
    // (identical geometry to the ghost spawn) so the predicted-hit
    // resolver can aggregate the closest mount-hit, exactly as the server
    // aggregates its hit_ack.
    const mountGeom: MountFireGeom[] = [];
    // beam-attach fix (capture 2026-05-19T10-55-36-274Z-pe6rdt): a LOCAL
    // hitscan fire spawns NO ghost. The continuous liveBeam — recomputed
    // from the ship's RENDERED pose (`mirror.ships`) every frame — is the
    // sole local hitscan visual, so it is rigidly ship-attached and
    // server lag/correction is invisible. A ghost frozen at this
    // input-tick `predWorld` sample is the redundant layer that visibly
    // detached from the ship under lag. Projectiles still ghost — the
    // bolt actually travels. `mountGeom` is collected regardless (the
    // predicted-hit resolver still needs every mount's ray).
    const spawnGhost = localFireSpawnsGhost(getWeapon(slotWeapon).mode);
    if (mounts.length === 0) {
      // Defensive fallback: no mounts → (projectile only) spawn the
      // legacy single ghost at ship centre. Should not happen for any
      // shipped kind today.
      const fwdX = -Math.sin(state.angle);
      const fwdY = Math.cos(state.angle);
      const fromX = state.x + fwdX * 20;
      const fromY = state.y + fwdY * 20;
      if (spawnGhost) {
        this.ghostManager.spawn(shotId, localId, fromX, fromY, fwdX, fwdY, slotWeapon, state.vx, state.vy);
      }
      mountGeom.push({ fromX, fromY, fwdX, fwdY });
    } else {
      for (let i = 0; i < mounts.length; i++) {
        const mount = mounts[i]!;
        const mountWorldX = state.x + (mount.localX * cosA - mount.localY * sinA);
        const mountWorldY = state.y + (mount.localX * sinA + mount.localY * cosA);
        // Phase 4b.2: include the per-mount slewed angle in the fire
        // direction so the ghost emerges in the same direction the
        // visible barrel is aimed.
        const currentMountAngle = mountAngles?.[i] ?? 0;
        const mountFireAngle = state.angle + mount.baseAngle + currentMountAngle;
        const fwdX = -Math.sin(mountFireAngle);
        const fwdY = Math.cos(mountFireAngle);
        const fromX = mountWorldX + fwdX * 20;
        const fromY = mountWorldY + fwdY * 20;
        if (spawnGhost) {
          this.ghostManager.spawn(
            shotId,
            localId,
            fromX,
            fromY,
            fwdX,
            fwdY,
            mount.weaponId,
            state.vx,
            state.vy,
            mount.id,
          );
        }
        mountGeom.push({ fromX, fromY, fwdX, fwdY });
      }
    }

    this.room.send('fire', {
      type: 'fire',
      tick,
      clientShotId: shotId,
      weapon: slotWeapon,
      slotId: activeSlotId,
      dirAngle: state.angle,
    });

    // Predict the slot's energy drain (weapons/energy/AI overhaul §3.2):
    // drain ONCE per trigger (not per mount), matching the server. The
    // snapshot reconcile hard-sets predEnergy each frame, so a small
    // mispredict is invisible.
    this.predEnergy = spendEnergy(
      this.predEnergy,
      resolveSlotEnergyCost(getShipKind(this.mirror.ships.get(localId)?.kind ?? null), activeSlotId),
    );

    // Stamp the wall-clock fire time into Zustand so the fire-button
    // cooldown ring (`<FireCooldownRing />`) can compute progress.
    // Low-cadence — at most every cooldown interval (167 ms hitscan to
    // 3 s heat-seeker) — so the Zustand notification cost is bounded.
    useUIStore.getState().setLastFireMs(this.clock.now());

    // weapon-hit-prediction Phase 2 — predict the outcome against the pose
    // the player SEES (predWorld.hitscan, the exact seam updateLiveBeam
    // uses; NO client lag-comp ring) and show immediate tagged feedback.
    // Presentation-only: the server stays 100% hit-authoritative. The
    // prediction just TTL-expires until Phase 3 wires the single
    // hit_ack/DamageEvent reconcile path. Mode/damage read off the
    // catalogue def (no weapon-id branch). Projectile uses the same ray as
    // a straight-flight proxy for the predicted target (decision #2: the
    // bolt itself is untouched and reconciles via the eventual DamageEvent).
    const weaponDef = getWeapon(slotWeapon);
    const predMaxDist =
      weaponDef.mode === 'hitscan'
        ? HITSCAN_RANGE
        : weaponDef.mode === 'projectile'
          ? (weaponDef.speed * weaponDef.maxTicks) / 60
          : (weaponDef.speed * weaponDef.lifetimeTicks) / 60;
    // Smooth-beam visual splitting (2026-05-22). Hitscan: split the
    // predicted damage into N small ticks spread across the cooldown
    // window so the on-screen damage feels continuous; server stays at
    // the original cadence so wire load is unchanged. Projectile keeps
    // the single-spawn behaviour — its bolt is its own visual stream.
    // Splits share one `clientShotId` so cancelByTag /
    // reconcileDamageToFeedback wipe them together on misprediction.
    const isHitscan = weaponDef.mode === 'hitscan';
    const SMOOTH_BEAM_SPLITS = 5;
    const splitIntervalMs = isHitscan
      ? (weaponDef.cooldownTicks / 60) * 1000 / SMOOTH_BEAM_SPLITS
      : 0;
    const scheduledRef = this._scheduledDamageSpawns;
    const clockNow = this.clock.now();
    const predSink: PredictedFeedbackSink = {
      pushDamageNumber: (targetId, x, y, damage, tag) => {
        if (!isHitscan || damage <= 0) {
          this.mirror.pendingDamageNumbers?.push({ targetId, x, y, damage, tag });
          // Probe 4 (mobile-perf-investigation, 2026-05-24) — replaced the
          // five-events-at-the-same-ts pattern with one event per shot
          // (schedule) + one event per actual spawn (damage_number_spawned
          // in the drain). `count: 1` here distinguishes the
          // single-spawn projectile/no-damage path from the hitscan
          // split path below.
          logEvent('damage_number_scheduled', {
            tag,
            totalDamage: damage,
            count: 1,
            intervalMs: 0,
            firstSpawnImmediate: true,
          });
          return;
        }
        // Hitscan: schedule N visual ticks. Floor-divide the damage,
        // put the remainder on the last tick so the cumulative shown
        // matches the authoritative damage exactly (reconcile/suppress
        // can then match cleanly).
        const base = Math.floor(damage / SMOOTH_BEAM_SPLITS);
        const remainder = damage - base * SMOOTH_BEAM_SPLITS;
        let actualCount = 0;
        for (let i = 0; i < SMOOTH_BEAM_SPLITS; i++) {
          const tickDamage = i === SMOOTH_BEAM_SPLITS - 1 ? base + remainder : base;
          if (tickDamage <= 0) continue;
          actualCount++;
          if (i === 0) {
            // First tick spawns immediately so the player feels the
            // first hit without any latency.
            this.mirror.pendingDamageNumbers?.push({ targetId, x, y, damage: tickDamage, tag });
          } else {
            scheduledRef.push({
              atMs: clockNow + i * splitIntervalMs,
              targetId,
              x, y,
              damage: tickDamage,
              tag,
            });
          }
        }
        // Single per-shot event — the count vs actual `damage_number_spawned`
        // count diff (with `cancelled` subtracted) reveals dropped spawns,
        // which would explain the user-reported "damage applying
        // inconsistently".
        logEvent('damage_number_scheduled', {
          tag,
          totalDamage: damage,
          count: actualCount,
          intervalMs: parseFloat(splitIntervalMs.toFixed(2)),
          firstSpawnImmediate: true,
        });
      },
      flashTarget: (id) => {
        this._damageFlashFrames.set(id, 6);
      },
    };
    predictShotOutcome({
      ledger: this._hitLedger,
      sink: predSink,
      world: this.predWorld,
      clientShotId: shotId,
      mode: weaponDef.mode,
      damage: weaponDef.damage,
      mounts: mountGeom,
      maxDist: predMaxDist,
      excludeId: localId,
      nowMs: this.clock.now(),
    });
    // Diagnostic — captures the three reference points needed to debug
    // "lasers firing from the wrong place". `spawnPos` is the legacy
    // ship-centre+20-u-forward reference (NOT per-mount post-Phase-3, so
    // the diagnostic stays comparable across single-mount and multi-mount
    // ships); per-mount geometry is reconstructable from `predState` + the
    // ship-kind catalogue if a capture needs it. The visible ship is
    // rendered from `mirror.ships[localId]` which DOES include the
    // reconciler's lerp offset, so `predState` vs `mirrorPose` shows the
    // current divergence. The server's lag-comp validates the shot against
    // the SnapshotRing pose at `tick`, captured in `fire_received`.
    const mirrorPose = this.mirror.ships.get(localId);
    const lerpOff = this.reconciler?.lerpOffset;
    const lerpAng = this.reconciler?.lerpAngleOffset ?? 0;
    const legacyFwdX = -Math.sin(state.angle);
    const legacyFwdY = Math.cos(state.angle);
    logEvent('fire', {
      tick,
      shotId,
      weapon: slotWeapon,
      mountCount: mounts.length,
      predState: {
        x: parseFloat(state.x.toFixed(3)),
        y: parseFloat(state.y.toFixed(3)),
        angle: parseFloat(state.angle.toFixed(4)),
      },
      mirrorPose: mirrorPose ? {
        x: parseFloat(mirrorPose.x.toFixed(3)),
        y: parseFloat(mirrorPose.y.toFixed(3)),
        angle: parseFloat(mirrorPose.angle.toFixed(4)),
      } : null,
      lerpOffset: lerpOff ? {
        x: parseFloat(lerpOff.x.toFixed(3)),
        y: parseFloat(lerpOff.y.toFixed(3)),
        angle: parseFloat(lerpAng.toFixed(4)),
      } : null,
      spawnPos: {
        x: parseFloat((state.x + legacyFwdX * 20).toFixed(3)),
        y: parseFloat((state.y + legacyFwdY * 20).toFixed(3)),
      },
      lerping: this.reconciler?.isLerping ?? false,
    });
  }

  /**
   * Plan: crispy-kazoo, Commit 6 — reflection-based mirror clear.
   *
   * Walks every property on `mirror` and clears Maps / Sets / Arrays
   * generically. The plan's prophylactic against future mirror
   * additions: adding a new field to `RenderMirror` does NOT require
   * touching dispose — the walk picks it up automatically. The
   * disposeAudit test populates every field with a sentinel value
   * and asserts they're empty post-dispose.
   */
  private clearMirror(): void {
    const m = this.mirror as unknown as Record<string, unknown>;
    for (const k of Object.keys(m)) {
      const v = m[k];
      if (v instanceof Map) v.clear();
      else if (v instanceof Set) v.clear();
      else if (Array.isArray(v)) v.length = 0;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.localDead = false;
    this.diedAtMs = 0;
    useUIStore.getState().setDead(false);
    this.keyboard = null;
    this.touchInput = null;
    // Phase 4 swift-otter — close the DC transport BEFORE the room leave
    // so the PeerConnection's signaling channel is shut down before the
    // WS closes. In React 18 StrictMode dev mode the useEffect cleanup
    // → re-mount cycle was creating two ColyseusClients per page load,
    // each with its own DataChannelTransport / PeerConnection. The
    // first instance's PC stayed open (the original dispose() didn't
    // touch it) and continued receiving the brief window of snapshots
    // that landed between its DC opening and the WS-level room.leave()
    // taking effect on the server — those snapshots logged with via=dc
    // alongside the second instance's, and any tick races between the
    // two receivers' `_lastSeenServerTick` produced `snap_dropped_old`
    // events the test surfaced as the integration bug.
    if (this._dataChannelTransport) {
      this._dataChannelTransport.close('client-dispose');
      this._dataChannelTransport = null;
    }
    this.room?.leave();
    this.room = null;

    // Plan: crispy-kazoo, Commit 6 — subsystem disposes.
    // The pre-Commit-6 dispose covered ~14 fields and missed 20+
    // surfaces, which is the proximate cascade-trigger root cause: a
    // stale ColyseusGameClient retained via uncleared subscriptions /
    // timers / Maps. Each subsystem's dispose is idempotent.
    this.snapshotCoalescer.dispose();
    this.transitInstr.dispose();
    this.rafStallDetector.dispose();
    this.hudDispatcher.dispose();
    this.ghostManager.dispose();
    this._aiController.clear();

    this.predWorld?.dispose();
    this.predWorld = null;
    this.reconciler = null;
    this.remoteHistory.clear();
    this.predRemoteShipIds.clear();
    this._remoteShipOffsets.clear();
    this.predSwarmKeys.clear();

    // Maps + sets on the client itself (combat surfaces).
    this._damageFlashFrames.clear();
    this._scheduledDamageSpawns.length = 0;

    // Reflection-based clear: every Map / Set / Array on `mirror` empties.
    this.clearMirror();

    // Stats + per-connection accumulators — reset to freshly-constructed
    // (non-nullable types) so a re-mount sees a clean baseline.
    this._rttWelford = createWelford();
    this._lookaheadCtrl = createLookaheadController(6);
    this._dropDetector = createDropDetector();
    this._anchorInitialised = false;
    this._localPoseResolvedLogged = false;
    this.lastSentInputAtMs = 0;
    this.lastSentInputState = null;

    // Audio reference released — GameSurface owns the lifecycle.
    this.audio = null;

    ColyseusGameClient._liveInstanceN = Math.max(0, ColyseusGameClient._liveInstanceN - 1);
    logEvent('dispose_complete', {
      liveInstanceN: ColyseusGameClient._liveInstanceN,
      mirrorShipsRemaining: this.mirror.ships.size,
      mirrorSwarmRemaining: this.mirror.swarm?.size ?? 0,
    });
  }
}
