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
 *   4. If drift ≥ threshold, sets a visual offset (lerpOffset / lerpAngleOffset)
 *      that decays to zero over an adaptive number of render frames (scaled by
 *      correction magnitude so large collisions lerp smoothly instead of snapping).
 *
 * The prediction world itself always holds the most up-to-date authoritative
 * estimate; lerpOffset is a pure render-layer shim.
 */
import type { PhysicsWorld, ShipPhysicsState } from '../physics/World.js';

const BUFFER_SIZE = 128; // ~2 s at 60 Hz
// Lerp ANY correction above noise floor so there are no silent position snaps.
// Float32 serialisation noise ≈ 1e-5 u; 0.05 u is well above that.
const LERP_THRESHOLD = 0.05;       // world units for position
const ANGLE_LERP_THRESHOLD = 0.001; // radians (~0.057°) for rotation

/** Scale lerp duration to correction magnitude so large snaps don't look jerky.
 *  Stage 0 (network-feel roadmap): every drift above the sub-pixel tier caps
 *  at 6 frames / 100 ms. The previous 18-frame tier (300 ms for >20 u) was
 *  flagged in docs/FEEL_GOALS.md as a perceptible "glide" because the
 *  collision has already happened in the world; the slow visual settle is a
 *  lie. The ease-out shape (Reconciler.advanceLerp) carries the visual
 *  smoothness of the now-tighter window. */
function lerpFramesForDrift(drift: number): number {
  if (drift < 0.5) return 3;    //  50 ms — sub-pixel, barely visible
  return 6;                     // 100 ms — every other correction
}

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
  private lerpInitial = { x: 0, y: 0 };
  private lerpFramesLeft = 0;
  private lerpTotalFrames = 0;

  /** Visual angle offset applied to rendered rotation, decaying to zero. */
  lerpAngleOffset = 0;
  private lerpAngleInitial = 0;

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

  constructor(world: PhysicsWorld, playerId: string) {
    this.world = world;
    this.playerId = playerId;
    this.buffer = new Array<InputRecord | undefined>(BUFFER_SIZE).fill(undefined);
  }

  /** Store an outbound input in the ring buffer so it can be replayed during reconciliation. */
  recordInput(input: InputRecord): void {
    this.buffer[input.tick % BUFFER_SIZE] = input;
  }

  /** Returns true while a visual lerp correction is in progress. */
  get isLerping(): boolean {
    return this.lerpFramesLeft > 0;
  }

  /**
   * Advance the lerp by one render frame.
   * Call once per requestAnimationFrame, BEFORE reading lerpOffset for rendering.
   */
  advanceLerp(): void {
    if (this.lerpFramesLeft <= 0) {
      this.lerpOffset.x = 0;
      this.lerpOffset.y = 0;
      this.lerpAngleOffset = 0;
      return;
    }
    this.lerpFramesLeft--;
    if (this.lerpFramesLeft === 0) {
      this.lerpOffset.x = 0;
      this.lerpOffset.y = 0;
      this.lerpAngleOffset = 0;
    } else {
      // Stage 0: ease-out quadratic shape. The pre-Stage-0 linear `framesLeft
      // / totalFrames` shape decayed at a constant rate, which read as a
      // slow glide. Squaring biases the curve toward decisive early motion
      // and a graceful tail — same total duration, more responsive feel.
      const linearRatio = this.lerpTotalFrames > 0 ? this.lerpFramesLeft / this.lerpTotalFrames : 0;
      const ratio = linearRatio * linearRatio;
      this.lerpOffset.x = this.lerpInitial.x * ratio;
      this.lerpOffset.y = this.lerpInitial.y * ratio;
      this.lerpAngleOffset = this.lerpAngleInitial * ratio;
    }
  }

  /**
   * Reconcile the prediction world against an authoritative server snapshot.
   *
   * @param serverState  Ship state the server had at `serverTick`.
   * @param serverTick   Server's physics tick when the snapshot was taken. Replay starts here.
   * @param currentTick  Client's current input tick counter.
   * @param ackedTick    Last client input tick the server received (used only for RTT estimation).
   */
  reconcile(serverState: ShipPhysicsState, serverTick: number, currentTick: number, ackedTick: number): void {
    const before = this.world.getShipState(this.playerId);
    if (!before) return;

    // Estimate RTT from the buffered input the server last acked.
    const ackedRec = this.buffer[ackedTick % BUFFER_SIZE];
    if (ackedRec && ackedRec.tick === ackedTick) {
      this.lastRtt = performance.now() - ackedRec.sentAt;
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
      // Apply visual offsets equal to the pre-reconciliation error, then
      // decay them to zero over an adaptive number of frames to avoid a
      // visible snap. Large corrections get more frames so they appear smooth.
      this.lerpInitial.x = before.x - after.x;
      this.lerpInitial.y = before.y - after.y;
      this.lerpOffset.x = this.lerpInitial.x;
      this.lerpOffset.y = this.lerpInitial.y;
      this.lerpAngleInitial = normalizeAngle(before.angle - after.angle);
      this.lerpAngleOffset = this.lerpAngleInitial;
      const frames = lerpFramesForDrift(drift);
      this.lerpTotalFrames = frames;
      this.lerpFramesLeft = frames;
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
