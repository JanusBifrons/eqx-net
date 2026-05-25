/**
 * Client-side prediction-state lifecycle surface. Owns `predWorld` +
 * `reconciler` + the RTT/clock-anchor cluster + the post-merge
 * `correctionSmoothing` + `inputTickRecovery` state. The core zone
 * declares the contract; the client zone supplies the concretion.
 *
 * Reset semantics are LOAD-BEARING (per LESSONS.md 2026-05-16 + merges
 * `d77a59f` + `51cac44`): `reset()` MUST clear `predWorld`, `reconciler`,
 * the RTT sampler, the correction-smoothing state, AND the
 * input-tick-recovery state atomically — otherwise transit arrival
 * accumulates drift via the un-reset surfaces.
 *
 * Today (pre-refactor) all of this lives inline in `ColyseusClient.ts`
 * across 11+ fields at `:505-588`. Commit 17 of the god-file refactor
 * extracts them into `PredictionStateManager.ts` implementing this
 * interface. See `src/client/net/colyseus/FIELD_OWNERSHIP.md` for the
 * full field-to-collaborator assignment table.
 *
 * Note: `_recentIntervals` and `_recentCorrFlags` are NOT prediction
 * state (they feed `stats.snapshotJitterMs` + correction-rate
 * diagnostics). They live in `ColyseusClientDiagnostics`, not here.
 */

export type PredictionResetReason =
  | 'transit_ready'
  | 'transit_arrival'
  | 'disconnect'
  | 'manual';

export interface PredictionSeed {
  /** Local-ship initial pose from the welcome snapshot. */
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly vx: number;
  readonly vy: number;
  /** Server tick anchor at welcome. */
  readonly serverTickAtWelcome: number;
  /** `performance.now()` at welcome (client clock anchor). */
  readonly welcomePerfNow: number;
}

/**
 * Opaque handles into the prediction substrate. Consumers (e.g.
 * `LingeringPredBodyManager`, `ClientPhysicsBridge`) read these through
 * the accessor methods rather than touching the implementation fields
 * directly.
 */
export interface ReconcilerHandle {
  readonly _opaqueReconciler: true;
}
export interface PredWorldHandle {
  readonly _opaquePredWorld: true;
}
export interface RttSamplerHandle {
  readonly _opaqueRttSampler: true;
}

export interface IPredictionState {
  /** Initialise the cluster from a welcome-snapshot seed. */
  bootstrap(seed: PredictionSeed): void;
  /** Reset every field in the cluster atomically (load-bearing). */
  reset(reason: PredictionResetReason): void;
  /** Access the Reconciler (consumers don't construct it). */
  getReconciler(): ReconcilerHandle | null;
  /** Access the predWorld (consumers don't construct it). */
  getPredWorld(): PredWorldHandle | null;
  /** Access the RTT sampler. */
  getRttSampler(): RttSamplerHandle | null;
}
