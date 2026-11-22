import { StructureRowSync } from './mirror/structureRowSync.js';
import {
  STRUCTURE_TARGET_NONE,
  decodePlayerTurretTarget,
  MOUNT_ANGLE_QUANTUM,
  forEachStructureMountAngles,
} from '../../shared-types/structureStateWire.js';
import type { BeamLinkVisitor } from '../../shared-types/beamLinksWire.js';
import { TractorLinkClient } from './tractorLinks.js';
import { Client, Room } from 'colyseus.js';
import type { RenderMirror, ShipRenderState, StructureRenderState } from '@core/contracts/IRenderer';
import type { IAudio } from '@core/contracts/IAudio';
import { REAL_CLOCK, type Clock } from '@core/clock/Clock';
import { GameClock } from '@core/clock/GameClock';
import { glideToward } from '@shared-types/timeScale';
import type { SnapshotMessage, DamageEvent, DestroyEvent, RespawnAckMessage, ShieldEventMessage } from '@shared-types/messages';
import { depositReadout } from '@shared-types/messages/snapshotMessages';
/** RTS slice 6a: the fleet command messages `sendFleetCommand` dispatches. */
export type { FleetCommandMessage } from './connection/roomCommands.js';
import { PhysicsWorld, type ShipPhysicsState } from '@core/physics/World';
import type { PadForceField } from '@core/physics/forceFields';
import { decideStatAllocReanchor } from './localStatAlloc';
import { visitDerivedWalls, type DerivedWallVisitor } from '../structures/derivedWalls.js';
import { PAD_SPECS, TP_PHASE, isTeleporterKind } from '../../shared-types/teleport.js';

/** v4 T2 — prediction-world pad field ids, cached per structure (no per-sync string). */
const PAD_FIELD_IDS = new Map<number, string>();
function padFieldId(id: number): string {
  let s = PAD_FIELD_IDS.get(id);
  if (s === undefined) { s = `tpfield-${id}`; PAD_FIELD_IDS.set(id, s); }
  return s;
}
import { pointSegmentDistance, wantPredBody } from '../structures/predStructureStreaming.js';
import { Reconciler, type InputRecord } from '@core/prediction/Reconciler';
import {
  createCollisionGuard,
  type CollisionGuardState,
} from './applyCollisionResolved';
import type { ShellEnd } from '@shared-types/messages/shellEvents';
import { ShellSalvoStore } from './shellSalvoStore';
import { NavalHitHold, type HeldDamage } from './navalHitHold';
import { DrawnShellTiming } from './drawnShellTiming';
import type { FleetArrival, FleetArrivalWatch } from './fleetWarpFollow';
import { cargoChanged, cargoViewOf, type WireCargo } from './lootView';
import { registerClientHandlers, type ClientHandlerCtx } from './handlers/index.js';
import { pushBlastExplosion } from './handlers/shellHandlers.js';
import type { MirrorPassCtx } from './mirror/mirrorPassCtx.js';
import type { PredictionStepCtx } from './prediction/predictionStepCtx.js';
import { FIXED_MS, MAX_CATCH_UP_TICKS, MAX_OVER_PREDICTION_TICKS, stepInputTick, predictFrameEnergy, sendCapSentinel,
  setHelmCourse, setHelmSpeed, clearHelm, publishHelm, syncHelmMark, updateHelmAvailability, stepHelm, tickLocalMountAim } from './prediction/inputStep.js';
import { drainScheduledDamageSpawns, updateLocalShipMirror } from './mirror/localShipPass.js';
import { updateSpectatorPlacement, updateServerGhost, updateSwarmMirror, updateRemoteShipsMirror, updateProjectilesMirror, expireFrameState, updateDroneHostility } from './mirror/worldPasses.js';
import { fittedCargoMul } from '../../shared-types/blueprints.js';

const EMPTY_IDS: readonly string[] = Object.freeze([]);
/** Same id list (order-sensitive; absent ≡ empty). Alloc-free. */
function sameIds(a: readonly string[], b: readonly string[] | undefined): boolean {
  const n = b?.length ?? 0;
  if (a.length !== n) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b![i]) return false;
  return true;
}

import { cargoCapacityForMaxHealth } from '@shared-types/goods';
import {
  createRemotePredictionGuard,
  type RemotePredictionGuard,
} from './remotePredictionGuard';
import { shipMirrorKey, type ShipMirrorKeyLocal } from './shipMirrorKey.js';
import { isParkedHull, streamCentreShip } from '../render/shipOwnership.js';
import { findRekeySource } from './shipRekey.js';
import { copySchemaHealth } from './shipSchemaHealth.js';
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
import { resetPredictionState } from './prediction/resetPrediction.js';
import { reconcileReplayTick } from './prediction/reconcileReplayTick.js';
import { tryInitPredWorld, syncSwarmIntoPredWorld, rekeyOwnShipFromHull, dropRemoteShip, rekeyShip, ensureRemoteShipBody } from './prediction/predWorldSync.js';
import { disposeClient, type ClientTeardownCtx } from './connection/clientTeardown.js';
import {
  pilotInSectorShip, sendSpectate, sendCommand, enterCommandFromServer, sendFleetCommand, applyShipUpgrade, respecShip, activateMount,
  consumePendingCameraGlide, consumePendingFleetArrival, handleRespawnAck, respawnShip, devKillLocalShip, sendClientReady,
  type RoomCommandsCtx, type FleetCommandMessage,
} from './connection/roomCommands.js';
import { MineSync } from './mirror/mineSync.js';
import { rigClockTick, syncRigClips } from './mirror/rigSync.js';
import type { WelcomeTarget } from './handlers/welcomeHandlers.js';
import {
  readConnectionFlags, installConnectionDiagnostics, joinRoom, installBwStats, bwStats, createSnapshotDataChannel,
  registerRoomLifecycle, type RoomLifecycleCtx, type SnapshotSink,
} from './connection/roomConnection.js';
import { recoverInputTickFromStarvation, skipStalledBacklog, stallResumeAction } from './inputTickRecovery';
import { SnapshotCoalescer } from './SnapshotCoalescer.js';
import { ClientEntityFactory } from './entity/ClientEntityFactory.js';
import { createGameCutField, type CutFieldSummary } from './cutFieldWiring.js';
import { WreckGeometryStore } from './wreckGeometryStore.js';
import type { ClientSpawnCtx } from './entity/IClientEntityLeaf.js';
import { DataChannelTransport } from './dataChannelTransport.js';
import { HudDispatcher } from './HudDispatcher.js';
import { syncProjectiles } from './SnapshotSyncHelpers.js';
import { applyMissileSnapshot } from '../combat/MissileMirror.js';
import { RafStallDetector } from './RafStallDetector.js';
import {
  routeSnapshotShipStates,
  applyBoostingThrustingSets,
  type ShipRouterCtx,
} from './snapshotShipRouter.js';
import { applySnapshotPerfStats } from './snapshotPerfStats.js';
import { noteSnapshotArrival } from './snapshotArrivalStats.js';
import { syncTidiFromRoom } from './tidiSync.js';
import { updateRttAndLookahead } from './rttLookaheadUpdater.js';
import { stepTravel, TRAVEL_OUT_S, type TravelTrip } from './mirror/travelPass.js';
import { DisplayPoseHitscan } from '../combat/displayPoseHitscan.js';
import { preResetRemoteShips, applyRemoteShipInputs, type RemoteInput, type PreResetEntry, applyDroneMountAngles, applyAsteroidResources, applyShipLevels, applyShipWarp, applyActivatedMounts, applyParkedHullShieldDown, type PreResetRemoteCtx } from './snapshotRemoteSync.js';
import { computeRemoteLerpOffsets, type RemoteShipOffset } from './remoteLerpOffsets.js';
import { useUIStore, computeIsLoadingActive, type ConnectionStatus } from '../state/store';
import { logEvent, isDiagEnabled, isFullDiagMode } from '../debug/ClientLogger';
import { readHeapUsedMb } from './perfStats';
import { TransitInstrumentation } from '../debug/TransitInstrumentation';
import { GhostManager } from '../combat/GhostProjectile';

/** No aim guides (the mirror's `localAimMountIds`): the lock rings replace them. */
const EMPTY_AIM_IDS: readonly string[] = Object.freeze([]);
import { getWeapon } from '@core/combat/WeaponCatalogue';
import type { ControlBits } from '@core/combat/disable';
import { makeHelmOutput, type HelmOrder, type HelmPose, type HelmSpeed } from '@core/helm/helm';
import { HelmRouteClient } from '../helm/helmRoute.js';
import { makeHelmCourseMark, type HelmCourseMark } from '../helm/helmCourseMark.js';
import { HitPredictionLedger } from '@core/combat/HitPrediction';
import { type ReconcileFeedbackSink } from '../combat/HitPrediction.client';
import type { TouchInput } from '../input/TouchInput';
import { IDLE_INPUT_STATE, type JoystickInputState } from '../input/joystickToInput';
import { aimInput } from '../input/AimInput';
import { FireControlClient } from './FireControlClient';
import { LocalFireClient, type LocalFireHost } from './fireControl/LocalFireClient.js';
import { decodeSwarmPacket } from './BinarySwarmDecoder';
import {
  nextSwarmBinaryEwmaMs,
  setSwarmDisplaySpeed,
  type InterpolatedPose,
} from './swarmInterpolation';
import { updateAnchor } from './clockAnchor';
import { AiController, type AiIntentSink } from '@core/ai/AiController';
import { getShipKind, type WeaponMount } from '@shared-types/shipKinds';
import {
  type PlacementPreview,
  type PendingPlacement,
  type ShipPose,
} from '../structures/structurePlacementClient.js';
import type { StructureKindId } from '../../shared-types/structureKinds.js';

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

// Prediction tuning constants + remoteOffsetHalfLifeForDrift moved to
// ./predictionTuning.ts — pure read-only tuning values, no `this`-state.
import {
  NOISE_THRESHOLD,
  ANGLE_NOISE_THRESHOLD,
} from './predictionTuning.js';


// 2026-05-20 spiral fix: joystick→input thresholds (with hysteresis)
// moved into the pure `joystickToInput` helper. The single-band constants
// (TOUCH_DEADZONE, TOUCH_THRUST_MAG, TOUCH_THRUST_CONE,
// TOUCH_TURN_TOLERANCE) caused analog-noise toggles at ~10 Hz under
// steady stick use → sustained prediction-correction spiral on mobile.
// See `src/client/input/joystickToInput.ts` + its unit lock.

// Beam draw bands moved to the pure, unit-locked `combat/beamBands.ts` seam
// (campaign 5.2): optimal/max derive from the weapon catalogue def (the SAME
// numbers the server damage falloff reads), VISUAL_BEAM_SOLID_FRAC lives there.

// Pure rounding helpers used in the per-snapshot replay-grade capture
// block. Pre-fix these were declared as `const px = (n) => ...` closures
// inside `handleSnapshot`, allocating a function pair per snapshot
// (20 Hz). Both capture nothing — safe to hoist to module scope.
function _px3(n: number): number { return parseFloat(n.toFixed(3)); }
function _pa5(n: number): number { return parseFloat(n.toFixed(5)); }

/** Shared empty `lockedBy` (no allocation per snapshot). */
const NO_LOCKED_BY: ReadonlyArray<{ t: string; s: number; p: number }> = [];

export { isNoDamageNumberTarget, isUnseenSwarmTarget, isWreckPieceTarget } from './damageNumberTargets.js';
import { applyDamageFx, handleDamage, handleDestroy, handleShield, killEntity, killSwarmEntity, type DamagePathCtx } from './damagePath.js';
import { syncOwnEconomy } from './ownEconomySync';

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
   * This sector's GAME time (time scale stream; speed is per sector). Built
   * over `clock` (so the replay harness still drives it), its speed comes
   * from the snapshot's `timeScale` keyframe. Everything that turns time into
   * TICKS uses it (the clock anchor, `targetTick`, the render tick phase, the
   * shell display tick), so prediction follows the sector's speed with no
   * other code. Wall time stays for networking, stalls, RTT and UI. At 1× it
   * IS `clock.now()`, exactly.
   */
  private readonly gameClock: GameClock;
  /** Glide basis from the last snapshot keyframe (time scale dimmer). */
  private _glideS = 1;
  private _glideT: number | undefined = undefined;
  private _glideAtMs = 0;

  /**
   * The input lead in GAME ticks. `leadTicks` comes from the round trip in
   * WALL time (60 ticks a wall second); at speed s the same round trip spans
   * s × as many game ticks, so the lead must scale or inputs reach a faster
   * server late and every one is a prediction correction (measured: 11–17 per
   * take at 2× before this). Exactly `leadTicks` at 1×.
   */
  /**
   * This frame's length in GAME ms (time scale). Per-frame steps that move the
   * WORLD (projectile extrapolation, ghost bolts, the drawn turret slew) take
   * this, so they follow the sector's speed; visual error smoothing (the
   * reconciler lerp, offset springs) stays on wall `lastFrameMs`. Exactly
   * `lastFrameMs` at 1×.
   */
  private gameFrameMs(): number {
    return this.lastFrameMs * this.gameClock.scale;
  }

  private gameLeadTicks(): number {
    return this.leadTicks * this.gameClock.scale;
  }

  /** Set the client's speed (clock, display delay, render mirror) on change. */
  private applyLocalSpeed(speed: number): void {
    if (speed === this.gameClock.scale) return;
    this.gameClock.setScale(speed);
    setSwarmDisplaySpeed(speed);
    this.mirror.timeScale = speed === 1 ? undefined : speed;
  }

  /**
   * Through a glide, extrapolate the server's speed NOW with the shared
   * `glideToward` (#15): from the last keyframe's speed toward its target, over
   * the time since it arrived plus half the round trip. Alloc-free.
   */
  private followSpeedGlide(): void {
    if (this._glideT === undefined) return;
    const elapsedS = (this.clock.now() - this._glideAtMs + this.stats.rttMeanMs / 2) / 1000;
    this.applyLocalSpeed(glideToward(this._glideS, this._glideT, elapsedS));
  }

  /**
   * Default constructor uses real wall-clock — production behaviour is
   * byte-identical. The replay harness in `tests/replay/` passes a
   * `MockClock` to drive captured timestamps.
   */
  constructor(clock: Clock = REAL_CLOCK) {
    this.clock = clock;
    this.gameClock = new GameClock(() => clock.now());
    ColyseusGameClient._liveInstanceN += 1;
    logEvent('client_constructed', { liveInstanceN: ColyseusGameClient._liveInstanceN });
    // `?coalesce=0` / `?webrtc=` transport flags (connection/roomConnection.ts).
    const flags = readConnectionFlags();
    this.snapshotCoalescer = new SnapshotCoalescer(flags.coalesce);
    this._webrtcEnabled = flags.webrtc;
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
    vaporisedShips: new Set(),
    liveBeams: new Map(),
    remoteLasers: new Map(),
    boostingShips: new Set(),
    thrustingShips: new Set(),
    pendingDamageNumbers: [],
    pendingDamageNumberCancels: [],
    pendingHealthBarHits: [],
    pendingMissileExplosions: [],
    pendingEffectTriggers: [],
    pendingLevelUps: [],
    pendingShipRekeys: [],
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
  /** Campaign 2.1 — snapshot-carried hostility → the client ledger. The
   *  slice's `hostile` bit is already recipient-relative, so the mark is
   *  against the local player. Bound once (handleSnapshot is hot, #14).
   *  Ledger key = the bare numeric entityId string, exactly matching the
   *  `bot_aggro` / `damage` event paths and the swarm register key. */
  private readonly _snapshotHostileMark = (entityId: number): void => {
    const localId = this.mirror.localPlayerId;
    if (localId) this._aiController.markHostile(String(entityId), localId, this.inputTick);
  };
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
  /** Generic Entity Pipeline B4 — the client-side entity construction factory
   *  (the spawn-time kind→leaf routing seam, OOP peer of the server leaves). It
   *  replaces the old `swarmKindProfile` data table. `ColyseusClient` REMAINS
   *  the owner of `predSwarmKeys` / `_swarmBodyKeyCache` / `_aiRegisteredIds`;
   *  the leaves only read the reused `_clientSpawnCtx` + call predWorld /
   *  aiController (so `updateMirror`'s per-frame follower stays untouched). */
  private readonly _entityFactory = new ClientEntityFactory();
  /** Capital destruction S2b: wreck geometry rebuilt from the snapshot's
   *  `wrecks[]` descriptors. Its `descriptors` map IS `mirror.wrecks`. */
  private readonly _wrecks = new WreckGeometryStore();
  private readonly _cutField = createGameCutField({ gameClock: () => this.gameClock, predWorld: () => this.predWorld, mirror: this.mirror }); // macro terrain v2
  /** Reused construction context — one instance mutated in place per entity, so
   *  swarm spawn allocates nothing (invariant #14). `predWorld` / `entry` are
   *  filled per use; `aiController` is the (constant) hostility ledger. */
  private readonly _clientSpawnCtx: ClientSpawnCtx = {
    predWorld: null as unknown as ClientSpawnCtx['predWorld'],
    aiController: this._aiController,
    wrecks: this._wrecks,
    fieldRocks: this._cutField,
    entityId: 0,
    key: '',
    entry: null as unknown as ClientSpawnCtx['entry'],
    registeredAiId: null,
  };

  /** IDs of remote ships currently spawned in the prediction world: other
   *  pilots' ships (playerId keys) AND parked / AI-flown hulls (bare
   *  shipInstanceId keys, RTS Part A S3: one remote-ship path for both). */
  private predRemoteShipIds = new Set<string>();
  /** Per-remote-ship render lerp offsets — applied in updateMirror() to smooth server corrections.
   *  Stage 1: each entry holds critically-damped spring states for x, y and angle
   *  decaying toward zero. Half-life per drift magnitude matches Reconciler. */
  private readonly _remoteShipOffsets = new Map<string, RemoteShipOffset>();

  /** Stage 2 collision-event guard — sliding rate-limit window per ship,
   *  plus latest snapshot tick for the stale-event drop check. Updated by
   *  the collision_resolved handler and by handleSnapshot. */
  private readonly _collisionGuard: CollisionGuardState = createCollisionGuard();
  /** Last shield contact per shield (ms), to throttle grinding contacts. */
  private readonly _shieldContactAt = new Map<string, number>();

  /** Stage 3 — per-remote `lastInput` from the latest snapshot. Used by
   *  applyRemoteInputs() during the replay and tickPhysics input loops to
   *  forward-predict remote ships using the same input intent the server
   *  is applying. */
  private readonly _remoteLastInputs = new Map<string, RemoteInput>();
  /** Stage 3 — per-remote count of forward-prediction ticks applied since
   *  the last snapshot. Reset on snapshot arrival; gated against
   *  remoteForwardTickCap(lead) so a long network stall doesn't produce
   *  runaway speculative motion. */
  private readonly _remoteForwardTicks = new Map<string, number>();
  /** Stage 3 — hysteresis guard. Tracks recent correction magnitudes per
   *  remote and disables forward-prediction for entities whose input
   *  intent isn't tracking. */
  private readonly _predGuard: RemotePredictionGuard = createRemotePredictionGuard();
  /** `syncMirror`'s reused `shipMirrorKey` input (#14). */
  private readonly _syncMirrorKeyLocal: ShipMirrorKeyLocal = {
    localPlayerId: null, localShipInstanceId: null, localSpectating: false,
  };

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
    remoteCorrTotalUnits: 0,
    remoteCorrSamples: 0,
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
  notePendingPlacement(kind: StructureKindId, x: number, y: number, rot = 0, mirror = false): void {
    this._pendingPlacement = {
      kind, x, y, rot, mirror,
      sentAtMs: Date.now(),
      baselineStructureCount: this.mirror.structures?.size ?? 0,
    };
  }

  /** The ctx the room commands (`connection/roomCommands.ts`) run with, built once (#14). */
  private readonly _roomCmdCtx: RoomCommandsCtx = ((c: ColyseusGameClient): RoomCommandsCtx => ({
    get room() { return c.room; }, get mirror() { return c.mirror; }, get clock() { return c.clock; },
    get gameClock() { return c.gameClock; }, get predWorld() { return c.predWorld; }, get disposed() { return c.disposed; },
    get reconciler() { return c.reconciler; }, set reconciler(v) { c.reconciler = v; },
    get localDead() { return c.localDead; }, set localDead(v) { c.localDead = v; },
    get pendingPilotSwapShipId() { return c._pendingPilotSwapShipId; }, set pendingPilotSwapShipId(v) { c._pendingPilotSwapShipId = v; },
    get pilotSwapGlidePending() { return c._pilotSwapGlidePending; }, set pilotSwapGlidePending(v) { c._pilotSwapGlidePending = v; },
    get fleetArrival() { return c._fleetArrival; }, set fleetArrival(v) { c._fleetArrival = v; },
    get inputTick() { return c.inputTick; }, set inputTick(v) { c.inputTick = v; },
    get serverTickAtWelcome() { return c.serverTickAtWelcome; }, set serverTickAtWelcome(v) { c.serverTickAtWelcome = v; },
    get welcomePerfNow() { return c.welcomePerfNow; }, set welcomePerfNow(v) { c.welcomePerfNow = v; },
    get clockAnchorServerTick() { return c.clockAnchorServerTick; }, set clockAnchorServerTick(v) { c.clockAnchorServerTick = v; },
    get clockAnchorPerfNow() { return c.clockAnchorPerfNow; }, set clockAnchorPerfNow(v) { c.clockAnchorPerfNow = v; },
    get anchorInitialised() { return c._anchorInitialised; }, set anchorInitialised(v) { c._anchorInitialised = v; },
    get anchorFreshAtMs() { return c._anchorFreshAtMs; }, set anchorFreshAtMs(v) { c._anchorFreshAtMs = v; },
    get lastSentInputState() { return c.lastSentInputState; }, set lastSentInputState(v) { c.lastSentInputState = v; },
    get lastSentInputAtMs() { return c.lastSentInputAtMs; }, set lastSentInputAtMs(v) { c.lastSentInputAtMs = v; },
    rekeyShip: (from: string, to: string): void => c.rekeyShip(from, to),
    killEntity: (id: string): void => c.killEntity(id),
  }))(this);

  // Outbound room commands (`connection/roomCommands.ts`); callers and tests use these.
  pilotInSectorShip(shipId: string): boolean { return pilotInSectorShip(this._roomCmdCtx, shipId); }
  sendSpectate(): boolean { return sendSpectate(this._roomCmdCtx); }
  sendCommand(): boolean { return sendCommand(this._roomCmdCtx); }
  /** Public for tests (a command-view join). */
  enterCommandFromServer(): void { enterCommandFromServer(this._roomCmdCtx); }
  sendFleetCommand(msg: FleetCommandMessage): boolean { return sendFleetCommand(this._roomCmdCtx, msg); }
  applyShipUpgrade(shipId: string, alloc: Record<string, number>): boolean { return applyShipUpgrade(this._roomCmdCtx, shipId, alloc); }
  respecShip(shipId: string): boolean { return respecShip(this._roomCmdCtx, shipId); }
  activateMount(shipId: string, slotId: string, weaponId: 'hitscan' | 'laser' | 'heat-seeker'): boolean {
    return activateMount(this._roomCmdCtx, shipId, slotId, weaponId);
  }
  consumePendingCameraGlide(): { x: number; y: number } | null { return consumePendingCameraGlide(this._roomCmdCtx); }

  /** RTS fleet warp (S8): the ships a commander followed, waiting to show up
   *  in the destination's mirror (armed in the `transit_ready` handler). */
  private _fleetArrival: FleetArrivalWatch | null = null;

  consumePendingFleetArrival(): FleetArrival | null { return consumePendingFleetArrival(this._roomCmdCtx); }

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
  /** When a snapshot / welcome last re-synced the clock anchor, and since when
   *  a stalled client has been holding for a fresh one (-1 = not holding). */
  private _anchorFreshAtMs = -Infinity;
  private _stallHoldSinceMs = -1;
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
  private readonly _preResetRemotePosScratch = new Map<string, PreResetEntry>();
  /** 2026-05-25 heap-growth gate step 3 — pool of `{x, y}` entries
   *  reused inside `_preResetRemotePosScratch`. Per-snapshot peak ==
   *  remote-ship count; grows once, never shrinks (bounded by max
   *  concurrent remotes in the room). */
  private readonly _preResetRemotePosEntries: PreResetEntry[] = [];
  /** Reused state object for the per-snapshot drone/scrap body anchor
   *  (`anchorRemoteSwarmBodies`, part of the remote-entity anchor). Mutate,
   *  then pass; the World copies into Rapier synchronously (#14). */
  private readonly _swarmAnchorScratch = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  /** Body keys of the remote MOVING swarm entities (drones, scrap). Their
   *  predWorld bodies run on the predicted timeline, so the local beam and
   *  hit-prediction rays skip them in predWorld and test the drawn pose
   *  instead (`DisplayPoseHitscan`). Maintained by `syncSwarmIntoPredWorld`. */
  private readonly _movingSwarmKeys = new Set<string>();
  /** 2026-05-25 heap-growth gate step 5 — pre-computed `swarm-${id}`
   *  body-key strings, cached on first encounter. Pre-fix the swarm-
   *  kinematic loop did `` `swarm-${entityId}` `` per drone per RAF =
   *  2250 template-literal string allocs/sec. Keyed by entityId. */
  private readonly _swarmBodyKeyCache = new Map<number, string>();
  /** The local beam / hit-prediction ray: predWorld for everything except
   *  remote drones/scrap, which it tests at the drawn pose. */
  private readonly _displayHitscan = new DisplayPoseHitscan(this._movingSwarmKeys, this._swarmBodyKeyCache);
  /** 2026-05-25 heap-growth gate step 5 — persistent Set scratch for
   *  syncSwarmIntoPredWorld's per-packet "seen" sweep. Pre-fix
   *  allocated `new Set<string>()` per binary swarm packet (~60 Hz). */
  private readonly _swarmSyncSeenScratch = new Set<string>();
  /** Shield walls in predWorld (fence walls + teleporter irises), keyed by the
   *  derived-wall key. Spawned once, toggled as they block / open, and swept by
   *  a generation stamp when they leave (syncPredWalls). */
  private readonly _predWalls = new Map<number, { id: string; blocking: boolean; gen: number }>();
  private _predWallGen = 0;
  /** v4 T2 — the own ship's last seen teleport epoch (-1 ⇒ none seen yet). */
  private _localPoseEpoch = -1;
  /** v4 A — when the local ship's alien-gate disable ends (clock ms; 0 = not
   *  disabled). Set from the own-ship snapshot `disabledMs` (#16). */
  private _disabledUntilMs = 0;
  /** Reused input bits for the shared disable gate (#14, #15). */
  private readonly _disableBits: ControlBits = { thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false };
  /** Helm orders (capital-ship R&D round 3 D). The helm turns a course point
   *  and a speed setting into ordinary inputs before they are sent, so the
   *  server and prediction replay the same inputs (#12, #15). Scratch reused
   *  every tick (#14). */
  private readonly _helmOrder: HelmOrder = { active: false, tx: 0, ty: 0, speed: 3 };
  private readonly _helmOut = makeHelmOutput();
  /** Autopilot (navigation slice 13): asks the server for a way to the course point. */
  private readonly _helmRoute = new HelmRouteClient((t, m) => this.room?.send(t, m));
  private readonly _helmPose: HelmPose = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0 };
  private _helmKindId: string | null = null;
  private _helmAvailable = false;
  /** Helm move marker: bumps per course tap; the marker record is written
   *  into `mirror.helmCourse` (spatial ⇒ mirror, never Zustand, #2). */
  private _helmCourseSeq = 0;
  private readonly _helmMark: HelmCourseMark = makeHelmCourseMark();
  /** A3 — the stream centre's pose for distance-streaming walls (NaN ⇒ none). */
  private _predWallShipX = NaN;
  private _predWallShipY = NaN;
  private readonly _predWallVisitor: DerivedWallVisitor = {
    wall: (key, ax, ay, bx, by, blocking, thickness) => {
      const world = this.predWorld;
      if (!world) return;
      const w = this._predWalls.get(key);
      // A3 — only walls near the local ship (unswept ⇒ released).
      if (this._predWallShipX === this._predWallShipX) {
        const d = pointSegmentDistance(this._predWallShipX, this._predWallShipY, ax, ay, bx, by);
        if (!wantPredBody(w !== undefined, d)) return;
      }
      if (!w) {
        const id = `predwall-${key}`; // once per wall (static structures)
        world.spawnWall(id, ax, ay, bx, by, thickness);
        if (!blocking) world.setWallActive(id, false);
        this._predWalls.set(key, { id, blocking, gen: this._predWallGen });
        return;
      }
      w.gen = this._predWallGen;
      if (w.blocking !== blocking) {
        world.setWallActive(w.id, blocking);
        w.blocking = blocking;
      }
    },
  };
  /** 2026-05-25 heap-growth gate steps 8-10 — 1Hz HUD-store dispatcher.
   *  Owns swarm-count + hull-pct + shield-pct dedupe + 1Hz throttle so
   *  per-event handlers (handleDamage / handleShield / swarm-decoder)
   *  pay zero Zustand-notification cost on no-op updates. Extracted to
   *  `HudDispatcher.ts`. */
  private readonly hudDispatcher = new HudDispatcher();
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
   *  tracking parked-hull shipInstanceIds seen in the current snapshot
   *  (the router's hull sweep). Cleared at the top of each call. */
  private readonly _hullSeenScratch = new Set<string>();
  /** Persistent array scratch for the router's hull-eviction loop (#14). */
  private readonly _hullEvictScratch: string[] = [];
  /** Hits and kills wait for the drawn shell (`drawnShellTiming.ts`).
   *  Declared before the router ctx below, which reads its `shipKills`. */
  private readonly _shellTiming = new DrawnShellTiming({
    mirror: () => this.mirror, store: () => this._shellStore,
    hold: () => this._navalHitHold, sink: () => this._heldDamageSink,
    shellEvents: () => this._shellEvents, now: () => this.gameClock.now(), wallNow: () => this.clock.now(),
    anchorTick: () => this.clockAnchorServerTick,
    killSwarmEntity: (id) => this.killSwarmEntity(id), killEntity: (id) => this.killEntity(id),
    despawnLinger: (id) => this.dropRemoteShip(id),
  });
  /** Phase 4 (plan: quirky-rabbit) — class-field Set scratches replacing
   *  the per-call `new Set<string>()` literals at the syncMirror /
   *  updateLiveBeam sites. Each is cleared at the top of its consumer;
   *  population is bounded by the cache it's reconciling against (ship
   *  count, mount count) so allocations after warmup are zero. */
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
  private readonly _syncProjectilesSeenScratch = new Set<string>();
  /** Pre-bound drop path for the `routeSnapshotShipStates` ctx (bound once,
   *  no per-snapshot closure; heap-growth gate step 12). */
  private readonly _boundDropRemoteShip = (key: string): void => {
    this.dropRemoteShip(key);
  };
  /** Pre-bound re-key path for the router ctx (bound once, #14). */
  private readonly _boundRekeyShip = (from: string, to: string): void => {
    this.rekeyShip(from, to);
  };
  /** 2026-05-26 heap-growth gate step 12 — pooled ctx for
   *  `routeSnapshotShipStates`. `localSpectating` is the only volatile
   *  field, set before each call. */
  private readonly _routeSnapshotShipStatesCtx: ShipRouterCtx = {
    mirror: this.mirror,
    hullSeenScratch: this._hullSeenScratch,
    hullEvictScratch: this._hullEvictScratch,
    dropShip: this._boundDropRemoteShip,
    rekeyShip: this._boundRekeyShip,
    keepLingering: this._shellTiming.shipKills,
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
    swarmBodyKeys: this._swarmBodyKeyCache,
    swarmAnchorScratch: this._swarmAnchorScratch,
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

  /** Idle-suppression for the input upstream (network-discipline P4). The
   *  client only emits an `input` message when the control state has changed
   *  since the last send OR when {@link INPUT_HEARTBEAT_MS} has elapsed.
   *  Idle players (no keys held) drop from ~60 packets/s to ~4/s, removing
   *  the dominant chunk of upstream chatter. The server is tolerant of
   *  missing ticks: a tick with no inbound input simply gets no impulse, and
   *  drag handles the rest. Reconciliation replays only inputs we actually
   *  recorded locally (still 60 Hz), so the prediction model is unaffected. */
  private lastSentInputState: { thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean; warpX?: number; warpY?: number } | null = null;
  /** HUD demo: `?fakeCredits=1` drives the wallet client-side (see hud/widgets). */
  private readonly _fakeCredits =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fakeCredits') === '1';
  /** In-sector warp-to (Phase 4): the drop point the pilot asked for, held in
   *  every input until the local ship arrives (then cleared, which releases
   *  the server's latch). Null = none. */
  private warpRequest: { x: number; y: number } | null = null;
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
    warpX?: number;
    warpY?: number;
  } = { thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false };
  /** The send payload while a warp is requested: its own pooled object, so an
   *  ordinary input never carries undefined warp fields (they'd serialise as
   *  null and fail the server's strict schema, dropping the whole input). */
  private readonly _sendWarpInputScratch = {
    type: 'input' as const, tick: 0, thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false, warpX: 0, warpY: 0,
  };
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

  /** Phase 4 WS-A2 — the shipInstanceId of an in-flight SAME-SECTOR pilot swap
   *  (set by `pilotInSectorShip`, matched + cleared in the `welcome` handler).
   *  Lets the generic welcome path distinguish a pilot-swap re-anchor from a
   *  fresh join/transit so it can clear spectator + arm the camera glide. */
  private _pendingPilotSwapShipId: string | null = null;
  /** Phase 4 WS-A2 — armed by the welcome handler when a pilot swap lands; the
   *  RAF loop reads `consumePendingCameraGlide()` to fire the ONE-SHOT camera
   *  glide to the new ship's pose once it's known (one-shot, then cleared). */
  private _pilotSwapGlidePending = false;

  /** Predicted energy pool for the local ship (weapons/energy/AI overhaul
   *  §3.2). Driven entirely by the player's OWN fire/boost input, so it's
   *  predictable like position: regen + boost drain in `tickPhysics`, fire
   *  drain in `sendFire`, hard-reconciled from `snap.states[localId].energy`
   *  each snapshot. NOT in Zustand — it changes per frame; the top-center
   *  status capsule's energy fill (`useEnergyFill`) reads it via a RAF loop +
   *  direct-DOM write. */
  private predEnergy = 0;
  /** False until the pool has a real starting value: the server's own-ship
   *  energy, or (before the ship goes active and that arrives) the kind's
   *  maximum, since the server spawns every ship full. Starting at 0 made
   *  the bar fill from empty for ~2.5 s after the curtain lifted. */
  private _energySeeded = false;

  /** Phase 4 WS-B2 — the last per-instance stat allocation applied to the local
   *  player's predWorld body, as a stable JSON key. The server emits the
   *  authoritative `statAlloc` on the own-ship snapshot slice (own-active-only,
   *  when non-empty); the client re-anchors `predWorld.setStatMultipliers` from
   *  it so prediction scales movement IDENTICALLY to the server (risk #1). This
   *  guard avoids re-pushing identical multipliers every snapshot. `''` = no
   *  upgrades applied yet (the neutral path). */
  private _lastStatAllocKey = '';

  /** Inject the audio sink before `connect()`. Wired by `App.tsx`'s bootstrap. */
  setAudio(audio: IAudio): void {
    this.audio = audio;
  }

  /** Shells as events: on when the welcome says so (shell-events.md §7). */
  private _shellEvents = false;
  private readonly _shellStore = new ShellSalvoStore();
  /** The ctx `handlers/index.ts` registers with, built once (#14). */
  private readonly _handlerCtx: ClientHandlerCtx = {
    mirror: this.mirror, shellStore: this._shellStore, cutField: this._cutField,
    shellEvents: () => this._shellEvents,
    applyShellEnd: (msg: ShellEnd): void => this.applyShellEnd(msg),
    holdBlast: (x: number, y: number, r: number): boolean => this._shellEvents
      && this._navalHitHold.maybeHoldBlast(x, y, r, this._shellStore.map, this.gameClock.now()),
    holdBlastWithHit: (x: number, y: number, r: number): boolean => this._navalHitHold.holdBlastWithHit(x, y, r),
    transitInstr: this.transitInstr,
    now: (): number => this.clock.now(),
    isDisposed: (): boolean => this.disposed,
    serverTickAtWelcome: (): number => this.serverTickAtWelcome,
    welcomePerfNow: (): number => this.welcomePerfNow,
    isTravelling: (): boolean => this.isTravelling(),
    beginTravel: (): void => this.beginTravel(),
    travelOutRemainingMs: (): number => this.travelOutRemainingMs(),
    setFleetArrival: (w: FleetArrivalWatch | null): void => { this._fleetArrival = w; },
    resetPredictionState: (): void => this.resetPredictionState(),
    dropRemoteShip: (id: string): void => this.dropRemoteShip(id),
    onSectorHandoff: (): void => this._seat?.callbacks.onSectorHandoff?.(),
    consumeSeatReservation: (reservation: unknown): Promise<Room> => {
      const seat = this._seat;
      if (seat === null) return Promise.reject(new Error('no connection'));
      return seat.client.consumeSeatReservation<unknown>(reservation as never);
    },
    adoptRoom: (room: Room): void => {
      this.room = room;
      this._seat?.bindRoomHandlers(room);
    },
    hitLedger: this._hitLedger, reconcileSink: this._reconcileSink,
    ghostManager: this.ghostManager, shellTiming: this._shellTiming, aiController: this._aiController,
    inputTick: (): number => this.inputTick,
    handleDamage: (evt: DamageEvent, suppressNumber: boolean): void => this.handleDamage(evt, suppressNumber),
    handleShield: (evt: ShieldEventMessage): void => this.handleShield(evt),
    handleDestroy: (evt: DestroyEvent): void => this.handleDestroy(evt),
    shooterKindMounts: (shooterId: string): readonly WeaponMount[] | undefined => this.shooterKindMounts(shooterId),
    enterCommandFromServer: (): void => this.enterCommandFromServer(),
    dataChannelTransport: (): DataChannelTransport | null => this._dataChannelTransport,
    predWorld: (): PhysicsWorld | null => this.predWorld,
    collisionGuard: this._collisionGuard, stats: this.stats, shieldContactAt: this._shieldContactAt,
    welcome: ((c: ColyseusGameClient): WelcomeTarget => ({
      get mirror() { return c.mirror; }, get clock() { return c.clock; }, get gameClock() { return c.gameClock; },
      get cutField() { return c._cutField; }, get wrecks() { return c._wrecks; }, get shellTiming() { return c._shellTiming; },
      get room() { return c.room; }, get webrtcEnabled() { return c._webrtcEnabled; },
      get dataChannelTransport() { return c._dataChannelTransport; }, get storedPlayerId() { return c._seat?.storedPlayerId ?? null; },
      get shellEvents() { return c._shellEvents; }, set shellEvents(v) { c._shellEvents = v; },
      get serverTickAtWelcome() { return c.serverTickAtWelcome; }, set serverTickAtWelcome(v) { c.serverTickAtWelcome = v; },
      get welcomePerfNow() { return c.welcomePerfNow; }, set welcomePerfNow(v) { c.welcomePerfNow = v; },
      get clockAnchorServerTick() { return c.clockAnchorServerTick; }, set clockAnchorServerTick(v) { c.clockAnchorServerTick = v; },
      get clockAnchorPerfNow() { return c.clockAnchorPerfNow; }, set clockAnchorPerfNow(v) { c.clockAnchorPerfNow = v; },
      get anchorInitialised() { return c._anchorInitialised; }, set anchorInitialised(v) { c._anchorInitialised = v; },
      get anchorFreshAtMs() { return c._anchorFreshAtMs; }, set anchorFreshAtMs(v) { c._anchorFreshAtMs = v; },
      get inputTick() { return c.inputTick; }, set inputTick(v) { c.inputTick = v; },
      get lastSentInputState() { return c.lastSentInputState; }, set lastSentInputState(v) { c.lastSentInputState = v; },
      get lastSentInputAtMs() { return c.lastSentInputAtMs; }, set lastSentInputAtMs(v) { c.lastSentInputAtMs = v; },
      get pendingPilotSwapShipId() { return c._pendingPilotSwapShipId; }, set pendingPilotSwapShipId(v) { c._pendingPilotSwapShipId = v; },
      get pilotSwapGlidePending() { return c._pilotSwapGlidePending; }, set pilotSwapGlidePending(v) { c._pilotSwapGlidePending = v; },
      onPlayerId: (id: string): void => c._seat?.callbacks.onPlayerId(id),
      rekeyOwnShipFromHull: (playerId: string, shipId: string): void => c.rekeyOwnShipFromHull(playerId, shipId),
      tryInitPredWorld: (playerId: string): void => c.tryInitPredWorld(playerId),
    }))(this),
    onNavRoute: (raw: unknown): void => { const r = this._helmRoute.onReply(raw, this._helmOrder); if (r === 'end') this.clearHelm(); else if (r === 'route') this.publishHelm(); },
  };
  /** The ctx the `updateMirror` passes (`mirror/`) run with, built once (#14). */
  private readonly _mirrorPassCtx: MirrorPassCtx = ((c: ColyseusGameClient): MirrorPassCtx => ({
    get mirror() { return c.mirror; }, get clock() { return c.clock; }, get gameClock() { return c.gameClock; },
    get predWorld() { return c.predWorld; }, get reconciler() { return c.reconciler; },
    get lastFrameMs() { return c.lastFrameMs; }, get lastLocalTickAtMs() { return c._lastLocalTickAtMs; },
    get inputTick() { return c.inputTick; }, get scheduledDamageSpawns() { return c._scheduledDamageSpawns; },
    get pendingPlacement() { return c._pendingPlacement; },
    set pendingPlacement(v) { c._pendingPlacement = v; },
    get placementShipScratch() { return c._placementShipScratch; },
    get placementPreviewScratch() { return c._placementPreviewScratch; },
    get swarmNearbyIds() { return c._swarmNearbyIds; }, set swarmNearbyIds(v) { c._swarmNearbyIds = v; },
    get swarmNearbySwapScratch() { return c._swarmNearbySwapScratch; },
    set swarmNearbySwapScratch(v) { c._swarmNearbySwapScratch = v; },
    get swarmInterpScratch() { return c._swarmInterpScratch; }, get lastSnapshotPos() { return c.lastSnapshotPos; },
    get predRemoteShipIds() { return c.predRemoteShipIds; }, get remoteShipOffsets() { return c._remoteShipOffsets; },
    get ghostManager() { return c.ghostManager; }, get shellEvents() { return c._shellEvents; },
    get clockAnchorServerTick() { return c.clockAnchorServerTick; },
    get clockAnchorPerfNow() { return c.clockAnchorPerfNow; },
    get damageFlashFrames() { return c._damageFlashFrames; }, get hitLedger() { return c._hitLedger; },
    get lastHitscanFireMs() { return c._lastHitscanFireMs; },
    get skipHitscanVisual() { return ColyseusGameClient.SKIP_HITSCAN_VISUAL_FLAG; },
    get aiController() { return c._aiController; },
    gameFrameMs: (): number => c.gameFrameMs(),
    placeShells: (displayTick: number, frameWallMs: number): void => c.placeShells(displayTick, frameWallMs),
    displayHitscan: (): DisplayPoseHitscan => c.displayHitscan(),
  }))(this);
  /** The ctx the `tickPhysics` prediction passes (`prediction/`) run with, built once (#14). */
  private readonly _predStepCtx: PredictionStepCtx = ((c: ColyseusGameClient): PredictionStepCtx => ({
    get mirror() { return c.mirror; }, get clock() { return c.clock; },
    get predWorld() { return c.predWorld; },
    get reconciler() { return c.reconciler; }, set reconciler(v) { c.reconciler = v; },
    get touchInput() { return c.touchInput; }, get localDead() { return c.localDead; },
    get inputTick() { return c.inputTick; }, set inputTick(v) { c.inputTick = v; },
    get predEnergy() { return c.predEnergy; }, set predEnergy(v) { c.predEnergy = v; },
    get energySeeded() { return c._energySeeded; }, set energySeeded(v) { c._energySeeded = v; },
    get joystickInputState() { return c._joystickInputState; }, set joystickInputState(v) { c._joystickInputState = v; },
    get warpRequest() { return c.warpRequest; }, set warpRequest(v) { c.warpRequest = v; },
    get lastSentInputState() { return c.lastSentInputState; }, set lastSentInputState(v) { c.lastSentInputState = v; },
    get lastSentInputAtMs() { return c.lastSentInputAtMs; }, set lastSentInputAtMs(v) { c.lastSentInputAtMs = v; },
    get lastLocalTickAtMs() { return c._lastLocalTickAtMs; }, set lastLocalTickAtMs(v) { c._lastLocalTickAtMs = v; },
    get clockAnchorPerfNow() { return c.clockAnchorPerfNow; }, get clockAnchorServerTick() { return c.clockAnchorServerTick; },
    get helmOrder() { return c._helmOrder; }, get helmOut() { return c._helmOut; }, get disableBits() { return c._disableBits; },
    get inputRecScratch() { return c._inputRecScratch; }, get applyInputScratch() { return c._applyInputScratch; },
    get sendInputScratch() { return c._sendInputScratch; }, get sendWarpInputScratch() { return c._sendWarpInputScratch; },
    clearHelm: (): void => c.clearHelm(), stepHelm: (): void => c.stepHelm(),
    get helmPose() { return c._helmPose; }, get helmMark() { return c._helmMark; },
    get helmRoute() { return c._helmRoute; }, get gameClock() { return c.gameClock; },
    get helmKindId() { return c._helmKindId; }, set helmKindId(v) { c._helmKindId = v; },
    get helmAvailable() { return c._helmAvailable; }, set helmAvailable(v) { c._helmAvailable = v; },
    get helmCourseSeq() { return c._helmCourseSeq; }, set helmCourseSeq(v) { c._helmCourseSeq = v; },
    get fc() { return c.fc; },
    isLocallyDisabled: (): boolean => c.isLocallyDisabled(), gameLeadTicks: (): number => c.gameLeadTicks(),
    applyRemoteInputs: (): void => c.applyRemoteInputs(), tickLocalMountAim: (dt: number): void => c.tickLocalMountAim(dt),
    get swarmSyncSeenScratch() { return c._swarmSyncSeenScratch; }, get swarmBodyKeyCache() { return c._swarmBodyKeyCache; },
    get clientSpawnCtx() { return c._clientSpawnCtx; }, get entityFactory() { return c._entityFactory; }, get wrecks() { return c._wrecks; },
    get aiRegisteredIds() { return c._aiRegisteredIds; }, get aiController() { return c._aiController; },
    get predSwarmKeys() { return c.predSwarmKeys; }, get movingSwarmKeys() { return c._movingSwarmKeys; },
    get swarmAnchorScratch() { return c._swarmAnchorScratch; }, get welcomePerfNow() { return c.welcomePerfNow; },
    get localPoseResolvedLogged() { return c._localPoseResolvedLogged; }, set localPoseResolvedLogged(v) { c._localPoseResolvedLogged = v; },
    get predRemoteShipIds() { return c.predRemoteShipIds; }, get remoteShipOffsets() { return c._remoteShipOffsets; },
    get remoteLastInputs() { return c._remoteLastInputs; }, get remoteForwardTicks() { return c._remoteForwardTicks; },
    get predGuard() { return c._predGuard; }, get arrivalSnapped() { return c._arrivalSnapped; },
    get remoteHistory() { return c.remoteHistory; }, get damageFlashFrames() { return c._damageFlashFrames; },
    rekeyLockState: (from: string, to: string): void => c.fc.rekeyLockState(from, to),
  }))(this);
  /** The live connection's client + room binder, set once per `connect()`;
   *  the `transit_ready` handoff (handlers/transitHandlers.ts) consumes the
   *  destination seat through it. */
  private _seat: {
    client: Client;
    bindRoomHandlers: (room: Room) => void;
    callbacks: ColyseusClientCallbacks;
    storedPlayerId: string | null;
  } | null = null;
  /** The ctx the room's leave handler (`connection/roomConnection.ts`) runs with, built once (#14). */
  private readonly _lifecycleCtx: RoomLifecycleCtx = ((c: ColyseusGameClient): RoomLifecycleCtx => ({
    get dataChannelTransport() { return c._dataChannelTransport; }, set dataChannelTransport(v) { c._dataChannelTransport = v; },
    detachInput: (): void => { c.keyboard = null; c.touchInput = null; },
  }))(this);
  /** Where DataChannel snapshots go (`createSnapshotDataChannel`), built once (#14). */
  private readonly _snapshotSink: SnapshotSink = ((c: ColyseusGameClient): SnapshotSink => ({
    get snapshotCoalescer() { return c.snapshotCoalescer; },
    logSnapshotRecvTelemetry: (snap: SnapshotMessage, via: 'ws' | 'dc'): void => c.logSnapshotRecvTelemetry(snap, via),
    applySnapshotNow: (snap: SnapshotMessage): void => c.applySnapshotNow(snap),
  }))(this);
  /** A naval shell hit's FX wait for its drawn burst (navalHitHold.ts). */
  private readonly _navalHitHold = new NavalHitHold();
  /** The sink `_navalHitHold.release` calls (built once, #14). */
  private readonly _heldDamageSink = {
    applyHeldDamage: (h: HeldDamage): void => {
      if (h.blastRadius > 0) pushBlastExplosion(this.mirror, h.evt.hitX!, h.evt.hitY!, h.blastRadius);
      else if (h.evt.damage > 0) this.applyDamageFx(h.evt, h.suppressNumber);
    },
  };
  /** The ctx the damage / death path (`damagePath.ts`) runs with, built once (#14). */
  private readonly _damageCtx: DamagePathCtx = ((c: ColyseusGameClient): DamagePathCtx => ({
    get mirror() { return c.mirror; }, get clock() { return c.clock; }, get predWorld() { return c.predWorld; },
    get hudDispatcher() { return c.hudDispatcher; }, get aiController() { return c._aiController; },
    get inputTick() { return c.inputTick; }, get shellTiming() { return c._shellTiming; },
    get damageFlashFrames() { return c._damageFlashFrames; }, get scheduledDamageSpawns() { return c._scheduledDamageSpawns; },
    get navalHitHold() { return c._navalHitHold; }, get heldDamageSink() { return c._heldDamageSink; },
    get ghostManager() { return c.ghostManager; }, get predSwarmKeys() { return c.predSwarmKeys; },
    get movingSwarmKeys() { return c._movingSwarmKeys; }, get welcomePerfNow() { return c.welcomePerfNow; },
    get localDead() { return c.localDead; }, set localDead(v) { c.localDead = v; },
    get diedAtMs() { return c.diedAtMs; }, set diedAtMs(v) { c.diedAtMs = v; },
    dropRemoteShip: (key: string): void => c.dropRemoteShip(key),
  }))(this);

  /** The ctx the sector-handoff reset (`prediction/resetPrediction.ts`) and `dispose()`
   *  (`connection/clientTeardown.ts`) run with, built once (#14). */
  private readonly _predResetCtx: ClientTeardownCtx = ((c: ColyseusGameClient): ClientTeardownCtx => ({
    get mirror() { return c.mirror; }, get wrecks() { return c._wrecks; }, get cutField() { return c._cutField; },
    get shellTiming() { return c._shellTiming; }, get predWorld() { return c.predWorld; }, set predWorld(v) { c.predWorld = v; },
    get aiController() { return c._aiController; }, get aiRegisteredIds() { return c._aiRegisteredIds; },
    get predWalls() { return c._predWalls; }, get recentIntervals() { return c._recentIntervals; },
    get recentCorrFlags() { return c._recentCorrFlags; }, get scheduledDamageSpawns() { return c._scheduledDamageSpawns; },
    get energySeeded() { return c._energySeeded; }, set energySeeded(v) { c._energySeeded = v; },
    get localPoseEpoch() { return c._localPoseEpoch; }, set localPoseEpoch(v) { c._localPoseEpoch = v; },
    get warpRequest() { return c.warpRequest; }, set warpRequest(v) { c.warpRequest = v; },
    get rttWelford() { return c._rttWelford; }, set rttWelford(v) { c._rttWelford = v; },
    get lookaheadCtrl() { return c._lookaheadCtrl; }, set lookaheadCtrl(v) { c._lookaheadCtrl = v; },
    get dropDetector() { return c._dropDetector; }, set dropDetector(v) { c._dropDetector = v; },
    get leadTicks() { return c.leadTicks; }, set leadTicks(v) { c.leadTicks = v; },
    get anchorInitialised() { return c._anchorInitialised; }, set anchorInitialised(v) { c._anchorInitialised = v; },
    get anchorFreshAtMs() { return c._anchorFreshAtMs; }, set anchorFreshAtMs(v) { c._anchorFreshAtMs = v; },
    get stallHoldSinceMs() { return c._stallHoldSinceMs; }, set stallHoldSinceMs(v) { c._stallHoldSinceMs = v; },
    get lastSnapshotAt() { return c.lastSnapshotAt; }, set lastSnapshotAt(v) { c.lastSnapshotAt = v; },
    get swarmBinaryLastMs() { return c._swarmBinaryLastMs; }, set swarmBinaryLastMs(v) { c._swarmBinaryLastMs = v; },
    get swarmBinaryEwma() { return c._swarmBinaryEwma; }, set swarmBinaryEwma(v) { c._swarmBinaryEwma = v; },
    get reconciler() { return c.reconciler; }, set reconciler(v) { c.reconciler = v; },
    get lastStatAllocKey() { return c._lastStatAllocKey; }, set lastStatAllocKey(v) { c._lastStatAllocKey = v; },
    get localPoseResolvedLogged() { return c._localPoseResolvedLogged; }, set localPoseResolvedLogged(v) { c._localPoseResolvedLogged = v; },
    get lastLocalTickAtMs() { return c._lastLocalTickAtMs; }, set lastLocalTickAtMs(v) { c._lastLocalTickAtMs = v; },
    get dataChannelTransport() { return c._dataChannelTransport; }, set dataChannelTransport(v) { c._dataChannelTransport = v; },
    applyLocalDisabled: (ms: number): void => c.applyLocalDisabled(ms),
    clearLineHold: (): void => c.fc.clearLineHold(),
    get disposed() { return c.disposed; }, set disposed(v) { c.disposed = v; },
    get localDead() { return c.localDead; }, set localDead(v) { c.localDead = v; },
    get diedAtMs() { return c.diedAtMs; }, set diedAtMs(v) { c.diedAtMs = v; },
    get keyboard() { return c.keyboard; }, set keyboard(v) { c.keyboard = v; },
    get touchInput() { return c.touchInput; }, set touchInput(v) { c.touchInput = v; },
    get audio() { return c.audio; }, set audio(v) { c.audio = v; }, get room() { return c.room; }, set room(v) { c.room = v; },
    get snapshotCoalescer() { return c.snapshotCoalescer; }, get transitInstr() { return c.transitInstr; },
    get rafStallDetector() { return c.rafStallDetector; }, get hudDispatcher() { return c.hudDispatcher; },
    get ghostManager() { return c.ghostManager; }, get remoteHistory() { return c.remoteHistory; },
    get predRemoteShipIds() { return c.predRemoteShipIds; }, get remoteShipOffsets() { return c._remoteShipOffsets; },
    get predSwarmKeys() { return c.predSwarmKeys; }, get movingSwarmKeys() { return c._movingSwarmKeys; },
    get damageFlashFrames() { return c._damageFlashFrames; },
    get lastSentInputAtMs() { return c.lastSentInputAtMs; }, set lastSentInputAtMs(v) { c.lastSentInputAtMs = v; },
    get lastSentInputState() { return c.lastSentInputState; }, set lastSentInputState(v) { c.lastSentInputState = v; },
    get liveInstanceN() { return ColyseusGameClient._liveInstanceN; }, set liveInstanceN(v) { ColyseusGameClient._liveInstanceN = v; },
  }))(this);
  /** Sector-handoff reset (`prediction/resetPrediction.ts`); tests call it. */
  private resetPredictionState(): void { resetPredictionState(this._predResetCtx); }

  async connect(
    wsUrl: string,
    storedPlayerId: string | null,
    keyboard: { read: () => { thrust: boolean; turnLeft: boolean; turnRight: boolean; fireHeld: boolean; boost: boolean; reverse: boolean } },
    callbacks: ColyseusClientCallbacks,
    roomName = 'sector',
    extraJoinOptions: Record<string, unknown> = {},
    touchInput?: TouchInput,
  ): Promise<void> {
    installConnectionDiagnostics(); // longtask, page lifecycle, health stats (connection/roomConnection.ts)

    // Init client-side prediction world before joining so it is ready as soon as
    // we receive our playerId.
    this.predWorld = await PhysicsWorld.create();

    callbacks.onConnectionStatus('connecting');
    logEvent('cc_connecting', { wsUrl, playerId: storedPlayerId ?? null });
    const client = new Client(wsUrl);

    const resolvedRoom = await joinRoom(client, roomName, storedPlayerId, extraJoinOptions, callbacks);

    if (this.disposed) {
      resolvedRoom.leave();
      return;
    }

    this.room = resolvedRoom;
    logEvent('cc_join_resolved', { roomId: this.room.roomId });

    installBwStats(this.clock); // DEV-only bandwidth tally (connection/roomConnection.ts)

    // Phase 8 sub-phase B — extracted handler binding so the same set of
    // listeners can be re-attached to the destination room post-transit
    // (after `client.consumeSeatReservation`). Closure-captures
    // `callbacks`. Called once below for the initial room, and again from
    // the `transit_ready` handler for the destination.
    const bindRoomHandlers = (room: Room): void => {
    // The DataChannel transport exists before the welcome handler can fire (connection/roomConnection.ts).
    if (this._webrtcEnabled) this._dataChannelTransport = createSnapshotDataChannel(room, this._snapshotSink);

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
      // steady 20 Hz JSON snapshot. The helper caps the sample so one
      // tab-background / radio gap can't pin the EWMA at the ceiling (the
      // JSON drop-detector `dropBias` already biases up on loss bursts),
      // and skips frame-stall backlog (a main-thread freeze, not the link).
      const swNowMs = this.clock.now();
      if (this._swarmBinaryLastMs >= 0) {
        this._swarmBinaryEwma = nextSwarmBinaryEwmaMs(this._swarmBinaryEwma, swNowMs - this._swarmBinaryLastMs, swNowMs);
      }
      this._swarmBinaryLastMs = swNowMs;
      // Probe 0 (mobile-perf-investigation-review §"Confound the diagnosis
      // did not address"): the binary swarm decode + predWorld sync is the
      // uninstrumented post-pivot dominant per-frame surface. `applyMs`
      // measures only JSON `handleSnapshot`; this path runs separately at
      // ~60 Hz (spawn, shield swaps, the static-body sweep). Wrap
      // with `performance.now()` to feed rolling max/avg into `heap_sample`
      // and to log slow individual packets (> 5 ms) as discrete events.
      const decodeStartMs = performance.now();
      if (raw instanceof ArrayBuffer) {
        if (bw) { bw.swarmBytes += raw.byteLength; bw.swarmPackets += 1; }
        decodeSwarmPacket(raw, this.mirror, performance.now(), true, this._shellTiming);
      } else if (ArrayBuffer.isView(raw)) {
        if (bw) { bw.swarmBytes += raw.byteLength; bw.swarmPackets += 1; }
        decodeSwarmPacket(raw, this.mirror, performance.now(), true, this._shellTiming);
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

    room.onMessage('respawn_ack', (msg: RespawnAckMessage) => {
      handleRespawnAck(this._roomCmdCtx, msg);
    });

    // Feature handler files (handlers/index.ts): welcome, missiles, impact FX, toasts,
    // wave HUD, structure panels, drawn shells, ship status, cut field,
    // warp / transit handoff, combat (damage / shield / destroy / hit_ack /
    // laser_fired / control_mode / bot_aggro), grid pulse, diagnostics
    // (gc_pause / session_replaced), WebRTC signalling, collision_resolved.
    registerClientHandlers(room, this._handlerCtx);

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

    registerRoomLifecycle(room, this._lifecycleCtx, callbacks);
    };

    this._seat = { client, bindRoomHandlers, callbacks, storedPlayerId };
    bindRoomHandlers(this.room);

    callbacks.onConnectionStatus('connected');
    logEvent('cc_connected', {});
    this.keyboard = keyboard;
    this.touchInput = touchInput ?? null;
  }

  // ── Combat event handlers ────────────────────────────────────────────────

  private handleShield(evt: ShieldEventMessage): void { handleShield(this._damageCtx, evt); }
  private handleDamage(evt: DamageEvent, suppressNumber = false): void { handleDamage(this._damageCtx, evt, suppressNumber); }
  private applyDamageFx(evt: DamageEvent, suppressNumber: boolean): void { applyDamageFx(this._damageCtx, evt, suppressNumber); }
  private killEntity(id: string): void { killEntity(this._damageCtx, id); }
  private handleDestroy(evt: DestroyEvent): void { handleDestroy(this._damageCtx, evt); }
  private killSwarmEntity(wireId: string): void { killSwarmEntity(this._damageCtx, wireId); }

  /** A `shell_end` (`DrawnShellTiming.onShellEnd`). */
  private applyShellEnd(msg: ShellEnd): void { this._shellTiming.onShellEnd(msg); }

  /** One frame of event shells at `displayTick` (`DrawnShellTiming.place`). */
  private placeShells(displayTick: number, frameWallMs = Number.NaN): void { this._shellTiming.place(displayTick, frameWallMs); }

  // Ship re-key + remote bodies (`prediction/predWorldSync.ts`); handlers and tests use these.
  private rekeyOwnShipFromHull(playerId: string, welcomeShipInstanceId: string): void { rekeyOwnShipFromHull(this._predStepCtx, playerId, welcomeShipInstanceId); }
  private dropRemoteShip(key: string, mode: 'gone' | 'outOfWorld' = 'gone'): void { dropRemoteShip(this._predStepCtx, key, mode); }
  private rekeyShip(from: string, to: string): void { rekeyShip(this._predStepCtx, from, to); }
  private ensureRemoteShipBody(key: string, pose: ShipPhysicsState, kind: string): boolean { return ensureRemoteShipBody(this._predStepCtx, key, pose, kind); }

  respawnShip(): void { respawnShip(this._roomCmdCtx); }
  /** Test-only: the client-local death of the local ship (DEV `__eqxKillLocalShip`). */
  devKillLocalShip(): void { devKillLocalShip(this._roomCmdCtx); }
  sendClientReady(): void { sendClientReady(this._roomCmdCtx); }

  // ── Prediction bootstrap ────────────────────────────────────────────────

  /** Local predWorld body + Reconciler (`prediction/predWorldSync.ts`); tests call it. */
  private tryInitPredWorld(playerId: string): void { tryInitPredWorld(this._predStepCtx, playerId); }

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
    this.stats.lastSnapshotRecvAtMs = recvAtMs; // net-health HUD wait readout
    const serverSendPerfNow = (snap as { serverSendPerfNow?: number }).serverSendPerfNow;
    // Emit-when-non-zero on the server (2026-11-14 trim): absent means 0.
    noteSnapshotArrival(recvAtMs, serverSendPerfNow); // net-health HUD: network vs server
    const wsBufferedAmountBytes = (snap as { wsBufferedAmountBytes?: number }).wsBufferedAmountBytes ?? 0;
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

    // Phase 6a / RTS Part A S3 — re-key the shipInstanceId-keyed wire format
    // to the mirror's keys (playerId for active ships, shipInstanceId for
    // parked / AI-flown hulls; ONE ship list). See snapshotShipRouter.ts.
    // Ctx pooled to `this._routeSnapshotShipStatesCtx` (heap-growth gate
    // step 12); `localSpectating` is the only volatile field.
    this._routeSnapshotShipStatesCtx.localSpectating = useUIStore.getState().pilotMode === 'spectator';
    routeSnapshotShipStates(snap, this._routeSnapshotShipStatesCtx);
    // Remote bodies (other pilots + parked hulls) spawn here, from the
    // snapshot pose only (B2).
    this.spawnRemoteShipBodies(snap);

    // Wire-discipline P3: projectiles arrive on the snapshot, interest-filtered
    // per recipient. Sync into the mirror first so the rest of this handler can
    // assume the projectile map matches the snapshot's tick.
    this.syncProjectiles(snap.projectiles);
    if (this._shellEvents) {
      this._shellStore.applyKeyframe(snap.shellKey);
      this._shellStore.sweep(snap.serverTick - 120); // backstop; place() ends shells on the display clock
    }

    // Missiles: per-recipient AOI-filtered slice. Sliding-window apply
    // for interpolation; stale-eviction backstop covers AOI exits.
    applyMissileSnapshot(snap.missiles, this.mirror, snap.serverTick, now);

    // Structures plan, Phase 3 — mirror the slim grid slice (web + power +
    // construction). Pose lives in `mirror.swarm` (kind=2); joined by entityId.
    this.syncStructures(snap.structureTargets, snap.structureMountAngles);

    // Capital destruction S2b / sub-capital break-up slice 3: the wreck
    // descriptor deltas (adds, removes, resync chunk; the full set came with
    // the welcome). Pieces whose wreck is known get their predWorld body in
    // syncSwarmIntoPredWorld and a sprite.
    if (this._wrecks.applySnapshot(snap)) this.mirror.wrecks = this._wrecks.descriptors;

    // Server-authoritative boost + thrust sets — exhaust-trail renderer.
    applyBoostingThrustingSets(snap, this.mirror);

    // Phase 4 WS-B1 — mirror every ship's PUBLIC level (states[].level,
    // mirror-keyed post-route: active ships and parked hulls alike) onto
    // mirror.ships so the renderer paints the in-world level badge.
    applyShipLevels(snap, this.mirror);
    // R2.32 — a parked hull's shield state rides the snapshot (an active
    // ship's comes from the shield events; see applyParkedHullShieldDown).
    applyParkedHullShieldDown(snap, this.mirror);
    applyShipWarp(snap, this.mirror);
    this.syncRemoteWarpBodies(snap);

    // Phase 4 WS-B3 — mirror every ship's PUBLIC activated latent mounts
    // (states[].mounts, mirror-keyed post-route, parked hulls included) onto
    // mirror.ships so the renderer draws the extra turrets.
    applyActivatedMounts(snap, this.mirror);

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
    // Game time scale: the sector's speed rides the snapshot (#16). The game
    // clock stays continuous across a change, so the anchor (game ms) stays
    // valid and the eased path below absorbs the small timing difference: the
    // server glides speed changes (the dimmer), so each step is small.
    const snapScale = snap.timeScale?.s ?? 1;
    // The glide basis (the dimmer): the speed + target the server reported and
    // when. `followSpeedGlide` extrapolates from it every frame so the client's
    // clock moves in step with the server's (no lag through a glide).
    this._glideS = snapScale;
    this._glideT = snap.timeScale?.t;
    this._glideAtMs = wireArrivalAtMs;
    if (this._glideT === undefined) this.applyLocalSpeed(snapScale);
    else this.followSpeedGlide();
    if (useUIStore.getState().timeScale !== Math.round(this.gameClock.scale * 100) / 100) {
      useUIStore.getState().setTimeScale(Math.round(this.gameClock.scale * 100) / 100);
    }
    const gameNowMs = this.gameClock.at(now);
    if (this._anchorInitialised) {
      const next = updateAnchor(
        { anchorServerTick: this.clockAnchorServerTick, anchorPerfNow: this.clockAnchorPerfNow },
        snap.serverTick,
        gameNowMs,
      );
      this.clockAnchorServerTick = next.anchorServerTick;
      this.clockAnchorPerfNow = next.anchorPerfNow;
      this._anchorFreshAtMs = now;
    } else {
      this.clockAnchorServerTick = snap.serverTick;
      this.clockAnchorPerfNow = gameNowMs;
      this._anchorInitialised = true;
      this._anchorFreshAtMs = now;
    }
    // Stage 4 — lead = input path mean + 2σ, from the server's input margin.
    // See rttLookaheadUpdater.ts for the full rationale.
    this.leadTicks = updateRttAndLookahead(intervalMs, {
      reconciler: this.reconciler,
      stats: this.stats,
      rttWelford: this._rttWelford,
      lookaheadCtrl: this._lookaheadCtrl,
      leadTicks: this.leadTicks,
      lastFrameMs: this.lastFrameMs, inputMargin: snap.inputMargin, timeScale: this.gameClock.scale,
    });
    this.stats.droppedSnapshotsRecent = this._dropDetector.dropCount;

    // Drone snapshot slice (slim turret/shield slice; pose flows on the
    // binary swarm wire). See snapshotRemoteSync.ts. Applied for EVERY
    // recipient, before the own-ship gate below: a spectator (no active
    // ship) or a pilot whose reconciler hasn't bootstrapped still watches
    // NPC turrets train and fire. It used to sit inside the own-ship block,
    // so spectating froze every NPC turret where it was while its shells
    // (events, not the snapshot) kept leaving the real barrels: the
    // capital-turrets clip, 2026-11-12 (ColyseusClient.spectatorTurrets.test).
    // Campaign 2.1: the per-recipient `hostile` bit feeds the client
    // hostility ledger, the snapshot backstop for the discrete `bot_aggro`
    // accelerant (invariant #16). `_snapshotHostileMark` is a bound field,
    // not a closure (handleSnapshot is a hot path, #14).
    applyDroneMountAngles(snap, this.mirror, this._snapshotHostileMark);
    // WS-4 Phase 6: slim MINED-asteroid resource slice → swarm mirror (R2.23
    // enabler; feeds the WS-9 inspector). Pose stays on the binary channel.
    applyAsteroidResources(snap, this.mirror);

    if (!localId || !this.reconciler) {
      if (this.predWorld) {
        // No own ship to reconcile (command view / spectating — the RTS
        // default — or the reconciler hasn't bootstrapped): remote ships
        // still take the SAME per-snapshot path as while piloting, minus the
        // replay. `preResetRemoteShips` anchors every remote body (other
        // pilots AND parked / AI-flown hulls) to its snapshot state, records
        // its input bits for forward prediction and its mount angles, and
        // anchors drones/scrap; the decaying offsets hide the correction.
        // (RTS Part A S3: the deleted parked-hull manager did this for hulls
        // only; other pilots' ships were teleported with frozen turrets.)
        this._preResetRemoteShipsCtx.predWorld = this.predWorld;
        const preResetRemotePos = preResetRemoteShips(snap, localId ?? '', this._preResetRemoteShipsCtx);
        computeRemoteLerpOffsets({
          predWorld: this.predWorld,
          preResetRemotePos,
          remoteShipOffsets: this._remoteShipOffsets,
          predGuard: this._predGuard,
          stats: this.stats, serverTick: snap.serverTick, gameNowMs, states: snap.states,
        });
      }
      // Command / Build (#16): the own cargo rides the parked hull's entry (its shipInstanceId).
      const parked = this.mirror.localShipInstanceId, pst = parked ? snap.states[parked] : undefined;
      if (parked && pst !== undefined) this.applyLocalCargo(parked, pst.cargo, pst.fitted);
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
      const recovered = recoverInputTickFromStarvation(this.inputTick, ackedTick, this.gameLeadTicks());
      if (recovered !== this.inputTick) {
        this.inputTick = recovered;
        // Re-anchor the wall-clock so subsequent rafTicks don't try to
        // catch up the gap we just skipped over.
        this.clockAnchorServerTick = snap.serverTick;
        this.clockAnchorPerfNow = gameNowMs;
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
        this._energySeeded = true;
        const localKind = getShipKind(this.mirror.ships.get(localId)?.kind ?? null);
        const max = localKind.energyMax ?? 100;
        if (useUIStore.getState().energyMax !== max) useUIStore.getState().setEnergyMax(max);
      }

      // Phase 4 WS-B2 — re-anchor the local predWorld body's PHYSICS stat
      // multipliers from the authoritative own-ship `statAlloc` slice (the
      // server emits it own-active-only, when non-upgraded → absent). This is
      // the single ownership site for the client's physics multipliers — read
      // identically to the server so reconciliation stays clean (risk #1). The
      // `ship_upgrade_applied` echo is UI-only; the SNAPSHOT is the physics
      // truth, so an upgrade applied while the player is in another sector still
      // takes effect the moment its own-ship slice arrives.
      this.applyLocalStatAlloc(localId, serverState.statAlloc);
      // Living World P1a (#16) — the authoritative own-ship cargo slice.
      this.applyLocalCargo(localId, serverState.cargo, serverState.fitted);
      // Economy (#16) — wallet + free launches (store writes only on change).
      syncOwnEconomy(serverState, this._fakeCredits);
      // Living World P1a-2 — auto-deposit progress ring (quantised to 10 % so
      // the 2 s dwell costs ≤ 10 store writes, not one per snapshot).
      const dep = depositReadout(serverState.depositing);
      if (useUIStore.getState().depositPct !== dep) useUIStore.getState().setDepositPct(dep);
      // Shield toggle (#16): the pilot dropped the shields (HUD ring shows DOWN).
      const lowered = serverState.shieldsLowered === true;
      if (useUIStore.getState().shieldsLowered !== lowered) useUIStore.getState().setShieldsLowered(lowered);
      // Fire control (#16): the pilot's groups + locks, always applied.
      this.fc.applyFcGroups(serverState.groups);
      this.mirror.localLockedBy = serverState.lockedBy ?? NO_LOCKED_BY;
      this.mirror.localLockedByTotal = serverState.lockedByN ?? 0;
      this.mirror.localLockedByLocked = serverState.lockedByL ?? 0;

      // Probe 5 (mobile-perf-investigation, 2026-05-24) — instrument
      // reconcile separately from the rest of handleSnapshot. The
      // y0eo1h capture (Pixel 6, fpscap=10) showed applyMs growing
      // linearly with ticksAhead (1.0 ms + 0.04 ms × ticksAhead),
      // confirming reconcile is the dominant cost. `replayWindow` and
      // `reconcileMs` go onto the snapshot_applied event so a single
      // capture distinguishes reconcile time from everything-else time.
      // v4 T2 — a teleporter moved our ship: re-seed prediction at the
      // authoritative pose once per epoch (a snap, not a long reconcile slide).
      // v4 A (#16) — an alien gate disabled us: engines and weapons off until then.
      this.applyLocalDisabled(serverState.disabledMs ?? 0);
      const epoch = serverState.poseEpoch ?? 0;
      let teleported = false;
      if (epoch !== this._localPoseEpoch) {
        const seen = this._localPoseEpoch !== -1;
        this._localPoseEpoch = epoch;
        if (seen && this.predWorld) {
          this.predWorld.setShipState(localId, serverState);
          this.reconciler = new Reconciler(this.predWorld, localId, this.clock);
          teleported = true;
          logEvent('teleport_reseed', { epoch, x: serverState.x, y: serverState.y });
        }
      }
      // Curtain up = tickPhysics paused: nothing predicted live, so no replay.
      const replayTo = reconcileReplayTick(computeIsLoadingActive(useUIStore.getState()), this.inputTick, ackedTick);
      const replayWindow = replayTo - ackedTick;
      const reconcileStartMs = this.clock.now();
      if (!teleported) this.reconciler.reconcile(
        serverState,
        snap.serverTick,
        replayTo,
        ackedTick,
        (t) => {
          // Structure rig parts (restyle 2d) replay on the live loop's tick numbering.
          this.predWorld?.stepRigs(t + 1);
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
          stats: this.stats, serverTick: snap.serverTick, gameNowMs, states: snap.states,
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
      // `DebugTab`, which returns `null` while the drawer is closed (see
      // `src/client/layout/Drawer/tabs/DebugTab.tsx:43`). With the
      // drawer closed OR on a non-debug tab, no subscriber exists, so
      // pushing a fresh 19-field object into Zustand at 20 Hz pays
      // allocation + diff-check cost for nothing. Reading the gate
      // via `getState()` (non-subscribing, sync) is the established
      // pattern in this file (see clientSingleton.ts).
      const _ui = useUIStore.getState();
      if (_ui.rightPanel === 'cog' && _ui.drawerTab === 'debug') {
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

  /** The catalogue mounts of a `laser_fired` shooter's ship kind (a remote
   *  player's ship, or a `swarm-<id>` drone/capital), or undefined when the
   *  shooter isn't mirrored. Same lookup the renderer's beam loop does. */
  private shooterKindMounts(shooterId: string): readonly WeaponMount[] | undefined {
    const ship = this.mirror.ships.get(shooterId);
    if (ship) return ship.kind ? getShipKind(ship.kind).mounts : undefined;
    if (!shooterId.startsWith('swarm-')) return undefined;
    const entityId = parseInt(shooterId.slice('swarm-'.length), 10);
    const sw = Number.isNaN(entityId) ? undefined : this.mirror.swarm?.get(entityId);
    return sw?.shipKind ? getShipKind(sw.shipKind).mounts : undefined;
  }

  /** Swarm entries into the prediction world (`prediction/predWorldSync.ts`); tests call it. */
  private syncSwarmIntoPredWorld(): void { syncSwarmIntoPredWorld(this._predStepCtx); }

  /** Sync authoritative projectile positions from the per-recipient snapshot.
   *  Wire-discipline P3: projectiles no longer live on the Colyseus schema —
   *  the server includes only the in-interest subset on each snapshot, so a
   *  projectile leaving interest will simply disappear from `seen` and be
   *  removed from the mirror. Ghost projectiles (`isGhost: true`) are
   *  preserved; the GhostManager re-adds them per-frame anyway. */
  private syncProjectiles(projectiles: SnapshotMessage['projectiles']): void {
    syncProjectiles(this.mirror, projectiles, this._syncProjectilesSeenScratch, this.ghostManager.stoppedBolts);
  }

  // ── State mirror ────────────────────────────────────────────────────────

  /** Structures plan, Phase 3 — mirror the `structures[]` slice into
   *  `mirror.structures` (rebuilt each snapshot — it's low-cadence + small).
   *  Phase-1 issue 7: the ambiguous whole-grid power/minerals HUD readout was
   *  removed; per-structure stats live in-world (capital minerals + battery
   *  charge Pixi Text) + the selection inspector, so nothing is dispatched to
   *  the HUD store here. */
  private _structureMap: Map<number, StructureRenderState> | null = null;
  /** Interned owner tables (index → id / name), refreshed from room state. */
  private readonly _structureOwners: { ids: string[]; names: string[] } = { ids: [], names: [] };
  /** Mine Layer — room-state `mines` into `mirror.mines` (`mirror/mineSync.ts`). */
  private readonly _mines = new MineSync(this.mirror, this._structureOwners, () => this.room);
  /** A2 — room-state `structures` into `mirror.structures` (`mirror/structureRowSync.ts`). */
  private readonly _structureRows = new StructureRowSync(this.mirror, this._structureOwners);

  /** Beam links (shared-types/beamLinksWire.ts): structure turret / mining
   *  targets onto their rows; ship tractor links go to the tractor client
   *  slice (`tractorLinks.ts`: mirror rows + predWorld fields). Bound once. */
  private readonly _tractors = new TractorLinkClient(this.mirror, this._swarmBodyKeyCache);
  private readonly _beamLinkVisitor: BeamLinkVisitor = {
    structure: (sid, turret, mining) => {
      const row = this._structureMap?.get(sid);
      if (!row) return;
      // B2 — a negative slot below NONE is a PLAYER target (an owner-table index).
      const ownerIdx = decodePlayerTurretTarget(turret);
      if (ownerIdx >= 0) row.turretTargetPlayerId = this._structureOwners.ids[ownerIdx];
      else if (turret !== STRUCTURE_TARGET_NONE) row.turretTargetId = turret;
      if (mining !== STRUCTURE_TARGET_NONE) row.miningTargetId = mining;
    },
    tractor: this._tractors.add,
  };

  /** Coastal defences — copy one structure's server turret angles onto its
   *  row (the array is reused, #14). Bound once. */
  private readonly _applyStructureMountAngles = (entityId: number, flat: readonly number[], start: number, count: number): void => {
    const row = this._structureMap?.get(entityId);
    if (!row) return;
    const a = row.mountAngles ?? (row.mountAngles = []);
    a.length = count;
    for (let k = 0; k < count; k++) a[k] = flat[start + k]! / MOUNT_ANGLE_QUANTUM;
  };

  /**
   * A2 (plan soft-leaping-truffle v2) — structure grid state arrives as ROOM
   * STATE (`state.structures`: the join payload, then delta patches), not in
   * every snapshot. Decode it into the unchanged `mirror.structures` shape in
   * place, then overlay the snapshot's fast cosmetics (turret / mining targets).
   * Allocation-free once every row exists.
   */
  private syncStructures(
    targets: SnapshotMessage['structureTargets'],
    mountAngles?: SnapshotMessage['structureMountAngles'],
  ): void {
    this._structureRows.sync(this.room);
    const map = this.mirror.structures;
    this._structureMap = map ?? null;
    if (map && map.size > 0 && mountAngles) forEachStructureMountAngles(mountAngles, this._applyStructureMountAngles);
    // Beam links walk with or without structures: a tractor needs none.
    this._tractors.sync(targets, this._beamLinkVisitor, this.predWorld);
    this.syncPredWalls();
    this.syncForceFields();
    syncRigClips(this.predWorld, this.mirror.structures, this._swarmBodyKeyCache);
    this._mines.sync();
  }

  /** Scratch for `syncForceFields` (`setForceField` copies it; no per-frame object). */
  private readonly _padForceField: PadForceField = { kind: 'pad', cx: 0, cy: 0, half: 0, active: false };

  /** v4 T2 — each teleporter's closing push in the prediction world, from the
   *  room-state phase (the server worker runs the same field, #15). */
  private syncForceFields(): void {
    const world = this.predWorld;
    const structures = this.mirror.structures;
    const swarm = this.mirror.swarm;
    if (!world || !structures || !swarm) return;
    for (const [id, st] of structures) {
      const t = st.teleport;
      if (t === undefined) continue;
      const e = swarm.get(id);
      if (!e || !isTeleporterKind(e.shipKind)) continue;
      const f = this._padForceField;
      f.cx = e.x; f.cy = e.y; f.half = PAD_SPECS[e.shipKind].padRadius; f.active = t.phase === TP_PHASE.CLOSING;
      world.setForceField(padFieldId(id), f);
    }
  }

  /**
   * Shield-fence plan — keep the local predWorld's shield-wall colliders in sync
   * with the active fences (the "every collidable entity must be in predWorld"
   * rule), so the LOCAL player is predicted-blocked by an up wall instead of
   * predicting through it and rubber-banding to the server. Snapshot cadence
   * (NOT the per-frame loop): walls are static + low-count, so a reconcile here
   * is cheap. Every wall (fence walls, teleporter irises) is derived by the
   * shared `visitDerivedWalls`, the rules the renderer draws with and the server
   * collides with (#15). A wall that isn't blocking (down, or an unsealed iris)
   * keeps its body with the collider disabled. Gate doors are rig leaves, not walls.
   */
  private syncPredWalls(): void {
    if (!this.predWorld) return;
    const structures = this.mirror.structures;
    const swarm = this.mirror.swarm;
    const gen = ++this._predWallGen;
    // Same centre as structures / wrecks / the cut field: my ship, else my
    // parked hull (Command view); neither ⇒ every wall.
    const me = streamCentreShip(this.mirror);
    this._predWallShipX = me ? me.x : NaN;
    this._predWallShipY = me ? me.y : NaN;
    if (structures && swarm) visitDerivedWalls(structures, swarm, this._predWallVisitor);
    for (const [key, w] of this._predWalls) {
      if (w.gen === gen) continue;
      this.predWorld.removeWall(w.id);
      this._predWalls.delete(key);
    }
  }

  private syncMirror(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const ships = s['ships'] as Map<string, unknown> | undefined;
    // Projectiles are no longer on the Colyseus schema — see syncProjectiles
    // call inside the snapshot handler.
    if (!ships) return;

    const localId = this.mirror.localPlayerId;
    const now = this.clock.now();
    const seen = this._syncMirrorSeenShipsScratch;
    seen.clear();

    // Phase 6b — state.ships is now shipInstanceId-keyed on the wire.
    // The iteration variable would be misnamed if we still called it
    // `playerId`; rename and resolve the owner via the `playerId` field
    // on the schema entry. Mirror / predWorld / remoteHistory remain
    // playerId-keyed internally (C-ii strategy), matching the snapshot
    // ingest translation in handleSnapshot. Parked hulls (isActive ===
    // false) key by shipInstanceId in the SAME `mirror.ships` (RTS Part A
    // S3), so they don't collide with the active hull's playerId.
    const keyLocal = this._syncMirrorKeyLocal;
    keyLocal.localPlayerId = this.mirror.localPlayerId;
    keyLocal.localShipInstanceId = this.mirror.localShipInstanceId ?? null;
    keyLocal.localSpectating = useUIStore.getState().pilotMode === 'spectator';
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
      // The ONE ship-key rule, shared with `snapshotShipRouter`
      // (`shipMirrorKey`; plan crispy-kazoo Commit 8 local-self exemption):
      // the joiner's OWN welcome ship keys by playerId (stays in
      // `mirror.ships`) during the pending-join handshake; a displaced own
      // hull, and the hull we PARKED while spectating, key by shipInstanceId.
      // Without those limits a Spectate re-seeded `mirror.ships[localId]` from
      // this pose-less schema entry (x/y default 0) and respawned a predicted
      // local ship at the world origin that no snapshot corrects (2026-11-12
      // capital-turrets take). Lock: spectateOwnHullDrawnPose.test.ts.
      const key = shipMirrorKey(shipInstanceId, playerId, isActive, keyLocal);
      if (key !== null && key !== playerId) {
        // Phase 6b / RTS Part A S3 — identity for a parked hull, in the ONE
        // ship list under its shipInstanceId. Pose arrives separately in the
        // snapshot's `states` slice (router seed, then the remote-ship body).
        // We only set kind / displayName / ownerPlayerId here from the schema
        // diff (low-frequency). Probe 8 — pool the entry; pose preserved by
        // NOT touching it. A hull's LIFETIME is the snapshot router's (its
        // eviction sweep), so the departed sweep below skips hull keys.
        const kind = typeof sh['kind'] === 'string' ? (sh['kind'] as string) : undefined;
        const displayName = typeof sh['displayName'] === 'string' ? (sh['displayName'] as string) : undefined;
        // Seamless hand-over (RTS Part A): the ship drawn under its pilot's
        // playerId until now (its controls were let go) MOVES here.
        if (!this.mirror.ships.has(shipInstanceId)) {
          const from = findRekeySource(this.mirror.ships, shipInstanceId, shipInstanceId);
          if (from !== null) this.rekeyShip(from, shipInstanceId);
        }
        let lEntry = this.mirror.ships.get(shipInstanceId);
        if (!lEntry) {
          lEntry = {
            x: 0, y: 0, vx: 0, vy: 0, angle: 0,
            ownerPlayerId: playerId,
            isActive: false,
            shipInstanceId,
          };
          this.mirror.ships.set(shipInstanceId, lEntry);
        } else {
          lEntry.ownerPlayerId = playerId;
          lEntry.isActive = false;
          lEntry.shipInstanceId = shipInstanceId;
        }
        if (kind !== undefined) lEntry.kind = kind;
        if (displayName !== undefined) lEntry.displayName = displayName;
        copySchemaHealth(sh, lEntry);
        // Laser-"ghost-at-(0,0)" fix (2026-06-03) + B2. This path is
        // IDENTITY-ONLY — it does NOT spawn the predWorld body. The
        // snapshot path (`spawnRemoteShipBodies`) is the SOLE spawn site.
        // Removed: the old Phase-6b race-fallback spawn here.
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

      // Spectating, the pilot flies nothing. An own ACTIVE entry here is the
      // hull just parked: `sendSpectate` despawns the local body at once, but
      // the server's `isActive=false` patch lands a tick or more later, and
      // this pose-less entry (x/y 0) re-predicted a local ship that no
      // snapshot corrects. The renderer then drew it as the pilot's ship and a
      // 'local' camera cue followed it, not the parked hull (capital-breakup
      // take, 2026-11-12). Locks: ColyseusClient.spectateRace.test.ts,
      // tests/e2e/spectate-no-phantom-own-ship.spec.ts.
      // `shipMirrorKey` returns null for exactly this case.
      if (key === null) continue;
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
        // Update the existing entry IN PLACE: replacing it wiped the fields
        // only the snapshot writes (warp, level, shieldDown, mountAngles), so
        // they flickered at the patch rate (an onlooker's warp spool glow never
        // built). Lock: ColyseusClient.remoteMirrorPreserve.test.ts. The
        // schema carries no pose (its x/y are 0), so an existing entry's pose
        // is left alone: it is the snapshot's / the body's.
        // Seamless hand-over (RTS Part A): another pilot took the controls of
        // a hull drawn under its shipInstanceId; it MOVES to their playerId.
        if (!this.mirror.ships.has(playerId)) {
          const from = findRekeySource(this.mirror.ships, shipInstanceId, playerId);
          if (from !== null) this.rekeyShip(from, playerId);
        }
        const prevEntry = this.mirror.ships.get(playerId);
        if (prevEntry) {
          if (kind !== undefined) prevEntry.kind = kind;
          if (displayName !== undefined) prevEntry.displayName = displayName;
        } else {
          this.mirror.ships.set(playerId, mirrorEntry);
        }
        // No body spawn here (B2): the schema has no pose. The next snapshot
        // spawns it at its real pose (`spawnRemoteShipBodies`).
      } else if (!this.predWorld?.hasShip(playerId)) {
        this.mirror.ships.set(playerId, mirrorEntry);
        this.tryInitPredWorld(playerId);
      }
      // Mirror the wire's owner + `isActive` onto the drawn entry (RTS Part
      // A S0). Read only through `render/shipOwnership.ts` (#17).
      const drawn = this.mirror.ships.get(playerId);
      if (drawn) {
        drawn.ownerPlayerId = playerId;
        drawn.isActive = isActive;
        drawn.shipInstanceId = shipInstanceId;
        copySchemaHealth(sh, drawn);
      }
    }

    // Remove departed ships. Covers ACTIVE ships only (#17): a parked hull's
    // lifetime is the snapshot router's eviction sweep (pre-S3 it lived in a
    // separate map this sweep never saw), and a hull is not a player leaving,
    // so it never purges hostility.
    for (const [key, entry] of this.mirror.ships) {
      if (isParkedHull(this.mirror, key, entry)) continue;
      if (!seen.has(key) && !this._shellTiming.shipKills.has(key)) {
        this.dropRemoteShip(key);
        // Phase 1 AI: a player has left the sector (transit out, disconnect,
        // or fell out of state). Mirror the server's `purgeHostility` call
        // so client-side drones forget them at the same Colyseus state-diff
        // point the server forgets them at its own `onLeave`.
        this._aiController.purgeHostility(key);
      }
    }

    // Owner (2026-11-14): the ship counter counts EVERY ship, parked /
    // AI-flown hulls included (they are in `mirror.ships` since S3).
    useUIStore.getState().setShipCount(this.mirror.ships.size);
  }

  /**
   * Called once per render frame by App.tsx before renderer.update().
   */
  /** `frameNowMs`: the frame's own timestamp (the RAF time), so the local ship
   *  is drawn where it is at the moment the frame stands for, not wherever the
   *  clock had got to after this frame's snapshot work. Absent ⇒ the clock. */
  updateMirror(frameNowMs?: number): void {
    this.mirror.frameTimeMs = frameNowMs ?? this.clock.now();
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

    // The passes live in `mirror/` (one function each, ctx built once, #14);
    // order matters: the local ship first, the travel override last.
    const pc = this._mirrorPassCtx;
    drainScheduledDamageSpawns(pc);
    updateLocalShipMirror(pc, frameNowMs, localId);
    updateSpectatorPlacement(pc, localId);
    updateServerGhost(pc);
    updateSwarmMirror(pc);
    updateRemoteShipsMirror(pc, localId, frameNowMs);
    // Parked / AI-flown hulls ride the remote-ship loop above (RTS Part A S3:
    // their bodies are in `predRemoteShipIds` under the bare shipInstanceId),
    // so the old parked-hull offset loop is gone.
    updateProjectilesMirror(pc, frameNowMs);
    this.mirror.rigTick = rigClockTick(pc, frameNowMs, this.welcomePerfNow !== 0);
    expireFrameState(pc);
    updateDroneHostility(pc, localId);

    // Phase 4 travel state: during a sector-to-sector trip the local ship flies
    // on at warp speed along its heading (the trip is the loading screen).
    // Written last, so it overrides the normal local write while the trip lasts.
    if (this._travel !== null && localId !== null) {
      const e = this.mirror.ships.get(localId);
      if (e) {
        stepTravel(pc, this._travel, e, localId);
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

  /** The camera (`RendererFeedback.viewX/viewY/viewHalf`), each frame: the cut field draws around it too. */
  setFieldView(x: number, y: number, viewHalf: number): void { this._cutField.setView(x, y, viewHalf); }

  // ── Helm orders: `prediction/inputStep.ts` (one-line delegates) ────
  setHelmCourse(x: number, y: number): void { setHelmCourse(this._predStepCtx, x, y); }
  setHelmSpeed(speed: HelmSpeed): void { setHelmSpeed(this._predStepCtx, speed); }
  clearHelm(): void { clearHelm(this._predStepCtx); }
  /** Test/showcase read of the helm (`__eqxHelm`). */
  getHelmOrder(): Readonly<HelmOrder> { return this._helmOrder; }
  private publishHelm(): void { publishHelm(this._predStepCtx); }
  private syncHelmMark(): void { syncHelmMark(this._predStepCtx); }
  private updateHelmAvailability(): void { updateHelmAvailability(this._predStepCtx); }
  private stepHelm(): void { stepHelm(this._predStepCtx); }

  tickPhysics(elapsedMs: number): void {
    if (!this.room || !this.keyboard) return;
    this.lastFrameMs = elapsedMs;
    if (this.welcomePerfNow === 0) return; // welcome not yet received
    // Inbound-drain is now done by `tickInbound` (called from
    // gameRafLoop above the loading pause boundary). tickPhysics is
    // the input-loop + physics-step portion only.
    this.followSpeedGlide();
    const ticksSinceAnchor = Math.floor((this.gameClock.now() - this.clockAnchorPerfNow) / FIXED_MS);
    const targetTick = this.clockAnchorServerTick + ticksSinceAnchor + this.gameLeadTicks();
    const tickDeficitBefore = targetTick - this.inputTick;
    // Over-prediction cap, measured from the last acked input, or from the
    // latest server tick (the clock anchor: welcome, then every snapshot)
    // until the first ack. It used to switch off with no ack (capital-fixes
    // S1, 2026-11-22: a Command join never acks, so the cap never held).
    const overPredictionCap = (this.stats.lastAckedTick > 0 ? this.stats.lastAckedTick : this.clockAnchorServerTick)
      + MAX_OVER_PREDICTION_TICKS;
    // A stall (loading curtain, background tab) is skipped, not replayed at 4
    // ticks a frame, and only from a FRESH clock anchor: hold until a snapshot
    // re-syncs it (inputTickRecovery.stallResumeAction; lock: loading-catchup.spec.ts).
    // Never past the over-prediction cap: a backlog the cap held is not a stall.
    {
      const nowMs = this.clock.now();
      const resume = stallResumeAction(
        tickDeficitBefore, nowMs - this._anchorFreshAtMs,
        this._stallHoldSinceMs < 0 ? 0 : nowMs - this._stallHoldSinceMs,
      );
      if (resume === 'hold') {
        if (this._stallHoldSinceMs < 0) this._stallHoldSinceMs = nowMs;
        return;
      }
      this._stallHoldSinceMs = -1;
      if (resume === 'skip') {
        this.inputTick = skipStalledBacklog(this.inputTick, targetTick, overPredictionCap);
      }
    }
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
    // Desktop RMB boost is only live while piloting (spectating has no ship).
    // The loading curtain already skips tickPhysics.
    aimInput.setEnabled(useUIStore.getState().pilotMode !== 'spectator');
    this.updateHelmAvailability();
    this.syncHelmMark(); // the spectator flip doesn't pass through publishHelm
    // No own body to predict (Command / spectating: no Reconciler) ⇒ no
    // stepping. Remote ships and parked / AI-flown hulls are re-anchored each
    // snapshot and drawn through their decaying lerp offsets; drones, scrap,
    // rocks and structures draw off the wire. Stepping the whole-sector
    // prediction world 4 ticks a frame here was the 14 fps Command join
    // (capital-fixes S1). Same as Command after flying, where the frozen ack
    // already held the cap shut. Piloting re-seeds the body, then the stall
    // skip above jumps to the target.
    const hasLocalBody = this.reconciler !== null;
    while (hasLocalBody && this.inputTick < targetTick && stepsThisFrame < MAX_CATCH_UP_TICKS) {
      if (this.inputTick >= overPredictionCap) {
        capEngaged = true;
        break;
      }
      stepsThisFrame++;
      stepInputTick(this._predStepCtx, this.room, kb);
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
    // Fire control (universal): every weapon group fires only at a target it
    // has a COMPLETED lock on — AUTO groups on their own, MANUAL groups while
    // held (weapon-strip chip) or Space on the active group. No free fire: the
    // server refuses a player shot without a lock.
    // Aim guides: none — the lock rings and firing lines replace them.
    this.mirror.localAimMountIds = EMPTY_AIM_IDS;
    this.fc.fcFireTick(kb.fireHeld);

    // Predict the energy pool for the frame (weapons/energy/AI overhaul
    // §3.2): regen every stepped tick + drain a boost tick while boosting,
    // mirroring the server's tickShipEnergy. Fire drain happens in sendFire. The
    // snapshot reconcile hard-sets the value, so this only smooths the bar
    // between snapshots. Scalar core helpers ⇒ no allocation.
    predictFrameEnergy(this._predStepCtx, stepsThisFrame);

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
    sendCapSentinel(this._predStepCtx, this.room, kb, stepsThisFrame, capEngaged);

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
   *      reset on every snapshot. Once it hits remoteForwardTickCap(lead)
   *      we stop applying input for that remote until the next snapshot.
   *      A long network stall otherwise would let speculation run away.
   */
  private applyRemoteInputs(): void {
    if (!this.predWorld) return;
    // Every remote ship: other pilots and parked / AI-flown hulls alike.
    applyRemoteShipInputs(this.predWorld, this.predRemoteShipIds, this._remoteLastInputs, this._remoteForwardTicks, this._predGuard, this.gameLeadTicks());
  }

  /** The local ship's predicted turret angles (#12): `prediction/inputStep.ts`. */
  private tickLocalMountAim(dtSec: number): void { tickLocalMountAim(this._predStepCtx, dtSec); }

  /** The beam / hit-prediction ray world, pointed at the live predWorld and
   *  swarm mirror (both can be replaced across a sector handoff). */
  private displayHitscan(): DisplayPoseHitscan {
    const h = this._displayHitscan;
    h.world = this.predWorld;
    h.swarm = this.mirror.swarm;
    h.wrecks = this._wrecks;
    return h;
  }

  // ── Local fire + live beam: `LocalFireClient` (one-line delegates) ────
  private readonly _localFire = new LocalFireClient(((c: ColyseusGameClient): LocalFireHost => ({
    get mirror() { return c.mirror; }, get predWorld() { return c.predWorld; }, get room() { return c.room; },
    get reconciler() { return c.reconciler; }, get fc() { return c.fc; }, get ghostManager() { return c.ghostManager; },
    get clock() { return c.clock; },
    get predEnergy() { return c.predEnergy; }, set predEnergy(v) { c.predEnergy = v; },
    get scheduledDamageSpawns() { return c._scheduledDamageSpawns; },
    get damageFlashFrames() { return c._damageFlashFrames; }, get hitLedger() { return c._hitLedger; },
    get skipHitscanVisual() { return ColyseusGameClient.SKIP_HITSCAN_VISUAL_FLAG; },
    displayHitscan: (): DisplayPoseHitscan => c.displayHitscan(),
  }))(this));
  private updateLiveBeam(): void { this._localFire.updateLiveBeam(); }
  private localShipMounts(): ReadonlyArray<WeaponMount> { return this._localFire.localShipMounts(); }
  private sendFire(tick: number): void { this._localFire.sendFire(tick); }

  // ── Fire control: `FireControlClient` (one-line delegates) ────
  private readonly fc = new FireControlClient(this.mirror, {
    room: () => this.room,
    now: () => this.clock.now(),
    canFire: () => !this.localDead && this.predWorld !== null && this.room !== null && !this.isLocallyDisabled(),
    shipState: (id) => this.predWorld!.getShipState(id),
    predEnergy: () => this.predEnergy,
    inputTick: () => this.inputTick,
    sendFire: (tick) => this.sendFire(tick),
    updateLiveBeam: () => this.updateLiveBeam(),
    fired: (tick) => { this.lastFiredAtTick = tick; },
    hitscanFired: (nowMs) => { this._lastHitscanFireMs = nowMs; },
    lineRay: () => this.displayHitscan(), gameNow: () => this.gameClock.now(), swarmBodyKey: (n) => this._swarmBodyKeyCache.get(n),
  });
  requestLock(groupId: string, targetKey: string): void { this.fc.requestLock(groupId, targetKey); }
  fcGroupReach(groupId: string): number { return this.fc.fcGroupReach(groupId); }
  cancelLock(groupId: string, targetKey?: string): void { this.fc.cancelLock(groupId, targetKey); }
  setGroupMode(groupId: string, mode: 'auto' | 'manual'): void { this.fc.setGroupMode(groupId, mode); }
  setGroupHeld(groupId: string | null): void { this.fc.setGroupHeld(groupId); }
  updateLockGuide(bearing: number): string | null { return this.fc.updateLockGuide(bearing); }
  guideLock(bearing: number): void { this.fc.guideLock(bearing); }
  releaseLockGuide(): void { this.fc.releaseLockGuide(); }
  lockSelected(): boolean { return this.fc.lockSelected(); }

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
   *  overhaul §3.2). Read per-frame by the HUD energy fill (`useEnergyFill`)
   *  RAF loop + direct-DOM write — never via Zustand (it changes every frame). */
  /**
   * In-sector warp-to (Phase 4, solar-system sectors): ask to warp to a drop
   * point (a pocket's rim, or the near side of what is in the way: the picker's
   * `warpTargetFor` target). Held in every input until the local ship arrives; the
   * server ignores a point that isn't the target it computes itself.
   */
  public requestWarp(x: number, y: number): void {
    this.warpRequest = { x, y };
  }

  /** Stop asking to warp (cancels a spool; a run in progress completes). */
  public cancelWarp(): void {
    this.warpRequest = null;
  }

  /**
   * Phase 4 warp travel: another pilot's ship on its warp run is out of the
   * world, so it has no collision body here (nothing can bump into it); the
   * body comes back AT THE SNAPSHOT'S landing pose (the mirror still holds a
   * stale mid-run pose, so a body built from it would slide in from far
   * away and the arrival would be drawn off-screen). Per snapshot, alloc-free.
   */
  private syncRemoteWarpBodies(snap: SnapshotMessage): void {
    // Covers every remote mirror entry: other pilots and parked hulls (a
    // hull's warp is absent on the wire, so it never matches 2 / 3).
    const pw = this.predWorld;
    const localId = this.mirror.localPlayerId;
    if (!pw || localId === null) return;
    for (const [id, ship] of this.mirror.ships) {
      if (id === localId) continue;
      if (ship.warp === 2) {
        if (this.predRemoteShipIds.has(id)) this.dropRemoteShip(id, 'outOfWorld');
      } else if (ship.warp === 3) {
        // Just arrived (a warp drop or a join): put it at the snapshot pose
        // ONCE, before anything draws it, so the ship and its arrival effect
        // start at the same place (its body may be posed from a stale
        // room-state pose; drawing from that, the ship jumped ~500 u a frame
        // after appearing and the effect sat beside it).
        if (this._arrivalSnapped.has(id)) continue;
        const st = snap.states[id];
        if (st === undefined || ship.kind === undefined) continue;
        ship.x = st.x; ship.y = st.y; ship.vx = st.vx; ship.vy = st.vy; ship.angle = st.angle;
        if (!this.ensureRemoteShipBody(id, st, ship.kind)) pw.setShipState(id, st);
        this._remoteShipOffsets.delete(id);
        this._arrivalSnapped.add(id);
      } else if (this._arrivalSnapped.size > 0) {
        this._arrivalSnapped.delete(id);
      }
    }
  }
  /**
   * THE remote-body spawn site (RTS Part A S3 + blocker B2): for every remote
   * ship in this snapshot (other pilots under their playerId, parked /
   * AI-flown hulls under their shipInstanceId, post-route), spawn its
   * predWorld body at the SNAPSHOT pose once the mirror entry knows its kind
   * (the schema diff). Until then the entry is drawn at the snapshot pose.
   * Never the local ship (its body is `tryInitPredWorld`'s), never before the
   * welcome, never a ship on its warp run (`syncRemoteWarpBodies` lands it).
   * Covers ACTIVE and LINGERING remote ships (#17): both are in the world.
   */
  private spawnRemoteShipBodies(snap: SnapshotMessage): void {
    const pw = this.predWorld;
    const localId = this.mirror.localPlayerId;
    for (const key in snap.states) {
      if (key === localId) continue;
      const entry = this.mirror.ships.get(key);
      if (entry === undefined) continue;
      if (pw !== null && pw.hasShip(key)) continue;
      const st = snap.states[key]!;
      if (st.warp === 2) continue;
      entry.x = st.x; entry.y = st.y; entry.vx = st.vx; entry.vy = st.vy; entry.angle = st.angle;
      if (localId === null || entry.kind === undefined) continue;
      this.ensureRemoteShipBody(key, st, entry.kind);
    }
  }

  /** Remote ships already snapped to their arrival pose (warp 3). */
  private readonly _arrivalSnapped = new Set<string>();

  /** Phase 4 travel state: the sector-to-sector trip under way (the local
   *  ship's synthetic flight), or null. */
  private _travel: TravelTrip | null = null;

  /** ms until the ship has flown out of the old sector (the room swap waits
   *  for this, so the old sector never vanishes in view). */
  travelOutRemainingMs(): number {
    if (this._travel === null) return 0;
    return Math.max(0, TRAVEL_OUT_S * 1000 + 300 - (this.clock.now() - this._travel.startMs));
  }

  /** Start the trip: the local ship flies on along its heading at warp speed
   *  until `endTravel` (the destination has loaded). */
  beginTravel(): void {
    const id = this.mirror.localPlayerId;
    const e = id !== null ? this.mirror.ships.get(id) : undefined;
    if (!e) return;
    const now = this.clock.now();
    this._travel = {
      x: e.x, y: e.y, dx: -Math.sin(e.angle), dy: Math.cos(e.angle), angle: e.angle, lastMs: now, startMs: now,
      phase: 'out', inStartMs: 0, ax: 0, ay: 0, landed: false,
    };
    this.mirror.travelling = true;
  }

  /** End the trip: the local ship drops in at its real (predicted) pose. */
  endTravel(): void {
    if (this._travel === null) return;
    this._travel = null;
    this.mirror.travelling = false;
    this.mirror.travelDeep = false;
    const id = this.mirror.localPlayerId;
    const e = id !== null ? this.mirror.ships.get(id) : undefined;
    if (e) e.warp = undefined;
  }

  /** True while a sector-to-sector trip is under way. */
  isTravelling(): boolean {
    return this._travel !== null;
  }

  /** The local ship's predicted warp phase (`idle` / `spool` / `cruise`). */
  public getWarpPhase(): 'idle' | 'spool' | 'cruise' {
    const id = this.mirror.localPlayerId;
    return id && this.predWorld ? this.predWorld.warpPhase(id) : 'idle';
  }

  /** True while a warp request is held (spooling or about to). */
  public hasWarpRequest(): boolean {
    return this.warpRequest !== null;
  }

  public getPredictedEnergy(): number {
    return this.predEnergy;
  }

  /**
   * Phase 4 WS-B2 — re-anchor the local predWorld body's PHYSICS stat
   * multipliers from the authoritative own-ship `statAlloc` slice. Derives the
   * multipliers via the SAME `deriveStatMultipliers` the server feeds the
   * worker, so prediction scales movement IDENTICALLY (risk #1 / invariants #4,
   * #12). Guarded by a stable JSON key so identical allocations don't re-push
   * every snapshot. An absent / empty alloc resets to the neutral path.
   */
  /**
   * Living World P1a (#16) — mirror the AUTHORITATIVE own-ship cargo slice into
   * the discrete Zustand `cargo`. Called per applied snapshot, so it writes the
   * store ONLY when the contents actually changed (`cargoChanged` compares
   * field-by-field without allocating) — a steady hold costs zero renders.
   */
  private applyLocalCargo(
    localId: string,
    cargo: WireCargo | undefined,
    fitted?: string[],
  ): void {
    const s = useUIStore.getState();
    // P5 — fitted blueprints (store only on change; compared without allocating).
    if (!sameIds(s.fittedBlueprints, fitted)) s.setFittedBlueprints(fitted === undefined ? [] : fitted.slice());
    const capacity = Math.floor(
      cargoCapacityForMaxHealth(getShipKind(this.mirror.ships.get(localId)?.kind ?? null))
        * fittedCargoMul(fitted ?? EMPTY_IDS),
    );
    if (!cargoChanged(s.cargo, cargo) && s.cargoCapacity === capacity) return;
    s.setCargo(
      cargo === undefined ? null : cargoViewOf(cargo),
      capacity,
    );
  }

  private applyLocalStatAlloc(localId: string, alloc: Record<string, number> | undefined): void {
    if (!this.predWorld || !this.predWorld.hasShip(localId)) return;
    const decision = decideStatAllocReanchor(alloc, this._lastStatAllocKey);
    if (!decision.changed) return; // identical allocation since last apply
    this._lastStatAllocKey = decision.key;
    this.predWorld.setStatMultipliers(localId, decision.mul);
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

  /** v4 A — the local ship is disabled (alien-gate guns) right now. */
  private isLocallyDisabled(): boolean {
    return this._disabledUntilMs > 0 && this.clock.now() < this._disabledUntilMs;
  }

  /** v4 A — take the own-ship snapshot's `disabledMs`. The HUD deadline
   *  (Zustand, wall clock) is written only when the disable starts, ends or
   *  is re-applied, never per snapshot. */
  private applyLocalDisabled(ms: number): void {
    const now = this.clock.now();
    const until = ms > 0 ? now + ms : 0;
    const was = this._disabledUntilMs;
    this._disabledUntilMs = until;
    const wasOn = was > now;
    const isOn = until > now;
    if (wasOn !== isOn || (isOn && until - was > 1000)) {
      useUIStore.getState().setDisabledUntil(isOn ? Date.now() + ms : 0);
      if (isOn !== wasOn) logEvent('ship_disabled', { on: isOn, ms });
    }
  }

  get cutFieldStats(): CutFieldSummary { return this._cutField.summary(); } // cut-field-collision.spec.ts waits on it
  /** The cut field's options (null: no field): the warp picker's field map (`WarpRouteClient`). */
  get cutFieldOpts(): ReturnType<typeof createGameCutField>['fieldOpts'] { return this._cutField.fieldOpts; }

  dispose(): void { disposeClient(this._predResetCtx); }
}
