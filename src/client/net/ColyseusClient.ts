import { Client, Room } from 'colyseus.js';
import type { RenderMirror, ProjectileRenderState, ShipRenderState } from '@core/contracts/IRenderer';
import type { IAudio } from '@core/contracts/IAudio';
import type { WelcomeMessage, SnapshotMessage, HitAckMessage, DamageEvent, DestroyEvent, LaserFiredEvent, RespawnAckMessage, TransitStateMessage } from '@shared-types/messages';
import { PhysicsWorld, type ShipPhysicsState } from '@core/physics/World';
import { Reconciler, type InputRecord } from '@core/prediction/Reconciler';
import { springStep, type SpringState } from '@core/math/CritDampedSpring';
import {
  applyCollisionResolved,
  createCollisionGuard,
  type CollisionGuardState,
} from './applyCollisionResolved';
import { CollisionResolvedMessageSchema } from '@shared-types/messages';
import {
  createRemotePredictionGuard,
  recordRemoteCorrection,
  shouldForwardPredict,
  type RemotePredictionGuard,
} from './remotePredictionGuard';
import {
  createWelford,
  welfordPush,
  welfordMean,
  welfordStdDev,
  type WelfordState,
} from '@core/math/Welford';
import {
  createLookaheadController,
  computeDesiredLead,
  updateLookahead,
  type LookaheadController,
} from './lookaheadController';
import {
  createDropDetector,
  observeSnapshotTick,
  computeInterpBiasMs,
  type DropDetector,
} from './snapshotDropDetector';
import { recoverInputTickFromStarvation } from './inputTickRecovery';
import { useUIStore, type ConnectionStatus } from '../state/store';
import { logEvent } from '../debug/ClientLogger';
import { installLongtaskObserver } from '../debug/longtaskObserver';
import { GhostManager } from '../combat/GhostProjectile';
import { HITSCAN_RANGE, SHIP_MAX_HEALTH } from '@core/combat/Weapons';
import { getWeapon } from '@core/combat/WeaponCatalogue';
import type { TouchInput } from '../input/TouchInput';
import { decodeSwarmPacket } from './BinarySwarmDecoder';
import { setSwarmDisplayDelayMs, ADAPTIVE_DELAY_FACTOR } from './swarmInterpolation';
import { updateAnchor } from './clockAnchor';
import { getSector } from '@core/galaxy/galaxy';
import { generateAsteroidVertices } from '@core/swarm/asteroidShape';
import { AiController, type AiIntentSink } from '@core/ai/AiController';
import { HostileDroneBehaviour } from '@core/ai/HostileDroneBehaviour';
import type { AiEntity, AiPlayerView } from '@core/contracts/IAiBehaviour';
import { getShipKind, type WeaponMount } from '@shared-types/shipKinds';
import {
  pickTarget,
  rotateMountToward,
  wrapPi,
  type MountTargetView,
} from '@core/ai/WeaponMountController';

export interface ColyseusClientCallbacks {
  onConnectionStatus: (s: ConnectionStatus) => void;
  onPlayerId: (id: string) => void;
}

/** Timestamped remote-ship state snapshot for 100 ms display-delay interpolation. */
interface RemoteEntry {
  ts: number;
  state: ShipPhysicsState;
}

const HISTORY_MAX = 30;

/** Live prediction/latency metrics readable from the DOM or tests. */
export interface PredictionStats {
  /** RTT estimate from last reconciliation (ms). */
  rttMs: number;
  /** Prediction position drift at last reconciliation (world units). */
  driftUnits: number;
  /** Prediction angle drift at last reconciliation (radians). */
  angleDriftRad: number;
  /** Whether a visual lerp correction is currently decaying. */
  lerping: boolean;
  /** Interval between the last two snapshots (ms). 0 if < 2 snapshots received. */
  snapshotIntervalMs: number;
  /** Total snapshots received since connect. */
  snapshotCount: number;
  /** How many client input ticks are ahead of the last server-acked tick. */
  ticksAhead: number;
  /** Server tick of the last received snapshot. */
  lastServerTick: number;
  /** Last server-acked input tick for the local player. */
  lastAckedTick: number;
  /** Reconciliations that produced position drift > 0.05 u (filters float32 noise). */
  significantCorrectionCount: number;
  /** Reconciliations that produced angle drift > 0.001 rad (filters float32 noise). */
  significantAngleCorrectionCount: number;
  /** Largest single-reconciliation position drift observed (world units). */
  maxDriftUnits: number;
  /** Sum of all position drift magnitudes. Divide by snapshotCount for mean. */
  totalDriftUnits: number;
  /** Largest single-reconciliation angle drift observed (radians). */
  maxAngleDriftRad: number;
  /** Sum of all angle drift magnitudes. Divide by snapshotCount for mean. */
  totalAngleDriftRad: number;
  /** Max − min of the last 10 snapshot intervals (ms). 0 if < 2 snapshots. */
  snapshotJitterMs: number;
  /** Correction rate over the most recent 10-snapshot rolling window (0–1). */
  rollingCorrRate: number;
  /** Stage 2 — total `collision_resolved` events that mutated predWorld this
   *  session. Excludes events dropped by the stale or rate-limit guards. */
  collisionEventsApplied: number;
  /** Stage 4 — Welford running mean of per-snapshot RTT samples. */
  rttMeanMs: number;
  /** Stage 4 — Welford running standard deviation of per-snapshot RTT. */
  rttStdDevMs: number;
  /** Stage 4 — sliding-window count of dropped snapshots (last 10 arrivals). */
  droppedSnapshotsRecent: number;
  /** Phase B — sliding-window p50 of per-drone snap distance (last 240 events). */
  swarmSnapP50: number;
  /** Phase B — sliding-window p99 of per-drone snap distance (last 240 events). */
  swarmSnapP99: number;
  /** Phase B — sliding-window p99 of per-drone angle delta (last 240 events). */
  swarmAngleP99: number;
  /** Phase B — sliding-window p99 of per-drone angvel delta (last 240 events). */
  swarmAngvelP99: number;
  /** Phase B — total number of drone snaps logged since connect. Different from
   *  `swarm_snap_diagnostics` ring length (capped) — gives total volume. */
  swarmSnapCount: number;
}

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

/** Position drift below this is float32-serialisation noise. */
const NOISE_THRESHOLD = 0.05;
/** Angle drift below this is float32-serialisation noise (~0.057°). */
const ANGLE_NOISE_THRESHOLD = 0.001;

/** Spring half-life for remote-ship offset decay (Stage 1).
 *  Aligned with `Reconciler.halfLifeForDrift` so remote-ship and local-ship
 *  visual recovery are in lockstep — sub-pixel drifts settle imperceptibly
 *  fast (~75 ms total wall-clock); everything above the noise floor settles
 *  in ~125 ms. Pre-Stage-1 used a frame counter; Stage 1 took dtMs and
 *  applies a critically-damped spring so the recovery is frame-rate
 *  independent and reads as "alive". */
function remoteOffsetHalfLifeForDrift(drift: number): number {
  if (drift < 0.5) return 12;
  return 25;
}

/**
 * Half-life for drone render-pose lerp offsets — much longer than the
 * remote-ship version because drone snaps are structurally bigger.
 *
 * Math: each binary swarm packet snaps the drone backward by `LEAD_TICKS
 * × velocity × FIXED_DT` worth of motion (the predWorld was forward-
 * predicted ~6 ticks ahead). For V=30 u/s that's ~3 u; for V=100 u/s
 * it's ~10 u. The remote-ship 25 ms half-life decays the offset faster
 * than predWorld's forward advance can replace it, producing the
 * frame-to-frame backward motion the user reported as "double vision."
 *
 * Derivation in `tests/scenarios/droneRenderSmoothness.test.ts`: for
 * critically-damped spring x(t) = (x₀ + ω·x₀·t)·exp(-ω·t) starting
 * from rest, the per-frame decay rate is bounded above by predWorld's
 * forward advance rate when `H ≥ K·dt·√(LEAD_TICKS/2)` — about 48 ms
 * for `dt=16.67`, `LEAD_TICKS=6`. The threshold is V-independent.
 *
 * Picking 100 ms gives ~2× margin over the math bound. Larger snaps
 * (which suggest a real desync, not just leadTicks lookahead) get a
 * 150 ms half-life so the recovery is even gentler.
 */
function droneRenderOffsetHalfLifeForDrift(drift: number): number {
  if (drift < 1) return 100;
  return 150;
}

/** Wrap angle delta to [-π, π] so the spring lerps the short way around. */
function normalizeAngleDelta(a: number): number {
  const TWO_PI = 2 * Math.PI;
  let r = a % TWO_PI;
  if (r > Math.PI) r -= TWO_PI;
  if (r < -Math.PI) r += TWO_PI;
  return r;
}

/** Termination thresholds for remote-ship offset springs. Match the
 *  Reconciler's SPRING_POS_END / SPRING_VEL_END_MS so visual recovery
 *  ends consistently across local- and remote-ship offsets. */
const REMOTE_SPRING_POS_END = 0.05;       // matches LERP_THRESHOLD
const REMOTE_SPRING_VEL_END_MS = 0.05;    // 50 u/s

/** Stage 3 — maximum forward-prediction ticks per remote, per snapshot.
 *  At 60 Hz that's ~133 ms of speculative integration. A long network
 *  stall can leave `inputTick - serverTick` arbitrarily large, but we
 *  only speculate the remote's input for this many ticks beyond
 *  serverTick — additional ticks integrate the remote with damping
 *  only (pre-Stage-3 behaviour) so visible runaway speculation is
 *  bounded. Reset on every snapshot. */
const STAGE_3_MAX_LOOKAHEAD_TICKS = 8;

/** Stage 4 hotfix — clamp on RTT samples fed into the Welford state
 *  driving leadTicks. `Reconciler.lastRtt` is contaminated by snapshot-
 *  delay (it's `now - ackedRec.sentAt`, not the true TCP RTT), so a
 *  500 ms inbound network gap can push σ past 200 ms and saturate the
 *  prediction window at the 30-tick cap. Clamping samples at 250 ms
 *  bounds σ even under Pattern A spikes; real-world high-RTT clients
 *  (international, cellular) routinely measure 100–250 ms, so the
 *  clamp doesn't penalise them. See `docs/LESSONS.md` for the
 *  diagnostic. */
const RTT_SAMPLE_CLAMP_MS = 250;

/** Stage 4 hotfix #3 (2026-05-08 third diagnostic) — gate the Welford
 *  RTT push on snapshot `intervalMs` being inside the steady-state
 *  cadence band. Server broadcasts every 3 server ticks (50 ms nominal
 *  at 60 Hz); real wall-clock jitter spreads this to roughly [35, 75] ms.
 *  Outside that range, the snapshot is part of a Pattern A gap (huge
 *  interval) or a burst-recovery cluster (tiny interval) — its
 *  `Reconciler.lastRtt` is contaminated by snapshot-delay even after
 *  the σ-clamp, so it inflates the running mean. Gating the push lets
 *  Welford track only clean samples; mean stays near live RTT and
 *  leadTicks stays sized for combat. See `docs/LESSONS.md`. */
const STEADY_STATE_INTERVAL_MIN_MS = 35;
const STEADY_STATE_INTERVAL_MAX_MS = 75;

/** Simple monotonically incrementing shot ID generator. */
let _shotCounter = 0;
function nextShotId(): string {
  return `shot-${_shotCounter++}`;
}

/** Joystick magnitude below this is treated as idle (deadzone). */
const TOUCH_DEADZONE = 0.2;
/** Stick magnitude above this engages thrust (when roughly aligned with target). */
const TOUCH_THRUST_MAG = 0.4;
/** Allow thrust within this cone (radians) around the desired heading. */
const TOUCH_THRUST_CONE = Math.PI / 3; // 60°
/** Minimum |angular delta| (radians) before turning. Prevents jitter when aligned. */
const TOUCH_TURN_TOLERANCE = 0.08; // ~4.6°
/** Idle-input heartbeat (network-discipline P4). When the control state has
 *  not changed for this long, we re-send the latest state once anyway, so the
 *  server can detect a missing client (idle != disconnected) and so a UDP
 *  restart-style replacement of the last-applied input still happens. 250 ms
 *  is well below `lastSentInput` perception lag for a held-key change but
 *  well above the per-tick 16.67 ms cadence — net result is a 60 → ~4 Hz
 *  drop on idle. */
const INPUT_HEARTBEAT_MS = 250;

export class ColyseusGameClient {
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
    pendingHealthBarHits: [],
  };

  /** Keys (`swarm-${entityId}`) of swarm bodies currently spawned in the prediction world. */
  private predSwarmKeys = new Set<string>();

  /**
   * Phase 3 of the network-feel reset (2026-05-09): client-side drone AI.
   *
   * The same `AiController` + `HostileDroneBehaviour` modules the server runs,
   * driving the same drone bodies (in the client's predWorld) with the same
   * deterministic intent the server is producing on its side. This closes
   * the "drones not predicted client-side" architectural gap that produced
   * the 22 u correction bursts in cap `2026-05-09T09-54-45-849Z-8grdi1`
   * and the visible clip-through the user reported.
   *
   * Sink: applies the AI's per-tick (fx, fy, torque) directly to the matching
   * `swarm-${entityId}` body in `predWorld` via `applyImpulse`. The slot
   * passed to `postIntent` is the numeric drone entityId — same key the
   * mirror uses, so no mapping needed.
   */
  private readonly _aiSink: AiIntentSink = {
    postIntent: (slot, fx, fy, torque, setAngvel) => {
      const id = `swarm-${slot}`;
      // Mirror the server-worker order: snap-set angvel first, then layer
      // any linear/torque impulse on top. Behaviours wanting player-
      // equivalent turn rate set `setAngvel` and leave `torque = 0`.
      if (setAngvel !== undefined) this.predWorld?.setShipAngvel(id, setAngvel);
      this.predWorld?.applyImpulse(id, fx, fy, torque);
    },
  };
  private readonly _aiController = new AiController(this._aiSink);
  /** Numeric entityIds currently registered with `_aiController`. */
  private readonly _aiRegisteredIds = new Set<number>();
  /** Reusable AiPlayerView buffer to avoid per-tick allocation in the AI tick. */
  private readonly _aiPlayersBuf: AiPlayerView[] = [];
  /**
   * Phase C follow-up (2026-05-09 mobile re-test): set of drone entityIds the
   * MOST RECENT snapshot's `drones[]` slice anchored. For these drones the
   * snapshot path (Reconciler.reconcile + replay loop running client AI) is
   * the source of truth for predWorld pose; the binary swarm packet's
   * `setShipState` call must be skipped or it will pull predWorld backward
   * by `currentTick − ackedTick` ticks of motion every packet, undoing the
   * forward-extrapolation Phase C just produced. (The mobile cap
   * 2026-05-09 18:25 showed the two paths fighting: per-drone snap distance
   * tripled vs pre-C because every packet snap pulled drones back to where
   * server's pose WAS, then replay re-extrapolated forward, then next
   * packet pulled back again.) Drones NOT in this set fall through to the
   * legacy setShipState path — out-of-interest drones receive their pose
   * only via the decimated binary channel, so the binary packet still
   * needs to anchor them.
   *
   * Rebuilt from scratch on each snapshot so drones leaving interest drop
   * out automatically. Cleared on sector handoff alongside the other
   * prediction-state surfaces.
   */
  private readonly _droneSnapshotAnchored = new Set<number>();

  /**
   * Phase 3 follow-up (2026-05-09): per-drone render lerp offsets.
   *
   * Every binary swarm packet calls `setShipState` on the matching drone
   * body in predWorld — that "rewinds" the drone by ~leadTicks worth of
   * AI-integrated motion to the server's just-shipped pose. AI then
   * re-extrapolates over the next few RAF frames to bring it back to
   * "now." If we render predWorld directly, that rewind shows as a
   * 50 ms-cadence backward snap → forward catch-up oscillation — the
   * "double vision" the user reported after the render path was
   * re-pointed at predWorld.
   *
   * Fix: same pattern player ships use (`_remoteShipOffsets`). When the
   * snap happens, capture the pre-snap render position; the offset is
   * `pre - post`. Each frame the offset decays via critically-damped
   * spring; the rendered drone position is `predWorld + offset`. Visible
   * motion stays smooth across the snap.
   */
  private readonly _droneRenderOffsets = new Map<
    number,
    { sx: SpringState; sy: SpringState; sa: SpringState; halfLifeMs: number }
  >();

  /** IDs of remote ships currently spawned in the prediction world. */
  private predRemoteShipIds = new Set<string>();
  /** Phase 4 — wrecks currently spawned in predWorld for client-side
   *  collision. Stored with the `wreck-` prefix so they can't collide
   *  with the playerId namespace. Despawned when removed from the
   *  schema's `state.wrecks` map. */
  private predWreckIds = new Set<string>();
  /** Phase 6b — lingering hulls currently spawned in predWorld so the
   *  local player ship can collide with parked hulls (and so the local
   *  projectile sweep registers hits on them — server-side projectile
   *  sweep handles authoritative damage, but the predicted ghost
   *  projectiles need a body to test against). Stored with the
   *  `linger-` prefix so they can't collide with the playerId or
   *  wreck namespaces. Despawned when removed from mirror.lingeringShips. */
  private predLingeringIds = new Set<string>();

  /**
   * Spawn / update the predWorld body for a lingering hull, given that
   * both `kind` and pose have been populated in the mirror. Called from
   * two sites:
   *
   *  1. `handleSnapshot` after writing pose from the snapshot.
   *  2. `syncMirror` after writing `kind` from the Colyseus schema diff.
   *
   * Either site can race ahead of the other on a flaky network. The
   * helper handles both orderings by being a no-op when the mirror
   * entry isn't fully populated — and the OTHER site re-fires it
   * once its piece arrives. Closes the "colliding through my hulk"
   * regression where the predWorld body was deferred a full snapshot
   * tick after the schema diff (2026-05-13 smoke-test feedback).
   */
  private tryEnsureLingerPredBody(shipInstanceId: string): void {
    if (!this.predWorld) return;
    const entry = this.mirror.lingeringShips?.get(shipInstanceId);
    if (!entry || !entry.kind) return;
    const bodyId = `linger-${shipInstanceId}`;
    const isFresh = !this.predWorld.hasShip(bodyId);
    if (isFresh) {
      this.predWorld.spawnShip(bodyId, entry.x, entry.y, entry.kind);
      this.predLingeringIds.add(bodyId);
    }
    // Phase 6b reconciliation (2026-05-13): capture the body's
    // current predicted pose BEFORE we teleport it to the
    // server-authoritative snapshot pose, so we can store the diff
    // as a spring-decayed sprite offset and avoid a visible
    // teleport. Same pattern as the remote-ship reconciler at line
    // ~1676. On the body's first spawn there's no prior pose to
    // diff against — skip the offset capture.
    if (!isFresh) {
      const before = this.predWorld.getShipState(bodyId);
      this.predWorld.setShipState(bodyId, {
        x: entry.x, y: entry.y, angle: entry.angle,
        vx: entry.vx, vy: entry.vy,
        angvel: 0,
      });
      if (before) {
        const ox = before.x - entry.x;
        const oy = before.y - entry.y;
        const dist = Math.hypot(ox, oy);
        if (dist > 1) {
          const halfLifeMs = remoteOffsetHalfLifeForDrift(dist);
          const existing = this._lingeringShipOffsets.get(shipInstanceId);
          if (existing) {
            existing.sx.x = ox; existing.sx.v = 0;
            existing.sy.x = oy; existing.sy.v = 0;
            existing.halfLifeMs = halfLifeMs;
          } else {
            this._lingeringShipOffsets.set(shipInstanceId, {
              sx: { x: ox, v: 0 },
              sy: { x: oy, v: 0 },
              halfLifeMs,
            });
          }
        }
      }
    } else {
      this.predWorld.setShipState(bodyId, {
        x: entry.x, y: entry.y, angle: entry.angle,
        vx: entry.vx, vy: entry.vy,
        angvel: 0,
      });
    }
  }
  /** Per-remote-ship render lerp offsets — applied in updateMirror() to smooth server corrections.
   *  Stage 1: each entry holds two critically-damped spring states (one per axis)
   *  decaying toward zero. Half-life per drift magnitude matches Reconciler. */
  private readonly _remoteShipOffsets = new Map<
    string,
    { sx: SpringState; sy: SpringState; halfLifeMs: number }
  >();
  /** Phase 6b (2026-05-13) — per-lingering-hull render lerp offsets.
   *  Same shape as `_remoteShipOffsets`. Set in `tryEnsureLingerPredBody`
   *  when the snapshot's setShipState would otherwise teleport the body;
   *  decayed in `updateMirror`. Keyed by `shipInstanceId` (matches the
   *  mirror.lingeringShips key). */
  private readonly _lingeringShipOffsets = new Map<
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
    swarmSnapP50: 0,
    swarmSnapP99: 0,
    swarmAngleP99: 0,
    swarmAngvelP99: 0,
    swarmSnapCount: 0,
  };

  /** Phase B (2026-05-09 AI lockstep) — per-drone snap-event ring buffers
   *  for surfacing p50/p99 metrics on `stats.swarmSnap*`. Sliding window of
   *  the most recent 240 snap events across all drones (~12 s at 20 Hz × 10
   *  drones); older entries drop off the front. Three parallel arrays keep
   *  the hot path branch-free. */
  private readonly _swarmSnapDistBuf: number[] = [];
  private readonly _swarmSnapAngleBuf: number[] = [];
  private readonly _swarmSnapAngvelBuf: number[] = [];
  /** Phase B — last server tick we emitted a `swarm_snap_diagnostics` event
   *  for each drone. Caps log volume to one event per drone per 4 ticks
   *  (~67 ms at 60 Hz) so the 500-entry log ring isn't dominated by snap
   *  events when many drones are in interest. */
  private readonly _swarmSnapLastLogTick = new Map<number, number>();

  private room: Room | null = null;

  /** Phase 8 sub-phase B — exposed for the in-game galaxy maps (Pixi
   *  GalaxyMapLayer + GalaxyOverviewScreen warp-mode) to call
   *  `room.send('engage_transit', ...)`. Returns null until `connect()`. */
  getRoom(): Room | null {
    return this.room;
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
   * `performance.now()` when the welcome message was processed. Used as the
   * initial anchor for `inputTick`; on every subsequent snapshot the anchor is
   * advanced to the snapshot's `serverTick` (`updateClockAnchor()`). See
   * `tickPhysics()`.
   */
  private welcomePerfNow = 0;
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
  private disposed = false;

  // Wall-clock-anchored input loop (driven by rAF in App.tsx).
  private keyboard: { read: () => { thrust: boolean; turnLeft: boolean; turnRight: boolean; fireHeld: boolean; boost: boolean; reverse: boolean } } | null = null;
  private touchInput: TouchInput | null = null;
  private lastFiredAtTick = -999;

  /** Multi-mount/turret refactor (Phase 4b.2): sticky target id chosen by
   *  the local ship's turret AI last tick. Reset to null on death, sector
   *  handoff, and respawn so a new spawn starts with no pin. Per-instance
   *  rather than per-mount because all mounts in a slot share one target
   *  (user-clarified design rule). */
  private _localSlotTarget: string | null = null;
  /** Scratch buffer reused across ticks — fed to `pickTarget` as the
   *  candidate list. Cleared and refilled each call; never escapes the
   *  ColyseusClient so concurrent reuse is fine. */
  private _droneTargetsScratch: MountTargetView[] = [];
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
  /** Elapsed ms of the last frame — used by updateMirror() for ghost advancement. */
  private lastFrameMs = 1000 / 60;

  // Prediction
  private predWorld: PhysicsWorld | null = null;
  private reconciler: Reconciler | null = null;

  // Snapshot timing
  private lastSnapshotAt = 0;
  // Rolling buffers for jitter and correction-rate metrics (last 10 snapshots).
  private readonly _recentIntervals: number[] = [];
  /** Phase 6.5 — EWMA of `snapshotIntervalMs`, used to size the adaptive
   *  swarm display-delay buffer. 0 = uninitialised; first snapshot seeds. */
  private _intervalEwma = 0;
  private readonly _recentCorrFlags: number[] = [];

  // Remote ship interpolation: per-player timestamped history
  private remoteHistory = new Map<string, RemoteEntry[]>();

  // Combat
  private readonly ghostManager = new GhostManager();
  /** Damage flash: set of player IDs currently flashing red (cleared after one frame). */
  private readonly _damageFlashFrames = new Map<string, number>();
  /** Set when the local ship is destroyed — blocks firing until reconnect. */
  private localDead = false;

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
   * Also resets `reconciler.lastRtt` so the first post-transit welford
   * push (which reads the *previous* reconcile's lastRtt — see ordering
   * in `handleSnapshot`) doesn't seed welford with the pre-transit value.
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
    this._intervalEwma = 0;
    if (this.reconciler) this.reconciler.lastRtt = 0;
    // Phase 3 — drop AI registrations on sector handoff. The destination
    // sector has a different swarm; old behaviours would hold stale
    // `lastFireTick` and target stale player IDs that may not exist there.
    for (const id of this._aiRegisteredIds) {
      this._aiController.unregister(`${id}`);
    }
    this._aiRegisteredIds.clear();
    this._droneRenderOffsets.clear();
    this._droneSnapshotAnchored.clear();
    // Multi-mount/turret refactor (Phase 4b.2): drop the local ship's
    // sticky turret target on sector handoff — the destination sector has
    // a fresh swarm with different ids, so holding the previous pin would
    // mean "no target in view" until the controller times out and re-picks.
    this._localSlotTarget = null;
    // Phase B — drop the per-drone snap-event rings + log throttle. The new
    // sector has a fresh swarm; carrying old percentiles across the warp
    // gap pollutes the visible p50/p99 in the dev overlay.
    this._swarmSnapDistBuf.length = 0;
    this._swarmSnapAngleBuf.length = 0;
    this._swarmSnapAngvelBuf.length = 0;
    this._swarmSnapLastLogTick.clear();
    // Join-render diagnostic latch — re-arm so the destination room's
    // `tryInitPredWorld` success fires a fresh `local_pose_resolved`.
    this._localPoseResolvedLogged = false;
    this.stats.swarmSnapP50 = 0;
    this.stats.swarmSnapP99 = 0;
    this.stats.swarmAngleP99 = 0;
    this.stats.swarmAngvelP99 = 0;
    this.stats.swarmSnapCount = 0;
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

    // Init client-side prediction world before joining so it is ready as soon as
    // we receive our playerId.
    this.predWorld = await PhysicsWorld.create();

    callbacks.onConnectionStatus('connecting');
    console.log('[ColyseusClient] connecting to', wsUrl, 'playerId:', storedPlayerId);
    const client = new Client(wsUrl);

    let resolvedRoom: Room;
    try {
      console.log('[ColyseusClient] calling joinOrCreate…');
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
      console.error('[ColyseusClient] joinOrCreate failed:', err);
      callbacks.onConnectionStatus('error');
      throw err;
    }

    if (this.disposed) {
      resolvedRoom.leave();
      return;
    }

    this.room = resolvedRoom;
    console.log('[ColyseusClient] joinOrCreate resolved, roomId:', this.room.roomId);

    // Phase 5e: DEV-only inbound-bandwidth tally exposed on `window` so the
    // swarm-bandwidth E2E can sample bytes/sec without DPI-level WS plumbing.
    // Tracks `swarmBytes` (binary channel — the dominant cost) and
    // `snapshotBytes` (JSON-shape approximation). Production builds tree-
    // shake the window assignment via the import.meta.env.DEV branch.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __EQX_BW_STATS?: BwStats };
      if (!w.__EQX_BW_STATS) {
        const stats: BwStats = {
          startedAt: performance.now(),
          swarmBytes: 0,
          swarmPackets: 0,
          snapshotBytes: 0,
          snapshotCount: 0,
          reset(): void {
            this.startedAt = performance.now();
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
      console.log(
        '[ColyseusClient] welcome received, playerId:', msg.playerId,
        idChanged ? '(server reassigned — collision guard)' : '',
        'serverTick:', msg.serverTick,
      );
      this.serverTickAtWelcome = msg.serverTick;
      this.welcomePerfNow = performance.now();
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
      // If state already arrived, bootstrap the prediction world now.
      this.tryInitPredWorld(msg.playerId);
    });

    room.onMessage('snapshot', (snap: SnapshotMessage) => {
      const bw = bwStats();
      if (bw) {
        // Approximation — Colyseus uses msgpack on the wire, which is
        // typically ~70% of the JSON length. Using JSON length is a
        // conservative upper bound that's easy to compute without DPI.
        bw.snapshotBytes += JSON.stringify(snap).length;
        bw.snapshotCount += 1;
      }
      this.handleSnapshot(snap);
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
      if (raw instanceof ArrayBuffer) {
        if (bw) { bw.swarmBytes += raw.byteLength; bw.swarmPackets += 1; }
        decodeSwarmPacket(raw, this.mirror);
      } else if (ArrayBuffer.isView(raw)) {
        if (bw) { bw.swarmBytes += raw.byteLength; bw.swarmPackets += 1; }
        decodeSwarmPacket(raw, this.mirror);
      }
      this.syncSwarmIntoPredWorld();
      // Phase 6 HUD readout. mirror.swarm is the live decoded set; .size is
      // O(1). At decimation-only ticks the count stays steady (no entities
      // come and go), so updating this on every packet is cheap.
      useUIStore.getState().setSwarmCount(this.mirror.swarm?.size ?? 0);
    });

    room.onMessage('damage', (evt: DamageEvent) => {
      this.handleDamage(evt);
    });

    room.onMessage('destroy', (evt: DestroyEvent) => {
      this.handleDestroy(evt);
    });

    room.onMessage('hit_ack', (ack: HitAckMessage) => {
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
      perShooter.set(mountKey, {
        range,
        hit: evt.hit,
        targetId: evt.targetId,
        expiresAt: performance.now() + ttlMs,
        fromX: evt.fromX,
        fromY: evt.fromY,
        toX: evt.toX,
        toY: evt.toY,
      });
    });

    room.onMessage('respawn_ack', (msg: RespawnAckMessage) => {
      this.handleRespawnAck(msg);
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
        performance.now(),
      );
      if (outcome.applied.length > 0) {
        this.stats.collisionEventsApplied++;
      }
    });

    // Phase 8 sub-phase B — transit lifecycle messages.
    room.onMessage('transit_state', (msg: TransitStateMessage) => {
      const ui = useUIStore.getState();
      ui.setTransitState(msg.state);
      if (msg.targetSectorKey !== undefined) ui.setTransitTargetSectorKey(msg.targetSectorKey);
      if (msg.state === 'SPOOLING') {
        ui.setTransitProgress(0);
        const start = performance.now();
        const dur = msg.spoolMs ?? 3000;
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
          const elapsed = performance.now() - start;
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
      try {
        await room.leave(true /* consented */);
      } catch (err) {
        console.warn('[ColyseusClient] source room.leave during transit failed', err);
      }

      // Wipe Stage 4 prediction-loop state so the destination sector's first
      // snapshot is treated like a fresh-connect seed. Without this, the
      // 5+ s transit gap pollutes the surviving welford RTT stream and the
      // client over-predicts ~600 ms ahead of authoritative state for
      // tens of seconds post-arrival. See `resetPredictionState()` for the
      // full pathology and the diagnostic captures that motivated the fix.
      this.resetPredictionState();

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
        const newRoom = await client.consumeSeatReservation<unknown>(msg.reservation as never);
        this.room = newRoom;
        bindRoomHandlers(newRoom);
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
        console.error('[ColyseusClient] consumeSeatReservation failed', err);
        const ui = useUIStore.getState();
        ui.setTransitState('DOCKED');
        ui.setTransitProgress(0);
        ui.setTransitTargetSectorKey(null);
        ui.setSectorAlert('transit failed');
        setTimeout(() => useUIStore.getState().setSectorAlert(null), 2000);
      }
    });

    room.onStateChange((state: unknown) => {
      this.syncMirror(state);
    });

    room.onLeave((code) => {
      console.warn('[ColyseusClient] left room, code:', code);
      logEvent('disconnected', { code });
      // During transit `consumeSeatReservation` we'll see an onLeave on the
      // source room as the WS is replaced. Don't flip status to disconnected
      // when a transit is mid-flight — the destination is already being
      // bound. The post-consume rebind sets connected status implicitly via
      // the new room's flow.
      const cur = useUIStore.getState();
      if (cur.transitState === 'IN_TRANSIT' || cur.transitState === 'SPOOLING') return;
      callbacks.onConnectionStatus('disconnected');
      this.keyboard = null;
      this.touchInput = null;
    });

    room.onError((code, message) => {
      console.error('[ColyseusClient] room error', code, message);
      logEvent('room_error', { code, message });
      callbacks.onConnectionStatus('error');
    });
    };

    bindRoomHandlers(this.room);

    callbacks.onConnectionStatus('connected');
    console.log('[ColyseusClient] connected — input loop driven by rAF');
    this.keyboard = keyboard;
    this.touchInput = touchInput ?? null;
  }

  // ── Combat event handlers ────────────────────────────────────────────────

  private handleDamage(evt: DamageEvent): void {
    const localId = this.mirror.localPlayerId;
    if (evt.targetId === localId) {
      const pct = Math.round((evt.newHealth / SHIP_MAX_HEALTH) * 100);
      useUIStore.getState().setHullPct(pct);
    }
    // Flash the damaged ship for 6 frames.
    this._damageFlashFrames.set(evt.targetId, 6);

    // Floating damage number at hit location.
    if (this.mirror.pendingDamageNumbers) {
      const targetShip = this.mirror.ships.get(evt.targetId);
      const x = evt.hitX ?? targetShip?.x ?? 0;
      const y = evt.hitY ?? targetShip?.y ?? 0;
      this.mirror.pendingDamageNumbers.push({ x, y, damage: evt.damage });
    }

    // Health bar on hit — only show for targets the local player is shooting.
    if (evt.shooterId === localId && this.mirror.pendingHealthBarHits) {
      const maxHealth = SHIP_MAX_HEALTH;
      const healthPct = Math.max(0, evt.newHealth / maxHealth);
      this.mirror.pendingHealthBarHits.push({ entityId: evt.targetId, healthPct });
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
    this.reconciler = new Reconciler(this.predWorld, playerId);

    // Sync input tick to server tick so first fire passes temporal plausibility,
    // and re-anchor the clock so tickPhysics()'s `targetTick` derivation stays
    // consistent with the new tick base.
    this.inputTick = msg.serverTick;
    this.serverTickAtWelcome = msg.serverTick;
    this.welcomePerfNow = performance.now();
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

    console.log('[ColyseusClient] respawned at', msg.x.toFixed(1), msg.y.toFixed(1));
  }

  /** Send a respawn request to the server. Only valid while the local ship is dead. */
  respawnShip(): void {
    if (!this.room || !this.localDead) return;
    this.room.send('respawn', { type: 'respawn' });
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
    this.reconciler = new Reconciler(this.predWorld, playerId);
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
        ? Math.round(performance.now() - this.welcomePerfNow)
        : -1;
      logEvent('local_pose_resolved', {
        playerId,
        x: existing.x,
        y: existing.y,
        kind: existing.kind ?? null,
        msSinceWelcome,
      });
    }
    console.log('[ColyseusClient] prediction world initialised at', existing.x.toFixed(1), existing.y.toFixed(1));
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

  private handleSnapshot(snap: SnapshotMessage): void {
    const localId = this.mirror.localPlayerId;
    const now = performance.now();

    // Phase 6a / 6b — translate the shipInstanceId-keyed wire format
    // to a playerId-keyed local view. C-ii strategy: predWorld + mirror
    // + reconciler all use playerId internally for active hulls.
    // Phase 6b: inactive hulls (lingering) DO show up — they get
    // routed to `mirror.lingeringShips` (a separate shipInstanceId-
    // keyed map) so they don't collide with the active hull on the
    // same playerId. Pose flows from the snapshot directly; identity
    // (kind, displayName) flows from the Colyseus schema diff via
    // `syncMirror`.
    const statesByPlayerId: SnapshotMessage['states'] = {};
    if (!this.mirror.lingeringShips) this.mirror.lingeringShips = new Map();
    const lingeringSeen = new Set<string>();
    for (const [shipInstanceId, entry] of Object.entries(snap.states)) {
      if (entry.isActive === false) {
        // Route to the lingering map. We update pose every snapshot;
        // identity fields come from the schema diff and are preserved.
        const prev = this.mirror.lingeringShips.get(shipInstanceId);
        this.mirror.lingeringShips.set(shipInstanceId, {
          x: entry.x, y: entry.y, vx: entry.vx, vy: entry.vy,
          angle: entry.angle,
          ownerPlayerId: entry.playerId,
          ...(prev?.kind ? { kind: prev.kind } : {}),
          ...(prev?.displayName !== undefined ? { displayName: prev.displayName } : {}),
        });
        lingeringSeen.add(shipInstanceId);
        // Phase 6b — spawn / refresh the predWorld body so the local
        // player can collide with the parked hull (mirrors the wreck
        // pattern in syncWreckPoses). The helper handles the race
        // between this site (pose) and syncMirror (kind) — see its
        // doc comment.
        this.tryEnsureLingerPredBody(shipInstanceId);
        continue;
      }
      statesByPlayerId[entry.playerId] = entry;
    }
    // Remove lingering hulls that didn't appear in this snapshot (evicted
    // by the 15-min timer, or destroyed) — plus despawn their predWorld
    // bodies so the local player stops colliding with ghosts.
    for (const id of [...this.mirror.lingeringShips.keys()]) {
      if (!lingeringSeen.has(id)) {
        this.mirror.lingeringShips.delete(id);
        const bodyId = `linger-${id}`;
        if (this.predLingeringIds.has(bodyId)) {
          this.predWorld?.despawnShip(bodyId);
          this.predLingeringIds.delete(bodyId);
        }
      }
    }
    snap = { ...snap, states: statesByPlayerId };

    // Wire-discipline P3: projectiles arrive on the snapshot, interest-filtered
    // per recipient. Sync into the mirror first so the rest of this handler can
    // assume the projectile map matches the snapshot's tick.
    this.syncProjectiles(snap.projectiles);

    // Phase 4 — sync wreck poses into the mirror. Identity (kind, health,
    // maxHealth) flows via the Colyseus schema diff on `state.wrecks`
    // (see syncMirror); this just refreshes per-frame pose.
    this.syncWreckPoses(snap.wrecks);

    // Apply the server-authoritative boost set into the render mirror so the
    // PixiRenderer can draw an exhaust trail for whichever ships are currently
    // boosting. Reset first so leavers / shift-released ships drop out.
    if (this.mirror.boostingShips) {
      this.mirror.boostingShips.clear();
      if (snap.boostingIds) {
        for (const id of snap.boostingIds) this.mirror.boostingShips.add(id);
      }
    }
    // Same pattern for the baseline thrust set — every snapshot is the
    // authoritative truth; locals are layered on top via per-tick prediction.
    if (this.mirror.thrustingShips) {
      this.mirror.thrustingShips.clear();
      if (snap.thrustingIds) {
        for (const id of snap.thrustingIds) this.mirror.thrustingShips.add(id);
      }
    }

    // Phase 6 — surface the server's TiDi rate to the HUD via Zustand. Schema
    // diff already updates `room.state.clockRate`; reading it on every
    // snapshot is a cheap polling heartbeat that avoids a separate listener.
    if (this.room) {
      const stateAny = this.room.state as unknown as { clockRate?: number };
      const rate = typeof stateAny.clockRate === 'number' ? stateAny.clockRate : 1.0;
      const ui = useUIStore.getState();
      ui.setClockRate(rate);
      this.audio?.setClockRate(rate);
      // Diegetic Temporal Anomaly banner. The alert slot is shared with
      // combat ('SHIP DESTROYED', 'shot_rejected'); read the live value so
      // we never stomp those, and only clear our own string. Hysteresis on
      // the *rate* edges (0.99 set / 1.00 clear) avoids flicker as the EWMA
      // boundary is crossed during recovery.
      const current = ui.sectorAlert;
      if (rate < 0.99 && (current === null || current === 'Temporal Anomaly')) {
        if (current !== 'Temporal Anomaly') ui.setSectorAlert('Temporal Anomaly');
      } else if (rate >= 1.0 && current === 'Temporal Anomaly') {
        ui.setSectorAlert(null);
      }
    }

    // Update snapshot timing stats regardless of prediction state.
    const intervalMs = this.lastSnapshotAt > 0 ? now - this.lastSnapshotAt : 0;
    this.lastSnapshotAt = now;
    this.stats.snapshotCount++;
    this.stats.snapshotIntervalMs = intervalMs;
    this.stats.lastServerTick = snap.serverTick;
    // Stage 2 — feed the collision-event stale-guard with the authoritative
    // snapshot tick. Late collision events (worker → main → wire latency)
    // arriving with tick < this value are dropped, since the snapshot has
    // already corrected predWorld with a state that would un-correct.
    this._collisionGuard.lastSnapshotServerTick = snap.serverTick;

    // Phase 6 — derive effective server wall-clock tick rate. Snapshot
    // broadcasts every 3 ticks, so tickHz = 3000 / intervalMs. EWMA-smoothed
    // so single-snapshot jitter doesn't make the chip flicker.
    if (intervalMs > 0) {
      const instantHz = 3000 / intervalMs;
      const prev = useUIStore.getState().serverTickHz;
      const smoothed = prev * 0.8 + instantHz * 0.2;
      useUIStore.getState().setServerTickHz(smoothed);

      // Phase 6.5 — adapt the swarm display-delay buffer's lookback window
      // to the observed inter-arrival cadence. EWMA-smoothed so single-tick
      // jitter doesn't make sprites stutter as the delay snaps around.
      // Steady-state at 60 Hz server: intervalMs ≈ 50 → delay = 75 → clamped
      // to 100 (the floor). Burn / overload at 19 Hz: intervalMs ≈ 170 →
      // delay = 255 — buffer always has half an arrival of headroom.
      this._intervalEwma = this._intervalEwma === 0
        ? intervalMs
        : this._intervalEwma * 0.85 + intervalMs * 0.15;
      // Stage 4 — observe each snapshot's serverTick for drop detection;
      // bias the swarm display-delay upward when the wire is dropping
      // packets so the interp buffer doesn't run out of bracketing arrivals.
      observeSnapshotTick(this._dropDetector, snap.serverTick);
      const dropBias = computeInterpBiasMs(this._dropDetector.dropCount);
      setSwarmDisplayDelayMs(this._intervalEwma * ADAPTIVE_DELAY_FACTOR + dropBias);
    }

    // Rolling jitter: max − min of the last 10 snapshot intervals.
    if (intervalMs > 0) {
      this._recentIntervals.push(intervalMs);
      if (this._recentIntervals.length > 10) this._recentIntervals.shift();
    }
    this.stats.snapshotJitterMs = this._recentIntervals.length >= 2
      ? Math.max(...this._recentIntervals) - Math.min(...this._recentIntervals)
      : 0;

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
    // Stage 4 — jitter-aware lookahead. Welford-track per-snapshot RTT
    // (mean + σ) and size the prediction window to `mean + 2σ` rather
    // than the pre-Stage-4 mean-only EWMA. Multi-tick target jumps ramp
    // via the spring controller; small changes snap directly.
    //
    // 2026-05-08 fix (Stage 4 hotfix #1): Reconciler.lastRtt is computed
    // as `now - ackedRec.sentAt` — a "time since input was sent" measure
    // contaminated by snapshot-delay. A 572 ms inbound network gap (per
    // `docs/LESSONS.md` Pattern A) inflates lastRtt to 572 ms+ even
    // though the underlying TCP RTT is healthy. Without a clamp, that
    // outlier sample pushes Welford σ past 200 ms, the `mean + 2σ`
    // formula saturates at the 30-tick cap, the client speculates 500 ms
    // ahead, and combat predictions diverge into 100+ u corrections.
    // The clamp converts outliers into "I have no fresh RTT info"
    // (the cap value is folded into the running mean cleanly) instead
    // of letting σ explode.
    //
    // 2026-05-08 fix (Stage 4 hotfix #3): the σ-clamp protects against
    // single-sample explosions but the running mean still drifts upward
    // because clamped samples (250 ms each) accumulate in Welford's
    // sum. Repeated Pattern A spikes inflate mean to 177 ms even when
    // live RTT is 83 ms — leadTicks saturates at ~22 → collision drift
    // = velocity-diff × leadTicks × dt = 50+ u. Skip the Welford push
    // entirely when this snapshot's `intervalMs` is outside the
    // steady-state cadence band [35, 75] ms — those snapshots are part
    // of a Pattern A gap (intervalMs >> 50) or a burst-recovery cluster
    // (intervalMs << 50) and their `lastRtt` is contaminated. Welford
    // then tracks only clean steady-state samples, so the mean stays
    // close to live RTT and leadTicks stays sized for combat.
    const isGapRelatedRtt =
      intervalMs > 0 &&
      (intervalMs < STEADY_STATE_INTERVAL_MIN_MS || intervalMs > STEADY_STATE_INTERVAL_MAX_MS);
    if (this.reconciler && this.reconciler.lastRtt > 0 && !isGapRelatedRtt) {
      // Stage 4 hotfix #5 (2026-05-09) — strip the gate-induced
      // server-side hold time from the RTT sample before pushing into
      // welford. Without the input-queue gate (commit c7b8d04),
      // `Reconciler.lastRtt` measured `now - sentAt` ≈ 2 × wire-D + a
      // small server-process delay; pushing it into welford gave a
      // clean network-RTT estimate. With the gate, the server holds
      // each input claim X for roughly `leadTicks` physics ticks until
      // its sim tick reaches X, then applies and acks. That hold time
      // is `leadTicks × FIXED_MS` and is included in `lastRtt` even
      // though the wire is doing nothing during it. Pushing the raw
      // value would create a positive feedback loop: bigger leadTicks
      // → longer hold → bigger lastRtt → bigger welford mean → bigger
      // leadTicks → … → saturate at the 30-tick `CEILING_TICKS` cap.
      // Mobile cap 2026-05-09T09-31-30-823Z-n3n9jx caught this with
      // `rttMs` field saturating at 200–870 ms when actual Wi-Fi RTT
      // is ~30 ms.
      //
      // Subtracting `this.leadTicks × FIXED_MS` recovers the network-
      // only round-trip estimate. The clamp `max(0, …)` handles the
      // case where the wire was unusually fast and the subtraction
      // would yield a negative (rare; would mean lastRtt was less
      // than the gate-hold, which can happen on first-snapshot or
      // when the gate just opened). Clamping the upper bound at
      // RTT_SAMPLE_CLAMP_MS still protects against gap-related
      // outliers that hotfix #3's interval-band filter missed.
      const FIXED_MS = 1000 / 60;
      const networkRtt = Math.max(0, this.reconciler.lastRtt - this.leadTicks * FIXED_MS);
      const rttSample = Math.min(networkRtt, RTT_SAMPLE_CLAMP_MS);
      welfordPush(this._rttWelford, rttSample);
      const mean = welfordMean(this._rttWelford);
      const stdDev = welfordStdDev(this._rttWelford);
      const desiredLead = computeDesiredLead(mean, stdDev);
      this.leadTicks = updateLookahead(this._lookaheadCtrl, desiredLead, this.lastFrameMs);
      this.stats.rttMeanMs = mean;
      this.stats.rttStdDevMs = stdDev;
    }
    this.stats.droppedSnapshotsRecent = this._dropDetector.dropCount;

    if (!localId || !this.reconciler) {
      if (this.predWorld) {
        // Sync remote ships — keep them at their latest server position until
        // the reconciler bootstraps so they don't drift before the first reconcile.
        // Phase 5c: swarm entities (asteroids, drones) are not in predWorld;
        // they live render-only in mirror.swarm and lerp between binary
        // swarm packets server-authoritatively.
        for (const [remoteId, state] of Object.entries(snap.states)) {
          if (remoteId === localId) continue;
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

      // Reset remote ships to serverTick state BEFORE reconcile.
      const preResetRemotePos = new Map<string, { x: number; y: number }>();
      for (const [remoteId, state] of Object.entries(snap.states)) {
        if (remoteId === localId) continue;
        if (!this.predWorld?.hasShip(remoteId)) continue;
        const current = this.predWorld.getShipState(remoteId);
        if (current) preResetRemotePos.set(remoteId, { x: current.x, y: current.y });
        this.predWorld.setShipState(remoteId, state);
        // Stage 3 — capture each remote's last-applied input from the
        // snapshot for forward-prediction during the upcoming replay
        // and the next tickPhysics window.
        if (state.lastInput) {
          this._remoteLastInputs.set(remoteId, { ...state.lastInput });
        } else {
          this._remoteLastInputs.delete(remoteId);
        }
        // Reset the lookahead-cap counter for this remote — the upcoming
        // replay starts a fresh forward-prediction window from serverTick.
        this._remoteForwardTicks.set(remoteId, 0);
        // Phase 4b.3 — push the server's authoritative mount angles into
        // the mirror so the renderer paints the remote ship's turrets at
        // the same rotation the server is computing. Local player is
        // skipped here — `tickLocalMountAim` runs the prediction each
        // tick and the per-frame `updateMirror` rebuild already
        // preserves the predicted angles.
        const mirrorShip = this.mirror.ships.get(remoteId);
        if (mirrorShip) {
          if (state.mountAngles && state.mountAngles.length > 0) {
            mirrorShip.mountAngles = state.mountAngles.slice();
          } else if (mirrorShip.mountAngles) {
            mirrorShip.mountAngles = undefined;
          }
        }
      }
      // Drop entries for remotes that are no longer in the snapshot.
      for (const tracked of [...this._remoteLastInputs.keys()]) {
        if (!(tracked in snap.states)) {
          this._remoteLastInputs.delete(tracked);
          this._remoteForwardTicks.delete(tracked);
        }
      }

      this.lastSnapshotPos = { x: serverState.x, y: serverState.y };

      // Phase C (2026-05-09 AI lockstep) — build the drone reconcile-anchor
      // seed map from `snap.drones`. Each entry's `id` is the dense u16
      // entityId matching the binary swarm channel; predWorld keys swarm
      // bodies as `swarm-${entityId}`. Seeding before replay re-anchors
      // every in-interest drone at the snapshot's `serverTick`, so the
      // reconciler's per-replay-tick AI tick starts from a server-
      // authoritative pose at `ackedTick` rather than from "wherever the
      // most recent binary swarm packet happened to drop the body". The
      // reconciler installs each pose via `world.setShipState` before
      // entering the replay loop (see Reconciler.reconcile).
      // Rebuild the snapshot-anchor set from this snapshot's drone slice.
      // The set tells `syncSwarmIntoPredWorld` to skip its setShipState
      // call for these drones (the snapshot + replay path is now the
      // source of truth for their predWorld pose; binary-packet snapping
      // would just yank them backward by leadTicks worth of motion).
      this._droneSnapshotAnchored.clear();
      let droneSeed: Map<string, ShipPhysicsState> | undefined;
      if (snap.drones && snap.drones.length > 0 && this.predWorld) {
        droneSeed = new Map();
        for (const d of snap.drones) {
          this._droneSnapshotAnchored.add(d.id);
          const key = `swarm-${d.id}`;
          // Skip drones we don't have a body for yet (will be spawned by
          // the next binary packet via syncSwarmIntoPredWorld). Setting
          // state on a non-existent body is a silent no-op in World, but
          // building the map only for known bodies makes the test path
          // observable.
          if (this.predWorld.hasShip(key)) {
            droneSeed.set(key, {
              x: d.x, y: d.y, vx: d.vx, vy: d.vy, angle: d.angle, angvel: d.angvel,
            });
          }
          // Phase 4c — push the authoritative drone mount angles into
          // the swarm mirror so MountVisualManager rotates the drone's
          // turret sprites to match what the server is computing (and
          // so handleAiFire's lag-comp matches what the player saw).
          // Out-of-interest drones never appear in `snap.drones`, so
          // their mirror entry's mountAngles stays undefined and the
          // renderer falls back to baseAngle (static barrels).
          const sw = this.mirror.swarm?.get(d.id);
          if (sw) {
            if (d.mountAngles && d.mountAngles.length > 0) {
              sw.mountAngles = d.mountAngles.slice();
            } else if (sw.mountAngles) {
              sw.mountAngles = undefined;
            }
          }
        }
      }

      this.reconciler.reconcile(
        serverState,
        snap.serverTick,
        this.inputTick,
        ackedTick,
        () => {
          // Phase 3 (2026-05-09): drones get AI impulses on every replayed
          // tick, identical to the input replay path. Without this, the
          // reconciler's `predWorld.tick(1/60)` calls would inertia-drift
          // drones for `leadTicks` ticks each snapshot — exactly the drift
          // we're trying to eliminate.
          this.applyRemoteInputs();
          this.tickClientAi();
        },
        droneSeed ? { drones: droneSeed } : undefined,
      );

      // Compute remote ship lerp offsets.
      if (this.predWorld) {
        for (const [remoteId, preReset] of preResetRemotePos) {
          const postReconcile = this.predWorld.getShipState(remoteId);
          if (!postReconcile) continue;
          const ox = preReset.x - postReconcile.x;
          const oy = preReset.y - postReconcile.y;
          const dist = Math.hypot(ox, oy);
          // Stage 3 — feed the per-remote correction magnitude into the
          // hysteresis guard. 3 consecutive corrections > 5 u disable
          // forward-prediction for this remote; 3 consecutive < 5 u
          // re-enable it. Sticky thresholds avoid oscillation.
          recordRemoteCorrection(this._predGuard, remoteId, dist);
          if (dist > 1) {
            const halfLifeMs = remoteOffsetHalfLifeForDrift(dist);
            // Re-anchor the spring at the new offset; velocity zeroed
            // so the spring's first step is governed purely by the new
            // offset. This matches Reconciler.reconcile behaviour.
            const existing = this._remoteShipOffsets.get(remoteId);
            if (existing) {
              existing.sx.x = ox;
              existing.sx.v = 0;
              existing.sy.x = oy;
              existing.sy.v = 0;
              existing.halfLifeMs = halfLifeMs;
            } else {
              this._remoteShipOffsets.set(remoteId, {
                sx: { x: ox, v: 0 },
                sy: { x: oy, v: 0 },
                halfLifeMs,
              });
            }
          }
        }
      }

      const drift = this.reconciler.lastDrift;
      const angleDrift = this.reconciler.lastAngleDrift;
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
      const px = (n: number): number => parseFloat(n.toFixed(3));
      const recPositions = {
        serverX: px(rec.lastServerState.x), serverY: px(rec.lastServerState.y),
        beforeX: px(rec.lastBeforePos.x),   beforeY: px(rec.lastBeforePos.y),
        afterX:  px(rec.lastAfterPos.x),    afterY:  px(rec.lastAfterPos.y),
      };

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
        ...recPositions,
      });

      useUIStore.getState().setDevData({
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
    const seen = new Set<string>();
    for (const [entityId, entry] of this.mirror.swarm) {
      const key = `swarm-${entityId}`;
      seen.add(key);
      if (!this.predWorld.hasShip(key)) {
        // Asteroids (kind=0) get a deterministic convex-polygon collider —
        // identical vertices to the server because both sides seed from the
        // same entityId. Drones (kind=1) stay circular.
        const vertices = entry.kind === 0
          ? generateAsteroidVertices(entityId, entry.radius)
          : undefined;
        this.predWorld.spawnObstacle(key, entry.x, entry.y, entry.radius, 3, vertices);
        // Lock asteroids (kind=0) only — they're static on the server and
        // locking them stops the player from pushing them out of pose
        // during reconciler replay. Drones (kind=1) carry non-zero
        // velocity from the server's AI and are unlocked so the client
        // simulates the same dynamic-vs-dynamic collision response the
        // server resolves.
        if (entry.kind === 0) {
          this.predWorld.lockBody(key);
        } else {
          // kind=1 (drone): register a HostileDroneBehaviour with the
          // client's AiController. Same module the server runs, same
          // ship-kind tuning, so given identical (self, view) inputs
          // both sides produce identical (fx, fy, torque) intents.
          // `slot` is the numeric entityId — the sink uses it as the
          // predWorld key suffix (`swarm-${slot}`).
          const kind = getShipKind(entry.shipKind ?? null);
          this._aiController.register(`${entityId}`, entityId, new HostileDroneBehaviour(kind));
          this._aiRegisteredIds.add(entityId);
        }
        this.predSwarmKeys.add(key);
      }
      // Capture pre-snap pose for drones so we can drive the render lerp
      // offset (see `_droneRenderOffsets`). Only meaningful when the body
      // already exists; first-spawn case has nothing to lerp from.
      // Position AND angle are captured — drones rotate under AI to track
      // the player, and a packet snap rewinds `LEAD_TICKS × angvel × dt`
      // worth of rotation. Without smoothing the angle the sprite visibly
      // jolts on every packet (the user-reported "still jittering" after
      // the position-only spring landed in commit ac429de).
      let preSnapX: number | undefined;
      let preSnapY: number | undefined;
      let preSnapAngle: number | undefined;
      let preSnapAngvel: number | undefined;
      if (entry.kind === 1) {
        const pre = this.predWorld.getShipState(key);
        if (pre) {
          preSnapX = pre.x;
          preSnapY = pre.y;
          preSnapAngle = pre.angle;
          preSnapAngvel = pre.angvel ?? 0;
        }
      }
      // Phase C follow-up (2026-05-09 mobile re-test): for drones the most
      // recent snapshot anchored, the snapshot+replay path owns predWorld
      // pose. Skip the binary-packet setShipState call entirely — it would
      // pull predWorld backward by `currentTick − ackedTick` ticks of
      // motion, restoring exactly the divergence Phase C tries to remove.
      // Out-of-interest drones (not in the anchor set) still need the
      // binary path because the snapshot doesn't carry them; the spring
      // offset capture below applies to those too. Asteroids (kind=0) are
      // never AI-driven and use the binary-packet path unconditionally.
      const skipSetShipState = entry.kind === 1 && this._droneSnapshotAnchored.has(entityId);
      if (!skipSetShipState) {
        // 2026-05-09 AI lockstep (Phase A): pass angvel through. Wire-format v3
        // carries the field; without it the client AI's `1.5·ω` damping term
        // ran on a free-evolving predWorld value while the server's ran on the
        // SAB-authoritative one — drone bearing diverged every tick. World
        // setShipState (`World.ts:359`) wakes the body via Rapier's setAngvel.
        this.predWorld.setShipState(key, {
          x: entry.x, y: entry.y, vx: entry.vx, vy: entry.vy, angle: entry.angle, angvel: entry.angvel,
        });
      }
      if (
        entry.kind === 1
        && preSnapX !== undefined
        && preSnapY !== undefined
        && preSnapAngle !== undefined
        && preSnapAngvel !== undefined
      ) {
        const ox = preSnapX - entry.x;
        const oy = preSnapY - entry.y;
        const oa = normalizeAngleDelta(preSnapAngle - entry.angle);
        const oavel = preSnapAngvel - entry.angvel;
        const dist = Math.hypot(ox, oy);
        // Spring-offset capture is only useful when we actually snapped
        // predWorld backward (binary-packet path). For snapshot-anchored
        // drones we skipped the setShipState above so predWorld is
        // unchanged → no jolt to smooth → no spring needed. Gating here
        // keeps the diagnostic + stats capture below firing for ALL
        // drones (so the test can observe alignment quality even when
        // the new path produces ~0 deltas).
        if (!skipSetShipState && (dist > 0.05 || Math.abs(oa) > 0.06)) {
          const halfLifeMs = droneRenderOffsetHalfLifeForDrift(dist);
          const existing = this._droneRenderOffsets.get(entityId);
          if (existing) {
            existing.sx.x = ox; existing.sx.v = 0;
            existing.sy.x = oy; existing.sy.v = 0;
            existing.sa.x = oa; existing.sa.v = 0;
            existing.halfLifeMs = halfLifeMs;
          } else {
            this._droneRenderOffsets.set(entityId, {
              sx: { x: ox, v: 0 },
              sy: { x: oy, v: 0 },
              sa: { x: oa, v: 0 },
              halfLifeMs,
            });
          }
        }

        // Phase B (2026-05-09 AI lockstep) — per-drone snap diagnostic.
        // Records pre/post pose, snap distance, angle delta, angvel delta
        // for *every* snap on an existing entry (not first-sight). The
        // log-emit is throttled to one event per drone per 4 server ticks
        // so the 500-entry ring isn't dominated by snap events at 10
        // drones × 20 Hz. The stats ring buffer is updated unthrottled —
        // p50/p99 in `stats.swarmSnap*` reflect every snap.
        const angleSnap = Math.abs(oa);
        const angvelDelta = Math.abs(oavel);
        // Sliding window of 240 events (~12 s at 20 Hz × 10 in-interest
        // drones). Older entries drop off the front; FIFO trim keeps the
        // arrays bounded without per-tick allocation.
        if (this._swarmSnapDistBuf.length >= 240) this._swarmSnapDistBuf.shift();
        if (this._swarmSnapAngleBuf.length >= 240) this._swarmSnapAngleBuf.shift();
        if (this._swarmSnapAngvelBuf.length >= 240) this._swarmSnapAngvelBuf.shift();
        this._swarmSnapDistBuf.push(dist);
        this._swarmSnapAngleBuf.push(angleSnap);
        this._swarmSnapAngvelBuf.push(angvelDelta);
        this.stats.swarmSnapCount++;
        // Throttle p50/p99 recompute to once per second. The stats are
        // diagnostic-only (read by the Capture button in SettingsModal),
        // so refreshing at 1 Hz is more than adequate. Unthrottled, this
        // function was the #1 non-MUI hit in the drawer-lag CPU profile
        // (2.3 s of self-time during a 13.7 s drawer-mount window) —
        // 3 array sorts × 200 swarm-snap events/s = 600 sorts/s on the
        // main thread, blocking the React render of the MUI Drawer.
        const nowMs = performance.now();
        if (nowMs - this._swarmSnapStatsLastMs >= 1000) {
          this._swarmSnapStatsLastMs = nowMs;
          this._recomputeSwarmSnapStats();
        }

        const lastTick = this._swarmSnapLastLogTick.get(entityId) ?? -1000;
        if (this.stats.lastServerTick - lastTick >= 4) {
          this._swarmSnapLastLogTick.set(entityId, this.stats.lastServerTick);
          logEvent('swarm_snap_diagnostics', {
            entityId,
            kind: entry.kind,
            shipKind: entry.shipKind ?? null,
            pre: {
              x: parseFloat(preSnapX.toFixed(3)),
              y: parseFloat(preSnapY.toFixed(3)),
              angle: parseFloat(preSnapAngle.toFixed(4)),
              angvel: parseFloat(preSnapAngvel.toFixed(4)),
            },
            post: {
              x: parseFloat(entry.x.toFixed(3)),
              y: parseFloat(entry.y.toFixed(3)),
              angle: parseFloat(entry.angle.toFixed(4)),
              angvel: parseFloat(entry.angvel.toFixed(4)),
            },
            snapDistance: parseFloat(dist.toFixed(3)),
            angleSnap: parseFloat(angleSnap.toFixed(4)),
            angvelDelta: parseFloat(angvelDelta.toFixed(4)),
            serverTick: this.stats.lastServerTick,
            inputTick: this.inputTick,
          });
        }
      }
    }
    // Sweep predWorld bodies whose entityId no longer appears in mirror.swarm.
    for (const key of this.predSwarmKeys) {
      if (!seen.has(key)) {
        this.predWorld.despawnShip(key);
        this.predSwarmKeys.delete(key);
        // If the swept body was a drone, unregister from the AI controller
        // and drop any pending render lerp offset. Numeric entityId is
        // encoded in the key as `swarm-${id}`.
        const idStr = key.startsWith('swarm-') ? key.slice(6) : '';
        const id = Number(idStr);
        if (Number.isFinite(id)) {
          if (this._aiRegisteredIds.has(id)) {
            this._aiController.unregister(`${id}`);
            this._aiRegisteredIds.delete(id);
          }
          this._droneRenderOffsets.delete(id);
        }
        // Phase B — drop any per-drone log throttle so a respawned entity
        // (same id, fresh ship) gets a snap event on its next packet.
        this._swarmSnapLastLogTick.delete(id);
      }
    }
  }

  /** Phase B — recompute sliding-window p50/p99 across the snap-event rings.
   *  Called once per push; the rings are bounded at 240 so cost is bounded
   *  even when many drones are in interest. Single shared scratch array is
   *  acceptable here because reads happen once per push, not per frame. */
  private _statsScratch: number[] = [];
  /** Wall-clock ms of the last `_recomputeSwarmSnapStats` call. Used to
   *  throttle the O(n log n) percentile sort to ~1 Hz (it was running
   *  ~200×/s pre-throttle, costing 2.3 s of CPU during the drawer-mount
   *  window — see the drawer-lag CPU profile). */
  private _swarmSnapStatsLastMs = 0;

  private _recomputeSwarmSnapStats(): void {
    const dist = this._swarmSnapDistBuf;
    if (dist.length === 0) {
      this.stats.swarmSnapP50 = 0;
      this.stats.swarmSnapP99 = 0;
      this.stats.swarmAngleP99 = 0;
      this.stats.swarmAngvelP99 = 0;
      return;
    }
    // Reuse the scratch array to avoid per-snap allocation.
    const scratch = this._statsScratch;
    scratch.length = dist.length;
    for (let i = 0; i < dist.length; i++) scratch[i] = dist[i]!;
    scratch.sort((a, b) => a - b);
    this.stats.swarmSnapP50 = scratch[Math.floor(scratch.length * 0.5)]!;
    this.stats.swarmSnapP99 = scratch[Math.floor(scratch.length * 0.99)]!;

    const ang = this._swarmSnapAngleBuf;
    scratch.length = ang.length;
    for (let i = 0; i < ang.length; i++) scratch[i] = ang[i]!;
    scratch.sort((a, b) => a - b);
    this.stats.swarmAngleP99 = scratch[Math.floor(scratch.length * 0.99)]!;

    const av = this._swarmSnapAngvelBuf;
    scratch.length = av.length;
    for (let i = 0; i < av.length; i++) scratch[i] = av[i]!;
    scratch.sort((a, b) => a - b);
    this.stats.swarmAngvelP99 = scratch[Math.floor(scratch.length * 0.99)]!;
  }

  /** Sync authoritative projectile positions from the per-recipient snapshot.
   *  Wire-discipline P3: projectiles no longer live on the Colyseus schema —
   *  the server includes only the in-interest subset on each snapshot, so a
   *  projectile leaving interest will simply disappear from `seen` and be
   *  removed from the mirror. Ghost projectiles (`isGhost: true`) are
   *  preserved; the GhostManager re-adds them per-frame anyway. */
  private syncProjectiles(projectiles: SnapshotMessage['projectiles']): void {
    if (!this.mirror.projectiles) return;
    const seen = new Set<string>();
    if (projectiles) {
      for (const p of projectiles) {
        seen.add(p.id);
        // Preserve client-integrated x/y for existing entries — replacing them
        // every snapshot would snap the bolt back ~50 ms (one broadcast period)
        // against its travel direction, producing the visible 20 Hz stutter.
        // We accept the small server/client position drift; vx/vy are still
        // refreshed authoritatively each snapshot.
        const prev = this.mirror.projectiles.get(p.id);
        const isNew = !prev || prev.isGhost;
        this.mirror.projectiles.set(p.id, {
          x: isNew ? p.x : prev.x,
          y: isNew ? p.y : prev.y,
          vx: p.vx,
          vy: p.vy,
          ownerId: p.ownerId,
          isGhost: false,
          weaponId: p.weaponId,
        } satisfies ProjectileRenderState);
      }
    }
    for (const [id, entry] of this.mirror.projectiles) {
      if (entry.isGhost) continue;
      if (!seen.has(id)) this.mirror.projectiles.delete(id);
    }
  }

  /**
   * Phase 4 — refresh wreck poses from the snapshot. Identity flows
   * over Colyseus schema diff (see syncMirror); this keeps x/y/vx/vy/angle
   * fresh per frame so the renderer can draw the drifting hull, AND
   * mirrors that pose into a predWorld body so the local player's
   * predicted ship collides with the wreck instead of passing through
   * it. The wreck body uses `wreck-${shipInstanceId}` as its predWorld
   * id (disambiguates from the playerId namespace).
   */
  private syncWreckPoses(wrecks: SnapshotMessage['wrecks']): void {
    if (!this.mirror.wrecks) return;
    if (!wrecks) return;
    for (const w of wrecks) {
      const entry = this.mirror.wrecks.get(w.id);
      if (!entry) continue;
      entry.x = w.x;
      entry.y = w.y;
      entry.vx = w.vx;
      entry.vy = w.vy;
      entry.angle = w.angle;
      entry.angvel = w.angvel;

      // Spawn or update the predWorld body. Spawn lazily here because
      // the schema diff lands first (with x/y=0); we need real pose
      // before we can place the body sensibly. setShipState pushes the
      // latest snapshot pose in every tick — same pattern remote ships
      // use, so the local player's predicted collisions see a fresh
      // wreck position once per snapshot (~20 Hz).
      if (this.predWorld) {
        const bodyId = `wreck-${w.id}`;
        if (!this.predWorld.hasShip(bodyId)) {
          this.predWorld.spawnShip(bodyId, w.x, w.y, entry.kind);
          this.predWreckIds.add(bodyId);
        }
        this.predWorld.setShipState(bodyId, {
          x: w.x, y: w.y, angle: w.angle,
          vx: w.vx, vy: w.vy,
          angvel: w.angvel,
        });
      }
    }
  }

  // ── State mirror ────────────────────────────────────────────────────────

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
      const seenWrecks = new Set<string>();
      for (const [shipInstanceId, w] of wreckMap.entries()) {
        const wr = w as Record<string, unknown>;
        seenWrecks.add(shipInstanceId);
        const prev = this.mirror.wrecks.get(shipInstanceId);
        this.mirror.wrecks.set(shipInstanceId, {
          shipInstanceId,
          x: prev?.x ?? 0,
          y: prev?.y ?? 0,
          vx: prev?.vx ?? 0,
          vy: prev?.vy ?? 0,
          angle: prev?.angle ?? 0,
          angvel: prev?.angvel ?? 0,
          kind: typeof wr['kind'] === 'string' ? (wr['kind'] as string) : 'fighter',
          health: Number(wr['health'] ?? 0),
          maxHealth: Number(wr['maxHealth'] ?? 100),
        });
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
    const now = performance.now();
    const seen = new Set<string>();

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
      if (!isActive) {
        // Phase 6b — populate identity for the lingering hull. Pose
        // arrives separately in the snapshot's `states` slice and is
        // mirrored in handleSnapshot. We only set kind / displayName /
        // ownerPlayerId here from the schema diff (low-frequency).
        const kind = typeof sh['kind'] === 'string' ? (sh['kind'] as string) : undefined;
        const displayName = typeof sh['displayName'] === 'string' ? (sh['displayName'] as string) : undefined;
        const prev = this.mirror.lingeringShips.get(shipInstanceId);
        this.mirror.lingeringShips.set(shipInstanceId, {
          x: prev?.x ?? 0,
          y: prev?.y ?? 0,
          vx: prev?.vx ?? 0,
          vy: prev?.vy ?? 0,
          angle: prev?.angle ?? 0,
          ownerPlayerId: playerId,
          ...(kind !== undefined ? { kind } : {}),
          ...(displayName !== undefined ? { displayName } : {}),
        });
        // Phase 6b cleanup (2026-05-13) — spawn the predWorld body
        // here too, in case the schema diff arrived BEFORE the first
        // snapshot. Without this, the predWorld body was deferred a
        // full snapshot tick, letting the local player fly through
        // their own freshly-displaced hulk on flaky networks.
        //
        // Jitter-fix (2026-05-13) — but ONLY spawn on first observation.
        // `onStateChange` fires on every schema mutation (~60 Hz when
        // `state.tick` updates), so an unconditional call would teleport
        // the body back to the last-snapshot pose every tick — the
        // dual-correction-path jitter bug, same shape as the AI lockstep
        // chapter-2 dual-path fight. The snapshot path
        // (`handleSnapshot`) is the canonical correction path for
        // lingering hull poses; this path is identity-only (kind,
        // displayName, ownerPlayerId).
        const bodyId = `linger-${shipInstanceId}`;
        if (this.predWorld && !this.predWorld.hasShip(bodyId)) {
          this.tryEnsureLingerPredBody(shipInstanceId);
        }
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
    const localId = this.mirror.localPlayerId;

    // Local ship — prediction + lerp correction.
    if (localId && this.predWorld && this.reconciler) {
      const state = this.predWorld.getShipState(localId);
      if (state) {
        const ox = this.reconciler.lerpOffset.x;
        const oy = this.reconciler.lerpOffset.y;
        const oa = this.reconciler.lerpAngleOffset;
        this.reconciler.advanceLerp(this.lastFrameMs);
        // Preserve non-spatial fields across per-frame rewrites so the
        // renderer keeps drawing the correct silhouette and the local-
        // turret rotation state survives the per-frame mirror rebuild.
        // `kind` was the first such field; `displayName` follows the same
        // pattern; `mountAngles` (Phase 4b.2) is critical — `tickLocalMountAim`
        // writes it on the same frame and `updateLiveBeam` re-derives the
        // beam geometry from it, so wiping it here makes the visible beam
        // flip back to baseAngle every render frame (visible bug: a solid
        // unrotated beam under the flickering correctly-rotated ghost).
        const prev = this.mirror.ships.get(localId);
        this.mirror.ships.set(localId, {
          x: state.x + ox,
          y: state.y + oy,
          vx: state.vx,
          vy: state.vy,
          angle: state.angle + oa,
          ...(prev?.kind ? { kind: prev.kind } : {}),
          ...(prev?.displayName !== undefined ? { displayName: prev.displayName } : {}),
          ...(prev?.mountAngles ? { mountAngles: prev.mountAngles } : {}),
        });

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
          const nowNear = new Set<number>();
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
          this._swarmNearbyIds = nowNear;
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

    // Phase 3 (2026-05-09): drone visual smoothness.
    //
    // After the client-side AI fix, drones in predWorld have AI-integrated
    // positions matching the server. But the renderer was still reading
    // their pose via `interpolateSwarmPose` — a linear dead-reckoning from
    // the latest packet's velocity that doesn't see AI impulses. Each new
    // packet snapped the sprite to the new packet pose, producing the
    // visible jolt the user reported ("enemy ships look jolty and jumpy").
    //
    // Fix: write predWorld's drone pose into the mirror entry each frame.
    // Combined with the renderer change to use `entry.x/y/angle` directly
    // for drones (skipping the dead-reckoning branch), the sprite tracks
    // predWorld's smooth AI-integrated motion exactly like player ships
    // track their predWorld pose.
    //
    // Asteroids (kind=0) remain locked in predWorld and continue to use
    // `interpolateSwarmPose` against the packet ring — their pose changes
    // discretely on collision events, where the lerp is the right choice.
    if (this.predWorld && this.mirror.swarm) {
      for (const [entityId, entry] of this.mirror.swarm) {
        if (entry.kind !== 1) continue;
        const pose = this.predWorld.getShipState(`swarm-${entityId}`);
        if (!pose) continue;
        // Apply (and decay) the per-drone render lerp offset so the
        // ~50 ms-cadence packet snap is invisible. Spring is shared
        // shape with `_remoteShipOffsets`. Drop the entry once all
        // three axes settle below the noise floor.
        let ox = 0, oy = 0, oa = 0;
        const off = this._droneRenderOffsets.get(entityId);
        if (off) {
          springStep(off.sx, 0, off.halfLifeMs, this.lastFrameMs);
          springStep(off.sy, 0, off.halfLifeMs, this.lastFrameMs);
          springStep(off.sa, 0, off.halfLifeMs, this.lastFrameMs);
          ox = off.sx.x;
          oy = off.sy.x;
          oa = off.sa.x;
          const stillMoving =
            Math.abs(off.sx.x) > REMOTE_SPRING_POS_END ||
            Math.abs(off.sy.x) > REMOTE_SPRING_POS_END ||
            Math.abs(off.sa.x) > REMOTE_SPRING_POS_END ||
            Math.abs(off.sx.v) > REMOTE_SPRING_VEL_END_MS ||
            Math.abs(off.sy.v) > REMOTE_SPRING_VEL_END_MS ||
            Math.abs(off.sa.v) > REMOTE_SPRING_VEL_END_MS;
          if (!stillMoving) this._droneRenderOffsets.delete(entityId);
        }
        entry.x = pose.x + ox;
        entry.y = pose.y + oy;
        entry.angle = pose.angle + oa;
        entry.vx = pose.vx;
        entry.vy = pose.vy;
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
        const prev = this.mirror.ships.get(remoteId);
        this.mirror.ships.set(remoteId, {
          ...s,
          x: s.x + ox,
          y: s.y + oy,
          ...(prev?.kind ? { kind: prev.kind } : {}),
          ...(prev?.displayName !== undefined ? { displayName: prev.displayName } : {}),
          // Phase 4b.3: preserve mount angles across per-frame rebuilds
          // so the snapshot-anchored values from `handleSnapshot` survive
          // until the next snapshot lands. Same pattern as the local
          // ship's preserve path.
          ...(prev?.mountAngles ? { mountAngles: prev.mountAngles } : {}),
        });
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
    if (this.predWorld && this.mirror.lingeringShips) {
      for (const [shipInstanceId, entry] of this.mirror.lingeringShips) {
        const bodyId = `linger-${shipInstanceId}`;
        if (!this.predWorld.hasShip(bodyId)) continue;
        const pose = this.predWorld.getShipState(bodyId);
        if (!pose) continue;
        const off = this._lingeringShipOffsets.get(shipInstanceId);
        let ox = 0, oy = 0;
        if (off) {
          springStep(off.sx, 0, off.halfLifeMs, this.lastFrameMs);
          springStep(off.sy, 0, off.halfLifeMs, this.lastFrameMs);
          ox = off.sx.x;
          oy = off.sy.x;
          const stillMoving =
            Math.abs(off.sx.x) > REMOTE_SPRING_POS_END ||
            Math.abs(off.sy.x) > REMOTE_SPRING_POS_END ||
            Math.abs(off.sx.v) > REMOTE_SPRING_VEL_END_MS ||
            Math.abs(off.sy.v) > REMOTE_SPRING_VEL_END_MS;
          if (!stillMoving) this._lingeringShipOffsets.delete(shipInstanceId);
        }
        entry.x = pose.x + ox;
        entry.y = pose.y + oy;
        entry.angle = pose.angle;
        entry.vx = pose.vx;
        entry.vy = pose.vy;
      }
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

    // explodingShips is cleared in App.tsx AFTER renderer.update() so the renderer
    // actually sees the set on the frame it was populated.

    // Expire remote lasers past their TTL. Per-mount, so different mounts on
    // the same shooter independently fade out as their cooldown windows end.
    if (this.mirror.remoteLasers && this.mirror.remoteLasers.size > 0) {
      const now = performance.now();
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
  tickPhysics(elapsedMs: number): void {
    if (!this.room || !this.keyboard) return;
    this.lastFrameMs = elapsedMs;
    if (this.welcomePerfNow === 0) return; // welcome not yet received
    // Frame-gap detector. The mobile capture
    // `2026-05-09T07-23-39-893Z-651792` showed two ~500–600 ms RAF stalls
    // that bunched WebSocket arrivals into a single post-stall snapshot
    // and saturated the prediction window for tens of seconds. Logging
    // every RAF would saturate the 500-entry ring buffer in ~8 s; logging
    // only the gaps gives one entry per genuine stall, paired with the
    // `longtask` observer's attribution (when supported) to pin the cause.
    if (elapsedMs > 100) {
      logEvent('raf_gap', {
        elapsedMs: Math.round(elapsedMs * 100) / 100,
        inputTickBefore: this.inputTick,
      });
    }
    const FIXED_MS = 1000 / 60;
    const MAX_CATCH_UP_TICKS = 4;
    const ticksSinceAnchor = Math.floor((performance.now() - this.clockAnchorPerfNow) / FIXED_MS);
    const targetTick = this.clockAnchorServerTick + ticksSinceAnchor + this.leadTicks;
    const tickDeficitBefore = targetTick - this.inputTick;
    let stepsThisFrame = 0;
    while (this.inputTick < targetTick && stepsThisFrame < MAX_CATCH_UP_TICKS) {
      stepsThisFrame++;
      const kb = this.keyboard.read();
      let tcThrust = false, tcTurnLeft = false, tcTurnRight = false, tcFire = false;
      if (this.touchInput) {
        tcFire = this.touchInput.getFireHeld();
        const v = this.touchInput.getJoystickVector();
        const localId = this.mirror.localPlayerId;
        const localShip = localId ? this.mirror.ships.get(localId) : null;
        if (v && localShip) {
          const mag = Math.hypot(v.x, v.y);
          if (mag > TOUCH_DEADZONE) {
            // Physics: ship at angle θ has forward = (-sin θ, cos θ) in world coords.
            // Renderer: sprite.y = -ship.y (world +Y → screen UP).
            // nipplejs: vector.y is already inverted from screen y, so stick UP → v.y > 0.
            // Mapping: stick UP (v=(0,1)) → forward=(0,1) → θ=0;
            //          stick RIGHT (v=(1,0)) → forward=(1,0) → θ=-π/2.
            const targetAngle = Math.atan2(-v.x, v.y);
            let delta = targetAngle - localShip.angle;
            // Wrap to [-π, π] so the ship turns the short way around.
            while (delta >  Math.PI) delta -= 2 * Math.PI;
            while (delta < -Math.PI) delta += 2 * Math.PI;
            // World.applyInput: turnLeft → +angvel (CCW, increasing angle).
            if (delta >  TOUCH_TURN_TOLERANCE) tcTurnLeft  = true;
            else if (delta < -TOUCH_TURN_TOLERANCE) tcTurnRight = true;
            // Thrust only when stick is pushed firmly AND ship roughly faces target.
            if (Math.abs(delta) < TOUCH_THRUST_CONE && mag > TOUCH_THRUST_MAG) {
              tcThrust = true;
            }
          }
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
      // Phase 3 (2026-05-09): tick the AI BEFORE applying this tick's input.
      // Server's AI runs at end of `update()` post-step, using state from
      // the just-completed tick (no current-tick input applied yet). To
      // match, the client's AI must see the *pre-step* state too — i.e.
      // before this tick's `applyInput` modifies the player body. Otherwise
      // the player's velocity in the AI's view differs by one input
      // application from what the server saw.
      this.tickClientAi();
      if (!this.localDead && this.predWorld && this.reconciler && this.mirror.localPlayerId) {
        const nowMs = performance.now();
        const rec: InputRecord = { tick, thrust, turnLeft, turnRight, boost, reverse, sentAt: nowMs };
        this.predWorld.applyInput(this.mirror.localPlayerId, { thrust, turnLeft, turnRight, boost, reverse });
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
        const allIdle = !thrust && !turnLeft && !turnRight && !boost && !reverse;
        const lastAllIdle = !!last && !last.thrust && !last.turnLeft && !last.turnRight && !last.boost && !last.reverse;
        const stateChanged = !last
          || last.thrust !== thrust
          || last.turnLeft !== turnLeft
          || last.turnRight !== turnRight
          || last.boost !== boost
          || last.reverse !== reverse;
        const heartbeatDue = nowMs - this.lastSentInputAtMs >= INPUT_HEARTBEAT_MS;
        const throttle = allIdle && lastAllIdle && !stateChanged && !heartbeatDue;
        if (!throttle) {
          this.room.send('input', { type: 'input', tick, thrust, turnLeft, turnRight, boost, reverse });
          this.lastSentInputState = { thrust, turnLeft, turnRight, boost, reverse };
          this.lastSentInputAtMs = nowMs;
          if (stateChanged || (tick % 60) === 0) {
            logEvent('inputSent', { tick, thrust, turnLeft, turnRight, boost, reverse });
          }
        }
        // Show the local exhaust trail without waiting an RTT for the server
        // to confirm — the next snapshot will overwrite from server truth.
        if (this.mirror.boostingShips) {
          if (boost && thrust) this.mirror.boostingShips.add(this.mirror.localPlayerId);
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
      }

      // Multi-mount/turret refactor (Phase 4b.2): client-side turret aim
      // update for the local ship. Runs every physics tick so the
      // rotation stays continuous and the beams emerge from the slewed
      // mount direction. Skipped while dead (no aim to compute) and when
      // the player has no predWorld state yet.
      this.tickLocalMountAim(1 / 60);

      if (fireHeld && this.mirror.localPlayerId && !this.localDead) {
        const activeWeapon = useUIStore.getState().activeWeapon;
        const activeWeaponDef = getWeapon(activeWeapon);
        if (activeWeaponDef.mode === 'hitscan') {
          this.updateLiveBeam();
        } else {
          this.mirror.liveBeams?.clear();
        }
        if (tick - this.lastFiredAtTick >= activeWeaponDef.cooldownTicks) {
          this.sendFire(tick);
          this.lastFiredAtTick = tick;
        }
      } else {
        this.mirror.liveBeams?.clear();
      }
    }

    // One ring-buffer entry per RAF — diagnostic data for capture analysis.
    // Sampled to keep buffer-friendly: every 6th RAF, plus any frame whose
    // catch-up window was non-trivial (≥ 2 ticks deficit). One log line per
    // frame would saturate the 500-entry buffer in ~10 s.
    const anomalous = tickDeficitBefore >= 2;
    if (anomalous || (this.inputTick & 0b11) === 0) {
      logEvent('rafTick', {
        elapsedMs: Math.round(elapsedMs * 100) / 100,
        targetTick,
        inputTick: this.inputTick,
        deficitBefore: tickDeficitBefore,
        stepsThisFrame,
        capped: stepsThisFrame >= MAX_CATCH_UP_TICKS && this.inputTick < targetTick,
        anchorServerTick: this.clockAnchorServerTick,
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
  private tickLocalMountAim(dtSec: number): void {
    const localId = this.mirror.localPlayerId;
    if (!localId || !this.predWorld) return;
    const ship = this.mirror.ships.get(localId);
    if (!ship) return;
    const state = this.predWorld.getShipState(localId);
    if (!state) return;
    const mounts = this.localShipMounts();
    if (mounts.length === 0) {
      if (ship.mountAngles) ship.mountAngles = undefined;
      return;
    }

    // Gather drone targets from the swarm mirror. We use the swarm
    // sprite's current rendered pose (post-interpolation) because the
    // turret should aim at where the player visually sees the drone, not
    // at the raw network pose 100 ms in the past.
    const targets = this._droneTargetsScratch;
    targets.length = 0;
    if (this.mirror.swarm) {
      for (const [entityId, sw] of this.mirror.swarm) {
        if (sw.kind !== 1) continue; // asteroids aren't valid targets
        targets.push({
          id: `swarm-${entityId}`,
          x: sw.x,
          y: sw.y,
          vx: sw.vx,
          vy: sw.vy,
        });
      }
    }

    // Range gate: only acquire targets within hitscan reach. Out-of-range
    // drones don't peg the turret — when no candidate is in view, the
    // mounts slew back to forward (the `if (target === null)` branch
    // below). User-requested feedback (2026-05-11): "return the weapons
    // to aiming forwards when an enemy ship is out of range".
    const target = pickTarget(state.x, state.y, targets, this._localSlotTarget, () => true, {
      maxDistance: HITSCAN_RANGE,
    });
    this._localSlotTarget = target?.id ?? null;

    // Allocate / resize the per-ship mountAngles array. number[] is fine
    // here — N is small (1–3) and the array survives multiple frames.
    let angles = ship.mountAngles;
    if (!angles || angles.length !== mounts.length) {
      angles = new Array<number>(mounts.length).fill(0);
      ship.mountAngles = angles;
    }

    if (target === null) {
      // No target — slew every mount back to its base (0 in mount-local frame).
      for (let i = 0; i < mounts.length; i++) {
        angles[i] = rotateMountToward(angles[i] ?? 0, 0, mounts[i]!, dtSec);
      }
      return;
    }

    // For each mount: compute the world-bearing from the mount's pivot to
    // the target, subtract ship.angle (rotate into ship-local frame) and
    // mount.baseAngle (rotate into mount-local frame), then slew toward
    // that bearing within the mount's arc and speed limits.
    const cosA = Math.cos(state.angle);
    const sinA = Math.sin(state.angle);
    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]!;
      const mountWorldX = state.x + (mount.localX * cosA - mount.localY * sinA);
      const mountWorldY = state.y + (mount.localX * sinA + mount.localY * cosA);
      const dx = target.x - mountWorldX;
      const dy = target.y - mountWorldY;
      // World bearing — same convention as ship.angle: `atan2(-dx, dy)`
      // (forward = -y, right = +x).
      const worldBearing = Math.atan2(-dx, dy);
      const mountLocalBearing = wrapPi(worldBearing - state.angle - mount.baseAngle);
      angles[i] = rotateMountToward(angles[i] ?? 0, mountLocalBearing, mount, dtSec);
    }
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
    const state = this.predWorld.getShipState(localId);
    if (!state) return;
    const ship = this.mirror.ships.get(localId);

    const liveBeams = (this.mirror.liveBeams ??= new Map());
    const mounts = this.localShipMounts();
    if (mounts.length === 0) {
      // Defensive: ship-kind has no mounts. Clear any stale beams.
      liveBeams.clear();
      return;
    }

    // Drop entries for mounts no longer present (e.g. ship-kind changed
    // mid-life — currently impossible but cheap to guard).
    const mountIds = new Set<string>();
    for (const m of mounts) mountIds.add(m.id);
    for (const id of liveBeams.keys()) if (!mountIds.has(id)) liveBeams.delete(id);

    const cosA = Math.cos(state.angle);
    const sinA = Math.sin(state.angle);
    const mountAngles = ship?.mountAngles;
    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]!;
      const mountWorldX = state.x + (mount.localX * cosA - mount.localY * sinA);
      const mountWorldY = state.y + (mount.localX * sinA + mount.localY * cosA);
      const currentMountAngle = mountAngles?.[i] ?? 0;
      const mountAngle = state.angle + mount.baseAngle + currentMountAngle;
      const fwdX = -Math.sin(mountAngle);
      const fwdY = Math.cos(mountAngle);
      const fromX = mountWorldX + fwdX * 20;
      const fromY = mountWorldY + fwdY * 20;
      const hit = this.predWorld.hitscan(fromX, fromY, fwdX, fwdY, HITSCAN_RANGE, localId);
      liveBeams.set(mount.id, {
        dist: hit ? hit.dist : HITSCAN_RANGE,
        hitId: hit?.hitId,
      });
    }
  }

  /** Resolve the local player's currently-active slot's mount list. Returns
   *  the first slot's mounts when no `slotId` is in play (today's only path;
   *  multi-slot UI lands in a future phase). Empty array if the ship-kind
   *  has no mounts/slots or the local player hasn't joined yet. */
  private localShipMounts(): ReadonlyArray<WeaponMount> {
    const localId = this.mirror.localPlayerId;
    if (!localId) return [];
    const shipRender = this.mirror.ships.get(localId);
    const kindId = shipRender?.kind ?? null;
    const kind = getShipKind(kindId);
    const mounts = kind.mounts;
    const slots = kind.slots;
    if (!mounts || !slots || slots.length === 0) return [];
    const slot = slots[0]!;
    const out: WeaponMount[] = [];
    for (const mid of slot.mountIds) {
      const m = mounts.find((mm) => mm.id === mid);
      if (m) out.push(m);
    }
    return out;
  }

  /**
   * Phase 3 of the network-feel reset (2026-05-09) — client-side drone AI tick.
   *
   * Runs the same `AiController` + `HostileDroneBehaviour` modules the server
   * runs, so drones in the client's predWorld get the same per-tick impulses
   * the server's drones get. With identical inputs both sides produce
   * identical motion → drones in predWorld track the server's authoritative
   * drone positions, collisions resolve at matching geometry, hitscan rays
   * hit what the player aimed at.
   *
   * Determinism contract:
   *   - Player view comes from `predWorld.getShipState`, NOT `mirror.ships`.
   *     mirror.ships includes the reconciler's render-only lerp offset; the
   *     server never sees that. Using predWorld gives the AI the same
   *     authoritative-physics positions both sides use.
   *   - `entitySnapshot` reads the drone's current predWorld pose.
   *   - `view.tick` uses `inputTick` so behaviours' tick-based gates align
   *     with the server's tick numbering.
   *
   * Called from two places:
   *   1. `tickPhysics` input loop — each forward step from inputTick toward
   *      targetTick, mirroring the server's per-tick AI advance.
   *   2. `Reconciler.reconcile` per-replay-tick callback — each replay step
   *      reapplies AI to keep drone trajectory aligned with what the server
   *      simulated for that tick.
   *
   * Fire requests are drained and discarded — the server is still the
   * authority for drone shots; client predicts only drone movement, not
   * weapon resolution.
   */
  private tickClientAi(): void {
    if (!this.predWorld || this._aiRegisteredIds.size === 0) return;
    this._aiPlayersBuf.length = 0;
    for (const [pid] of this.mirror.ships) {
      const ps = this.predWorld.getShipState(pid);
      if (ps) this._aiPlayersBuf.push({ id: pid, x: ps.x, y: ps.y, vx: ps.vx, vy: ps.vy });
    }
    if (this._aiPlayersBuf.length === 0) return;
    this._aiController.tick(
      this.inputTick,
      1 / 60,
      this._aiPlayersBuf,
      (id): AiEntity | null => {
        const state = this.predWorld!.getShipState(`swarm-${id}`);
        if (!state) return null;
        return {
          id,
          x: state.x,
          y: state.y,
          vx: state.vx,
          vy: state.vy,
          angle: state.angle,
          angvel: state.angvel ?? 0,
        };
      },
    );
    this._aiController.drainFireRequests();
  }

  private sendFire(tick: number): void {
    const localId = this.mirror.localPlayerId;
    if (!localId || !this.predWorld || !this.room) return;
    const state = this.predWorld.getShipState(localId);
    if (!state) return;
    const activeWeapon = useUIStore.getState().activeWeapon;
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
    const cosA = Math.cos(state.angle);
    const sinA = Math.sin(state.angle);
    const localShip = this.mirror.ships.get(localId);
    const mountAngles = localShip?.mountAngles;
    if (mounts.length === 0) {
      // Defensive fallback: no mounts → spawn the legacy single ghost at
      // ship centre. Should not happen for any shipped kind today.
      const fwdX = -Math.sin(state.angle);
      const fwdY = Math.cos(state.angle);
      const fromX = state.x + fwdX * 20;
      const fromY = state.y + fwdY * 20;
      this.ghostManager.spawn(shotId, localId, fromX, fromY, fwdX, fwdY, activeWeapon, state.vx, state.vy);
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
        this.ghostManager.spawn(
          shotId,
          localId,
          fromX,
          fromY,
          fwdX,
          fwdY,
          activeWeapon,
          state.vx,
          state.vy,
          mount.id,
        );
      }
    }

    this.room.send('fire', {
      type: 'fire',
      tick,
      clientShotId: shotId,
      weapon: activeWeapon,
      dirAngle: state.angle,
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
      weapon: activeWeapon,
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

  dispose(): void {
    this.disposed = true;
    this.localDead = false;
    useUIStore.getState().setDead(false);
    this.keyboard = null;
    this.touchInput = null;
    this.room?.leave();
    this.room = null;
    this.predWorld?.dispose();
    this.predWorld = null;
    this.reconciler = null;
    this.remoteHistory.clear();
    this.predRemoteShipIds.clear();
    this._remoteShipOffsets.clear();
    this.predSwarmKeys.clear();
    this.mirror.swarm?.clear();
    this.mirror.projectiles?.clear();
    this.mirror.remoteLasers?.clear();
  }
}
