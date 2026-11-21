/**
 * Per-snapshot perf-stats updates. Lifted out of `handleSnapshot` so
 * the handler's middle section reads as a single helper call rather
 * than 70 LOC of stat-mutation noise.
 *
 * What this owns:
 *   - The rolling RAF / longtask / heap stats reads from the diag
 *     ring (perf-floor Phase 1; cost ≈ tens of µs on desktop).
 *   - Snapshot interval + jitter computation (max-min of last 10).
 *   - Server tick rate EWMA → Zustand for the HUD chip.
 *   - The JSON snapshot drop detector (`droppedSnapshotsRecent`, read
 *     by netgate). It no longer sizes the drone display delay: that
 *     comes from the drone packet lateness estimate in
 *     `swarmInterpolation.ts` (netcode gap smoothing S3-3; see
 *     `docs/architecture/drone-snapshot-interpolation.md`).
 *   - Collision-event stale-guard tick — late collision events from
 *     the worker arriving with `tick < snapshot.serverTick` are
 *     dropped (the snapshot has already corrected predWorld).
 */

import type { SnapshotMessage } from '@shared-types/messages';
import { getRingEntries } from '../debug/ClientLogger';
import {
  computeRollingRafStats,
  countRecentTagOccurrences,
  readHeapUsedMb,
} from './perfStats';
import {
  observeSnapshotTick,
  type DropDetector,
} from './snapshotDropDetector';
import { useUIStore } from '../state/store';
import type { CollisionGuardState } from './applyCollisionResolved';
import type { PredictionStats } from './predictionStats';

/** Min wall ms between rolling ring scans (5 s / 30 s windows). */
export const ROLLING_STATS_INTERVAL_MS = 1000;

export interface SnapshotPerfStatsCtx {
  stats: PredictionStats;
  /** Persistent buffer of recent snapshot intervals (max 10). */
  recentIntervals: number[];
  collisionGuard: CollisionGuardState;
  dropDetector: DropDetector;
  /** EWMA of inter-arrival ms on the BINARY swarm channel — owned by
   *  the binary-swarm handler. No longer read here (S3-3: the drone
   *  display delay is sized from packet lateness in
   *  `swarmInterpolation.ts`); kept until the caller stops passing it. */
  swarmBinaryEwma: number;
}

/**
 * Updates `ctx.stats` for one snapshot. Returns the computed
 * intervalMs so the caller can feed it into RTT-band filtering /
 * Welford. Mutates `ctx.recentIntervals` in place (push + shift).
 *
 * Phase 4 iteration 3 swift-otter (2026-05-30) — `intervalMs` is now
 * computed from `wireArrivalAtMs`, the wire-recv time of the snapshot
 * (set by `logSnapshotRecvTelemetry` in `ColyseusClient`), not from
 * the RAF `now`. The snapshot coalescer + deferred-syncMirror both
 * make the APPLY cadence RAF-bound (~16-33 ms) regardless of WIRE
 * cadence (still ~50 ms at 20 Hz). The downstream RTT updater
 * (`rttLookaheadUpdater.ts`) drops samples outside the 35-75 ms
 * steady-state band — feeding it apply-bound intervals saturated
 * the rejection filter, starved the RTT Welford, and inflated
 * `leadTicks` (`ticksAhead` 30→74 in netgate). Using the wire time
 * keeps the interval signal honest to the actual network cadence.
 */
export function applySnapshotPerfStats(
  snap: SnapshotMessage,
  now: number,
  lastSnapshotAt: number,
  wireArrivalAtMs: number,
  ctx: SnapshotPerfStatsCtx,
): number {
  const intervalMs = lastSnapshotAt > 0 ? wireArrivalAtMs - lastSnapshotAt : 0;
  ctx.stats.snapshotCount++;
  ctx.stats.snapshotIntervalMs = intervalMs;
  ctx.stats.lastServerTick = snap.serverTick;

  // perf-floor Phase 1 — rolling RAF / longtask / heap stats. Reads
  // the existing `__eqxLogs` ring (no new producer, no new ring) at
  // the snapshot cadence, throttled to ROLLING_STATS_INTERVAL_MS: the
  // windows are 5 s / 30 s, so a 20 Hz O(ring) rescan bought nothing.
  const lastScan = ctx.stats.rollingStatsAtMs;
  if (lastScan === undefined || now - lastScan >= ROLLING_STATS_INTERVAL_MS) {
    ctx.stats.rollingStatsAtMs = now;
    const ring = getRingEntries();
    const rolling = computeRollingRafStats(ring, now, 5000);
    ctx.stats.rafP50Ms = rolling.rafP50Ms;
    ctx.stats.rafP99Ms = rolling.rafP99Ms;
    ctx.stats.longtaskCount30s = countRecentTagOccurrences(ring, 'longtask', now, 30_000);
    ctx.stats.rafGapCount30s = countRecentTagOccurrences(ring, 'raf_gap', now, 30_000);
    ctx.stats.heapUsedMb = readHeapUsedMb();
  }
  // Stage 2 — feed the collision-event stale-guard with the authoritative
  // snapshot tick. Late collision events (worker → main → wire latency)
  // arriving with tick < this value are dropped, since the snapshot has
  // already corrected predWorld with a state that would un-correct.
  ctx.collisionGuard.lastSnapshotServerTick = snap.serverTick;

  // Phase 6 — derive effective server wall-clock tick rate. Snapshot
  // broadcasts every 3 ticks, so tickHz = 3000 / intervalMs. EWMA-smoothed
  // so single-snapshot jitter doesn't make the chip flicker. The EWMA
  // lives on `stats`; the store gets the whole-Hz value the HUD shows,
  // so a steady server never re-notifies its subscribers.
  if (intervalMs > 0) {
    const instantHz = 3000 / intervalMs;
    const prev = ctx.stats.serverTickHzEwma ?? useUIStore.getState().serverTickHz;
    const smoothed = prev * 0.8 + instantHz * 0.2;
    ctx.stats.serverTickHzEwma = smoothed;
    useUIStore.getState().setServerTickHz(Math.round(smoothed));

    // JSON drop detector: feeds `droppedSnapshotsRecent` (netgate). The
    // drone display delay no longer reads it, nor the binary inter-arrival
    // EWMA: its target comes from the drone packet lateness estimate
    // (`swarmArrivalStampMs`, netcode gap smoothing S3-3).
    observeSnapshotTick(ctx.dropDetector, snap.serverTick);
  }

  // Rolling jitter: max − min of the last 10 snapshot intervals.
  if (intervalMs > 0) {
    ctx.recentIntervals.push(intervalMs);
    if (ctx.recentIntervals.length > 10) ctx.recentIntervals.shift();
  }
  ctx.stats.snapshotJitterMs = ctx.recentIntervals.length >= 2
    ? Math.max(...ctx.recentIntervals) - Math.min(...ctx.recentIntervals)
    : 0;

  return intervalMs;
}
