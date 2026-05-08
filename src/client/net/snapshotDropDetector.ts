/**
 * Stage 4 cycles 5 + 6 of the network-feel roadmap. Detects dropped
 * snapshots from the server-tick-delta stream and converts the recent
 * drop count into a swarm-interp delay bias.
 *
 * The server broadcasts a snapshot every 3 server ticks. Each snapshot's
 * `serverTick` is monotonic, so a tick-delta > 3 between consecutive
 * arrivals tells us how many snapshots the wire dropped. We don't try to
 * recover the dropped data — just acknowledge it and widen the swarm
 * interpolation window so the visual layer has more headroom to absorb
 * the resulting arrival jitter, instead of running out of bracketing
 * arrivals and freezing.
 *
 * Pure module — no I/O, no Reconciler dependency.
 */

/** Server snapshot cadence (ticks per snapshot). Pre-Stage-4 the
 *  broadcast loop sends every 3 main-thread ticks at 60 Hz physics. */
const SNAPSHOTS_PER_TICK_GAP = 3;

/** Default sliding-window size (number of snapshot arrivals over which
 *  drops are counted). 10 snapshots ≈ 500 ms — long enough to absorb a
 *  spike's wake without permanently inflating interp delay. */
const DEFAULT_WINDOW_SIZE = 10;

/** Cap the bias so a pathological run of drops doesn't push the interp
 *  buffer past the point of feeling laggy. */
const MAX_BIAS_MS = 200;

/** One physics tick at 60 Hz, in ms. */
const FIXED_MS = 1000 / 60;

export interface DropDetector {
  /** Most recent serverTick observed; -1 if none yet. */
  lastTick: number;
  /** Sliding window of per-snapshot drop counts (each entry is the
   *  number of dropped snapshots inferred from that arrival). */
  recent: number[];
  /** Sum of `recent` — kept in sync as entries are added/aged. */
  dropCount: number;
  windowSize: number;
}

export function createDropDetector(opts?: { windowSize?: number }): DropDetector {
  return {
    lastTick: -1,
    recent: [],
    dropCount: 0,
    windowSize: opts?.windowSize ?? DEFAULT_WINDOW_SIZE,
  };
}

/**
 * Record a snapshot's serverTick and update the drop count. Out-of-order
 * or duplicate ticks (rare; reordering / double-deliver) are silently
 * ignored — they're not "drops" in any meaningful sense.
 */
export function observeSnapshotTick(d: DropDetector, serverTick: number): void {
  if (d.lastTick < 0) {
    d.lastTick = serverTick;
    return;
  }
  if (serverTick <= d.lastTick) {
    // Duplicate or backwards — ignore.
    return;
  }
  const tickDelta = serverTick - d.lastTick;
  // Each missing 3-tick interval is one dropped snapshot.
  const dropsHere = Math.max(0, Math.floor((tickDelta - SNAPSHOTS_PER_TICK_GAP) / SNAPSHOTS_PER_TICK_GAP));
  d.recent.push(dropsHere);
  d.dropCount += dropsHere;
  if (d.recent.length > d.windowSize) {
    const aged = d.recent.shift()!;
    d.dropCount -= aged;
  }
  d.lastTick = serverTick;
}

/**
 * Convert a recent-window drop count into milliseconds of additional
 * interp-delay bias. One drop ≈ one physics frame of bias; capped at
 * `MAX_BIAS_MS` for pathological runs.
 */
export function computeInterpBiasMs(dropCount: number): number {
  const bias = dropCount * FIXED_MS;
  if (bias <= 0) return 0;
  if (bias > MAX_BIAS_MS) return MAX_BIAS_MS;
  return bias;
}
