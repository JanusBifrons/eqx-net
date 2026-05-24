/**
 * Rolling perf-stat helpers — pure, dependency-free, unit-testable.
 *
 * Plan: perf-floor, Phase 1. Adds RAF jitter / longtask / heap fields
 * to `PredictionStats` so the existing `data-pred-stats` DOM attribute
 * carries every signal the Phase-2 driver and Phase-5 lock need without
 * a new DOM surface or ring buffer.
 *
 * Input shape: the `LogEntry[]` ring exposed by `ClientLogger.ts` (the
 * same array `window.__eqxLogs` points at). Each entry has
 * `{ ts: number (performance.now() ms), tag: string, data: Record }`.
 *
 * Time semantics: every function takes `nowMs` (a `performance.now()`
 * sample taken at call time) and a `windowMs` so the caller can choose
 * the lookback window. We do NOT call `performance.now()` internally —
 * the caller owns the time source for testability.
 *
 * Performance: each helper is O(n) over the ring (≤ 8000 entries in
 * prod, ≤ 30000 in diag), called at the existing PredictionStats update
 * cadence (~20 Hz on snapshot arrival). The compute cost is dominated
 * by the ring traversal; one full pass per helper per snapshot ≈ tens
 * of microseconds on a desktop, sub-millisecond on mobile. The compute
 * is the trade we accept for adding the four fields; the alternative
 * (a separate ring or a separate observer) would cost more.
 */

export interface LogEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

/** Result of {@link computeRollingRafStats}. NaN if the window had no samples. */
export interface RollingRafStats {
  rafP50Ms: number;
  rafP99Ms: number;
  sampleCount: number;
}

/**
 * Compute p50 / p99 of `rafTick.elapsedMs` over the last `windowMs` of
 * the ring.
 *
 * The producer (`ColyseusClient.tickPhysics`) emits a `rafTick` event
 * roughly every 4th RAF + any frame with `deficitBefore >= 2`, so this
 * window is *under-sampled* — at 60 Hz we see ~15 samples/sec when
 * smooth, more when stuttering. That's OK for p50/p99 over a 5 s window
 * (~75 samples).
 *
 * Returns NaN p50/p99 when no rafTick samples lie in the window.
 */
export function computeRollingRafStats(
  entries: readonly LogEntry[],
  nowMs: number,
  windowMs: number,
): RollingRafStats {
  const cutoff = nowMs - windowMs;
  const samples: number[] = [];
  for (const e of entries) {
    if (e.tag !== 'rafTick') continue;
    if (e.ts < cutoff) continue;
    const elapsed = e.data['elapsedMs'];
    if (typeof elapsed !== 'number' || !Number.isFinite(elapsed)) continue;
    samples.push(elapsed);
  }
  if (samples.length === 0) {
    return { rafP50Ms: Number.NaN, rafP99Ms: Number.NaN, sampleCount: 0 };
  }
  samples.sort((a, b) => a - b);
  return {
    rafP50Ms: percentile(samples, 0.5),
    rafP99Ms: percentile(samples, 0.99),
    sampleCount: samples.length,
  };
}

/**
 * Count entries with the given tag whose timestamp falls in
 * `[nowMs - windowMs, nowMs]`. Used for `longtaskCount30s` and
 * `rafGapCount30s` — both producers (longtaskObserver + ColyseusClient's
 * raf-gap detector) emit one entry per qualifying event, so a raw count
 * IS the metric.
 */
export function countRecentTagOccurrences(
  entries: readonly LogEntry[],
  tag: string,
  nowMs: number,
  windowMs: number,
): number {
  const cutoff = nowMs - windowMs;
  let n = 0;
  for (const e of entries) {
    if (e.tag !== tag) continue;
    if (e.ts < cutoff) continue;
    n++;
  }
  return n;
}

/**
 * Read `performance.memory.usedJSHeapSize` and convert to MiB. Returns
 * `undefined` on browsers that don't expose `performance.memory` (Firefox
 * + Safari). The {@link PredictionStats} field is typed as
 * `number | undefined` so the budget treats undefined as a precondition
 * skip on those platforms.
 *
 * Note: `performance.memory` is a Chromium feature gated behind the
 * non-standard `--enable-precise-memory-info` flag for precise numbers,
 * but the default (quantised) value is still useful for trend detection.
 */
export function readHeapUsedMb(perf: Performance | undefined = globalThis.performance): number | undefined {
  if (!perf) return undefined;
  const mem = (perf as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  if (!mem || typeof mem.usedJSHeapSize !== 'number') return undefined;
  return mem.usedJSHeapSize / (1024 * 1024);
}

/**
 * Pure percentile helper. `samples` MUST be sorted ascending. `q` in
 * `[0, 1]`. Uses nearest-rank — the conservative choice for small samples
 * (a 75-sample p99 picks the 74th index, exactly the worst we observed).
 */
function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  // Clamp q ∈ [0, 1].
  const qq = Math.max(0, Math.min(1, q));
  const rank = Math.ceil(qq * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]!;
}
