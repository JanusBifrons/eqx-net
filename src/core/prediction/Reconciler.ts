/**
 * Client-side prediction reconciler.
 *
 * The client runs a local PhysicsWorld to predict its own ship position each
 * tick (hiding network latency). When the server sends an authoritative
 * snapshot, the reconciler:
 *
 *   1. Rolls the prediction world back to the server state at the acked tick.
 *   2. Re-applies every buffered input from ackedTick → currentTick.
 *   3. Compares the resulting "corrected" position+angle to the pre-reconciliation
 *      prediction.
 *   4. If drift ≥ threshold, queues a critically-damped spring whose state is
 *      the visible offset (lerpOffset / lerpAngleOffset) decaying toward zero.
 *
 * The prediction world itself always holds the most up-to-date authoritative
 * estimate; lerpOffset is a pure render-layer shim.
 *
 * Stage 1 of the network-feel roadmap (2026-05-08) replaced the previous
 * frame-counted ratio² ease-out with a critically-damped spring step. The
 * spring is frame-rate independent (analytical closed-form), monotonic by
 * critical damping (no overshoot), and reads as "alive" because velocity
 * carries through rather than just decaying to zero. See
 * src/core/math/CritDampedSpring.ts for the math.
 */
import { springStep, type SpringState } from '../math/CritDampedSpring.js';
import { playerCorrectionHalfLifeMs } from './correctionSmoothing.js';
import type { PhysicsWorld, ShipPhysicsState } from '../physics/World.js';
import { REAL_CLOCK, type Clock } from '../clock/Clock.js';

const BUFFER_SIZE = 128; // ~2 s at 60 Hz
// Lerp ANY correction above noise floor so there are no silent position snaps.
// Float32 serialisation noise ≈ 1e-5 u; 0.05 u is well above that.
const LERP_THRESHOLD = 0.05;       // world units for position
const ANGLE_LERP_THRESHOLD = 0.001; // radians (~0.057°) for rotation

/** End-of-lerp termination thresholds. Both position/angle AND velocity must
 *  fall below their respective bounds before the lerp is considered "done".
 *  Setting POS_END at LERP_THRESHOLD means the spring's residual is at the
 *  noise floor when the lerp ends — no visible "twitch" past that point. */
const SPRING_POS_END = LERP_THRESHOLD;
const SPRING_VEL_END_MS = 0.05;        // 0.05 u/ms = 50 u/s, below ship speeds
const SPRING_ANGLE_END = ANGLE_LERP_THRESHOLD;
const SPRING_ANGVEL_END_MS = 0.001;    // 0.001 rad/ms ≈ 1 rad/s

// Spring half-life (time-to-half-offset) is chosen by drift magnitude via
// the pure `playerCorrectionHalfLifeMs` (see `correctionSmoothing.ts`).
// Pre-2026-05-17 this was a flat 25 ms for any drift ≥ 0.5 u; that snapped
// large network-bunched gap-recovery corrections (178–249 u) in ~5 frames
// — a teleport (diag `xxiyix`). Small steady-state corrections keep the
// 12/25 ms snappy feel (canary-safe); large gap corrections now glide.

export interface InputRecord {
  tick: number;
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  /** Shift-held boost. Optional for back-compat with replay buffers that
   *  pre-date this field — replay treats `undefined` as `false`. */
  boost?: boolean;
  /** S / Down-held reverse. Optional — replay treats `undefined` as `false`. */
  reverse?: boolean;
  /** performance.now() when the input was sent, for RTT estimation. */
  sentAt: number;
}

export class Reconciler {
  private readonly world: PhysicsWorld;
  private readonly playerId: string;

  private readonly buffer: (InputRecord | undefined)[];

  /** Visual position offset applied to rendered position, decaying to zero. */
  readonly lerpOffset = { x: 0, y: 0 };
  /** Spring states for the visual position offset (one per axis). Each spring
   *  decays its state toward zero with critical damping; the renderer reads
   *  the resulting `lerpOffset.x/y` as a render-time correction nudge. */
  private readonly _springX: SpringState = { x: 0, v: 0 };
  private readonly _springY: SpringState = { x: 0, v: 0 };
  private _lerping = false;

  /** Active correction's spring half-life (ms). 0 when not lerping. Public-
   *  readable for telemetry; e2e specs read this off the 'correction' log
   *  entry to verify the Stage 1 half-life selection survives through the
   *  production call path. */
  lerpHalfLifeMs = 0;

  /** Visual angle offset applied to rendered rotation, decaying to zero. */
  lerpAngleOffset = 0;
  private readonly _springA: SpringState = { x: 0, v: 0 };

  /** Most recent measured position drift (world units). Exposed for dev overlay. */
  lastDrift = 0;
  /** Most recent measured angle drift (radians). Exposed for dev overlay. */
  lastAngleDrift = 0;
  /** RTT estimate from last reconciliation (ms). Exposed for dev overlay. */
  lastRtt = 0;
  /** Raw server state received in the last snapshot (before replay). */
  lastServerState = { x: 0, y: 0 };
  /** predWorld position captured before reconciliation. */
  lastBeforePos = { x: 0, y: 0 };
  /** predWorld position after reconciliation (replay result). */
  lastAfterPos = { x: 0, y: 0 };

  private readonly clock: Clock;

  constructor(world: PhysicsWorld, playerId: string, clock: Clock = REAL_CLOCK) {
    this.world = world;
    this.playerId = playerId;
    this.clock = clock;
    this.buffer = new Array<InputRecord | undefined>(BUFFER_SIZE).fill(undefined);
  }

  /** Store an outbound input in the ring buffer so it can be replayed during reconciliation. */
  recordInput(input: InputRecord): void {
    this.buffer[input.tick % BUFFER_SIZE] = input;
  }

  /** Returns true while a visual lerp correction is in progress. */
  get isLerping(): boolean {
    return this._lerping;
  }

  /**
   * Advance the spring-based correction by `dtMs` of wall-clock time.
   * Call once per requestAnimationFrame BEFORE reading lerpOffset for
   * rendering. Pass the actual frame delta — the spring is frame-rate
   * independent so any cadence works.
   *
   * The lerp ends (sets isLerping = false) when both the position offset
   * and velocity fall below their respective thresholds. This is a
   * physically meaningful end condition rather than a fixed timer; on
   * very small initial drifts the lerp ends almost immediately, on
   * larger ones it takes proportionally longer to settle.
   */
  advanceLerp(dtMs: number): void {
    if (!this._lerping) {
      this.lerpOffset.x = 0;
      this.lerpOffset.y = 0;
      this.lerpAngleOffset = 0;
      return;
    }
    if (dtMs <= 0) return;
    springStep(this._springX, 0, this.lerpHalfLifeMs, dtMs);
    springStep(this._springY, 0, this.lerpHalfLifeMs, dtMs);
    springStep(this._springA, 0, this.lerpHalfLifeMs, dtMs);
    this.lerpOffset.x = this._springX.x;
    this.lerpOffset.y = this._springY.x;
    this.lerpAngleOffset = this._springA.x;

    const stillMoving =
      Math.abs(this._springX.x) > SPRING_POS_END ||
      Math.abs(this._springY.x) > SPRING_POS_END ||
      Math.abs(this._springA.x) > SPRING_ANGLE_END ||
      Math.abs(this._springX.v) > SPRING_VEL_END_MS ||
      Math.abs(this._springY.v) > SPRING_VEL_END_MS ||
      Math.abs(this._springA.v) > SPRING_ANGVEL_END_MS;
    if (!stillMoving) {
      this._lerping = false;
      this.lerpOffset.x = 0;
      this.lerpOffset.y = 0;
      this.lerpAngleOffset = 0;
      this._springX.x = 0; this._springX.v = 0;
      this._springY.x = 0; this._springY.v = 0;
      this._springA.x = 0; this._springA.v = 0;
    }
  }

  /**
   * Reconcile the prediction world against an authoritative server snapshot.
   *
   * @param serverState     Ship state the server had at `serverTick`.
   * @param serverTick      Server's physics tick when the snapshot was taken. Replay starts here.
   * @param currentTick     Client's current input tick counter.
   * @param ackedTick       Last client input tick the server received (used only for RTT estimation).
   * @param perReplayTick   Stage 3 hook — invoked once per replay tick after
   *                        the local input is applied and before
   *                        `world.tick(1/60)`. The orchestrator uses this to
   *                        apply remote-ship `lastInput` values from the
   *                        snapshot, advancing remote bodies in lockstep with
   *                        the local replay (forward-prediction).
   */
  reconcile(
    serverState: ShipPhysicsState,
    serverTick: number,
    currentTick: number,
    ackedTick: number,
    perReplayTick?: () => void,
  ): void {
    const before = this.world.getShipState(this.playerId);
    if (!before) return;

    // Estimate RTT from the buffered input the server last acked.
    const ackedRec = this.buffer[ackedTick % BUFFER_SIZE];
    if (ackedRec && ackedRec.tick === ackedTick) {
      this.lastRtt = this.clock.now() - ackedRec.sentAt;
    }

    // Roll back to server state and re-simulate forward by replaying every
    // CLIENT input the server has not yet acked (tick > ackedTick).
    //
    // The replay loop MUST iterate in client-tick space because the input ring
    // buffer is keyed by client inputTick. serverTick lives in a different
    // reference frame (absolute from server start) and cannot be used to index
    // the buffer — doing so replays the wrong inputs and produces severe
    // mis-prediction (the ship spins / moves opposite to key presses).
    //
    // serverTick is retained in the API only for RTT / drift telemetry.
    void serverTick;
    this.lastServerState.x = serverState.x;
    this.lastServerState.y = serverState.y;
    this.lastBeforePos.x = before.x;
    this.lastBeforePos.y = before.y;
    this.world.setShipState(this.playerId, serverState);

    // Cap the replay window to BUFFER_SIZE. Two real cases this protects:
    //  1. **Join**: the first snapshot after `welcome` reports `ackedTick=0`
    //     (worker has applied no inputs yet), while `currentTick` is already
    //     several thousand (`inputTick` was seeded from `welcome.serverTick`).
    //     Without the cap, the loop would call `world.tick(1/60)` thousands
    //     of times — a 1–3 s mobile hang and the dominant source of "join
    //     jitter" reported on 2026-05-06.
    //  2. **Long stalls**: a backgrounded tab or a slow snapshot path can
    //     leave us many ticks behind. Beyond BUFFER_SIZE the buffer doesn't
    //     have the records anyway, so replay would just spin world.tick
    //     without applying any input — pointless work.
    // When the cap engages we accept a one-time visual snap to server pose;
    // far better than a multi-second freeze.
    // Loop upper bound is EXCLUSIVE: this.inputTick (currentTick) is the NEXT
    // tick to be sent — the latest input already applied to predWorld was
    // recorded at tick (currentTick - 1). Using <= would replay one extra
    // tick and land predWorld one frame in the future, producing a per-
    // snapshot backward-lerp that manifests as visible jitter.
    const replayStart = Math.max(ackedTick + 1, currentTick - BUFFER_SIZE);
    for (let t = replayStart; t < currentTick; t++) {
      const rec = this.buffer[t % BUFFER_SIZE];
      if (rec && rec.tick === t) {
        this.world.applyInput(this.playerId, rec);
      }
      // Stage 3 — orchestrator's chance to apply remote-ship `lastInput`
      // before this tick advances. Bodies that don't receive input
      // integrate with damping only (pre-Stage-3 behaviour).
      if (perReplayTick) perReplayTick();
      this.world.tick(1 / 60);
    }

    const after = this.world.getShipState(this.playerId);
    if (!after) return;
    this.lastAfterPos.x = after.x;
    this.lastAfterPos.y = after.y;
    const drift = Math.hypot(after.x - before.x, after.y - before.y);
    const angleDrift = Math.abs(normalizeAngle(after.angle - before.angle));
    this.lastDrift = drift;
    this.lastAngleDrift = angleDrift;

    if (drift >= LERP_THRESHOLD || angleDrift >= ANGLE_LERP_THRESHOLD) {
      // Stage 1: queue spring-based correction. Initial offset is the
      // pre-reconciliation prediction error; the critically-damped spring
      // decays to zero with no overshoot at the half-life chosen for this
      // drift magnitude. Velocity is zeroed at the start so the spring's
      // first step is governed purely by the offset (no kick).
      this._springX.x = before.x - after.x;
      this._springX.v = 0;
      this._springY.x = before.y - after.y;
      this._springY.v = 0;
      this._springA.x = normalizeAngle(before.angle - after.angle);
      this._springA.v = 0;
      this.lerpOffset.x = this._springX.x;
      this.lerpOffset.y = this._springY.x;
      this.lerpAngleOffset = this._springA.x;
      this.lerpHalfLifeMs = playerCorrectionHalfLifeMs(drift);
      this._lerping = true;
    }
    // Prediction world now holds the corrected state.
  }
}

/** Wrap angle to [-π, π]. */
function normalizeAngle(a: number): number {
  const TWO_PI = 2 * Math.PI;
  let r = a % TWO_PI;
  if (r > Math.PI) r -= TWO_PI;
  if (r < -Math.PI) r += TWO_PI;
  return r;
}
