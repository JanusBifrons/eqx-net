/**
 * Output shape of `captureHarness.replay()` — the per-RAF reconstructed
 * state the real `ColyseusGameClient` produced while driven through a
 * captured session. Consumed by user-contract assertions in
 * `userContracts.ts`.
 *
 * Plan: capture-driven replay infra Phase C (2026-05-21).
 */
import type { TimelineEvent } from './captureLoader';

/** Snapshot of the local ship's RENDERED pose at one RAF. The renderer
 *  reads `mirror.ships.get(localId)`; this captures that read. */
export interface RenderedPoseSample {
  /** Wall-clock ms at the RAF (from the capture's ts field via MockClock). */
  atMs: number;
  /** Client `inputTick` when this RAF completed. */
  inputTick: number;
  x: number;
  y: number;
  angle: number;
  /** lerpOffset applied on this frame (post-spring decay). For diagnostics. */
  lerpOffsetX: number;
  lerpOffsetY: number;
  lerpAngleOffset: number;
}

/** Snapshot of the local ship's PREDICTED pose (predWorld, pre-lerp) at one tick. */
export interface PredictedPoseSample {
  atMs: number;
  tick: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

/** A single capture-side `local_pose_rendered` event, paired with the
 *  replayed value at the same point in time, for ground-truth diff. */
export interface GroundTruthPair {
  atMs: number;
  capturedInputTick: number;
  captured: { x: number; y: number; angle: number };
  replayed: { x: number; y: number; angle: number };
  deltaX: number;
  deltaY: number;
  deltaAngle: number;
}

/** Input that the harness fed into the client (one entry per inner tick). */
export interface InputSample {
  atMs: number;
  tick: number;
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  boost: boolean;
  reverse: boolean;
  fireHeld: boolean;
}

/** Total trace produced by replaying a capture. */
export interface ReplayTrace {
  /** The capture this trace was generated from. */
  source: { path: string; playerId: string };
  /** All replayed rendered-pose samples in time order. */
  renderedPoses: RenderedPoseSample[];
  /** The ON-DEVICE `local_pose_rendered` events from the capture file
   *  (the EXACT poses the user actually saw on their screen). Use
   *  THIS — not `renderedPoses` — for assertions about user
   *  experience on long combat-style captures, because the harness's
   *  re-rendered stream drifts from on-device due to missing
   *  drone/projectile/collision state. Empty on pre-Phase-A captures
   *  that lack the tag.
   *  Plan: render-jitter-fix Phase 0a (2026-05-21). */
  capturedRenderedPoses: RenderedPoseSample[];
  /** All replayed predicted-pose samples in time order. */
  predictedPoses: PredictedPoseSample[];
  /** Every `room.send('input', ...)` call captured during replay. The
   *  user-contract assertion for "input flow maintained" measures this
   *  stream against held-input intent windows in the timeline. */
  inputSent: Array<{ atMs: number; tick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean }>;
  /** Input intents driven into the harness (captured ground truth). */
  inputs: InputSample[];
  /** Ground-truth pairs: for every RAF where the capture had a
   *  `local_pose_rendered` event, this pairs it with the same-frame
   *  replayed pose. This is THE Phase-E faithfulness signal. */
  groundTruth: GroundTruthPair[];
  /** Final client `stats` snapshot. Subset of `PredictionStats`. */
  finalStats: {
    snapshotCount: number;
    significantCorrectionCount: number;
    ticksAhead: number;
    maxDriftUnits: number;
    rollingCorrRate: number;
  };
  /** All events the harness saw, in case an assertion needs to look at
   *  inputs / snapshots / etc. for context. */
  events: TimelineEvent[];
}
