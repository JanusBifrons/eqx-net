/**
 * Rolling 30-second aggregator for browser longtask events + server GC
 * pause events (paradigm plan: quirky-rabbit, Phase 6).
 *
 * Two independent windows, both expressed as the same shape:
 *
 *   - `serverGc`: events fed via `recordServerGcPause(durationMs)` —
 *     the `ColyseusClient.gc_pause` message handler calls this.
 *   - `longtask`: events fed via `recordLongtask(durationMs)` — the
 *     existing `longtaskObserver` calls this from its `PerformanceObserver`
 *     callback (a no-op when the observer was never installed, e.g.
 *     under Firefox).
 *
 * Each window is a ring of (timestampMs, durationMs) entries with a
 * fixed capacity (`RING_SIZE`). On read (`getStats(nowMs)`) we walk
 * the ring and tally entries whose timestamp is within the 30 s
 * window — no per-write sweep, so writes are O(1).
 *
 * Ring size is bounded by the worst-case event rate × 30 s; we set it
 * deliberately generously (256 entries per window = ~8 events/sec
 * sustained, which is well above the worst-case GC + longtask rates we
 * expect). Overflow wraps in-place — the OLDEST entry is overwritten,
 * which matches the "rolling 30 s window" semantic.
 *
 * Output is published to the Zustand store via `setHealthStats` at
 * 1 Hz from `startHealthStatsPublisher()` — kept off the render path
 * so React rerenders happen at most 1×/sec for this metric. The
 * DevOverlay is the only consumer today.
 */

export interface HealthWindowStats {
  /** Number of events in the last 30 s. */
  count30s: number;
  /** Max event durationMs in the last 30 s. */
  maxMs30s: number;
}

export interface HealthStats {
  serverGc: HealthWindowStats;
  longtask: HealthWindowStats;
}

const RING_SIZE = 256;
const WINDOW_MS = 30_000;

interface Ring {
  timestamps: Float64Array;
  durations: Float64Array;
  /** Index of the next slot to overwrite. */
  head: number;
  /** Whether we've wrapped at least once; once true, every slot is
   *  populated. Before then, only `head` slots are valid. */
  wrapped: boolean;
}

function makeRing(): Ring {
  return {
    timestamps: new Float64Array(RING_SIZE),
    durations: new Float64Array(RING_SIZE),
    head: 0,
    wrapped: false,
  };
}

function record(ring: Ring, nowMs: number, durationMs: number): void {
  ring.timestamps[ring.head] = nowMs;
  ring.durations[ring.head] = durationMs;
  ring.head = (ring.head + 1) % RING_SIZE;
  if (ring.head === 0) ring.wrapped = true;
}

function stats(ring: Ring, nowMs: number): HealthWindowStats {
  const cutoff = nowMs - WINDOW_MS;
  let count = 0;
  let maxMs = 0;
  const len = ring.wrapped ? RING_SIZE : ring.head;
  for (let i = 0; i < len; i++) {
    const t = ring.timestamps[i]!;
    if (t < cutoff) continue;
    count++;
    const d = ring.durations[i]!;
    if (d > maxMs) maxMs = d;
  }
  return { count30s: count, maxMs30s: maxMs };
}

const serverGcRing = makeRing();
const longtaskRing = makeRing();

export function recordServerGcPause(durationMs: number, nowMs: number = Date.now()): void {
  record(serverGcRing, nowMs, durationMs);
}

export function recordLongtask(durationMs: number, nowMs: number = Date.now()): void {
  record(longtaskRing, nowMs, durationMs);
}

export function getHealthStats(nowMs: number = Date.now()): HealthStats {
  return {
    serverGc: stats(serverGcRing, nowMs),
    longtask: stats(longtaskRing, nowMs),
  };
}

/** Test-only: clear both rings. */
export function _resetHealthStatsForTests(): void {
  serverGcRing.head = 0; serverGcRing.wrapped = false;
  longtaskRing.head = 0; longtaskRing.wrapped = false;
  serverGcRing.timestamps.fill(0); serverGcRing.durations.fill(0);
  longtaskRing.timestamps.fill(0); longtaskRing.durations.fill(0);
}

/**
 * Start a 1 Hz interval that publishes the rolling stats to the
 * Zustand store. Returns a stop function so callers can clean up
 * (mostly for test isolation; the production caller never stops it).
 */
export function startHealthStatsPublisher(
  publish: (s: HealthStats) => void,
  intervalMs: number = 1000,
): () => void {
  const handle = setInterval(() => publish(getHealthStats()), intervalMs);
  return () => clearInterval(handle);
}
