/**
 * The production drone display-delay feed for the scenario harnesses
 * (netcode gap smoothing S5-7). Mirrors `ColyseusClient`:
 *   - every binary swarm packet updates the swarm inter-arrival EWMA
 *     (`nextSwarmBinaryEwmaMs`), as the binary-swarm handler does;
 *   - every applied JSON snapshot runs the REAL `applySnapshotPerfStats`,
 *     which sets the delay target (EWMA x 1.5 + drop bias, clamped) and
 *     notes the snapshot's tick as the drone stream newest stamp.
 * One feed per run; scalars only after construction.
 */
import { applySnapshotPerfStats, type SnapshotPerfStatsCtx } from '../../src/client/net/snapshotPerfStats.js';
import { createDropDetector } from '../../src/client/net/snapshotDropDetector.js';
import { nextSwarmBinaryEwmaMs } from '../../src/client/net/swarmInterpolation.js';
import type { PredictionStats } from '../../src/client/net/predictionStats.js';
import type { CollisionGuardState } from '../../src/client/net/applyCollisionResolved.js';
import type { SnapshotMessage } from '../../src/shared-types/messages.js';

export interface DisplayDelayFeed {
  /** A binary swarm packet arrived at `atMs` (wall ms). */
  swarmArrived(atMs: number): void;
  /** A JSON snapshot of `serverTick` was applied at `nowMs`; it arrived on
   *  the wire at `wireArrivalAtMs` (wall ms). */
  jsonApplied(serverTick: number, nowMs: number, wireArrivalAtMs: number): void;
}

export function createDisplayDelayFeed(): DisplayDelayFeed {
  const ctx: SnapshotPerfStatsCtx = {
    stats: { snapshotCount: 0, snapshotIntervalMs: 0, lastServerTick: 0 } as unknown as PredictionStats,
    recentIntervals: [],
    collisionGuard: { lastSnapshotServerTick: 0 } as unknown as CollisionGuardState,
    dropDetector: createDropDetector(),
    swarmBinaryEwma: 0,
  };
  const snap = { type: 'snapshot', serverTick: 0, states: {}, ackedTick: 0 } as unknown as SnapshotMessage;
  let swarmLastMs = -1;
  let lastSnapshotAt = 0;
  return {
    swarmArrived(atMs: number): void {
      if (swarmLastMs >= 0) ctx.swarmBinaryEwma = nextSwarmBinaryEwmaMs(ctx.swarmBinaryEwma, atMs - swarmLastMs, atMs);
      swarmLastMs = atMs;
    },
    jsonApplied(serverTick: number, nowMs: number, wireArrivalAtMs: number): void {
      snap.serverTick = serverTick;
      applySnapshotPerfStats(snap, nowMs, lastSnapshotAt, wireArrivalAtMs, ctx);
      lastSnapshotAt = wireArrivalAtMs;
    },
  };
}
