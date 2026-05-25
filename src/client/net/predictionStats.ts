/**
 * Public prediction/latency metrics surface. Extracted from the
 * monolithic `ColyseusClient.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 17/19 prep). Pure
 * type-only file — no runtime dependencies.
 *
 * Consumers (read-only):
 *   - `ColyseusClient.stats` (writer)
 *   - `tests/e2e/input-throttle-drift.spec.ts` (via the
 *     `data-pred-stats` DOM attribute / window mirror)
 *   - `tests/netgate/netHealthBudget.ts` (perf-floor netgate consumers)
 *
 * `ColyseusClient.ts` re-exports this type so existing imports continue
 * to resolve via `import type { PredictionStats } from
 * 'src/client/net/ColyseusClient'`.
 */

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
  /** perf-floor Phase 1 — rolling p50 of `rafTick.elapsedMs` over the
   *  last 5 s (ms). NaN until the ring has a sample. */
  rafP50Ms: number;
  /** perf-floor Phase 1 — rolling p99 of `rafTick.elapsedMs` over the
   *  last 5 s (ms). NaN until the ring has a sample. */
  rafP99Ms: number;
  /** perf-floor Phase 1 — count of `longtask` ring entries in the last
   *  30 s. >50 ms tasks via PerformanceObserver. Chromium / Edge / Safari
   *  18+ only; Firefox always 0 (no longtask entry type). */
  longtaskCount30s: number;
  /** perf-floor Phase 1 — count of `raf_gap` ring entries in the last
   *  30 s. A `raf_gap` is fired when a RAF elapsed > 100 ms (main-thread
   *  block / focus loss / hidden tab). */
  rafGapCount30s: number;
  /** perf-floor Phase 1 — `performance.memory.usedJSHeapSize` in MiB.
   *  Undefined on non-Chromium browsers (Firefox / Safari). */
  heapUsedMb: number | undefined;
}
