/**
 * Perf-capture pure helpers (plan: perf-floor, Phase 2). Aggregates
 * raw per-tick samples into the slim {median, p95, p99, sampleCount}
 * shape that ships to disk as `diag/perf-baseline/<scenario>-<arm>.json`
 * and feeds Phase 5's `perfBudget.ts` decision core.
 *
 * Pure module — zero IO, zero Playwright. The driver spec collects
 * samples, calls `aggregateSamples`, writes JSON.
 */

export interface PerSampleArm {
  /** ms since measure-window start when this sample was read. */
  tMs: number;
  /** PredictionStats fields read off `data-pred-stats`. */
  rafP50Ms: number;
  rafP99Ms: number;
  longtaskCount30s: number;
  rafGapCount30s: number;
  /** Chromium-only; undefined elsewhere. Tolerated by the budget. */
  heapUsedMb: number | undefined;
  rollingCorrRate: number;
  maxDriftUnits: number;
  meanDriftUnits: number;
  ticksAhead: number;
  /** Liveness signal. */
  snapshotCount: number;
  /** Liveness signal — true means the gate did NOT validly run. */
  diagEnabled: boolean;
}

export interface TickBudgetSample {
  /** Server-side `tick_budget` event payload, polled from /dev/events. */
  serverTick: number;
  /** Mean total tick ms over the event's ~60-tick window (`avgMs.total`). */
  total: number;
  /** Worst single tick in the window (`maxTotalMs`); falls back to `total`. */
  maxTotalMs?: number;
  overBudgetCount: number;
  sampleCount: number;
}

/**
 * Parse one server `tick_budget` event (`TickBudgetTelemetry.endTick`) into a
 * sample. Returns null for an event that isn't from a room with a live player
 * (`playerCount >= minPlayers`) — the /dev/events ring is GLOBAL, so without
 * this filter the ~21 eager galaxy rooms' idle ticks swamp the room under test.
 *
 * Regression (2026-10-31, plan soft-leaping-truffle PR-B): the spec used to
 * read a top-level `total` field the server never emits (the real shape is
 * `avgMs.total` + `maxTotalMs`), so EVERY sample was dropped and every
 * capture recorded `tickBudget.sampleCount: 0` silently.
 */
export function parseTickBudgetEvent(
  data: Record<string, unknown>,
  minPlayers = 1,
): TickBudgetSample | null {
  const serverTick = data['serverTick'];
  const sampleCount = data['sampleCount'];
  const overBudgetCount = data['overBudgetCount'];
  const playerCount = data['playerCount'];
  const avg = data['avgMs'] as Record<string, unknown> | undefined;
  const total = avg?.['total'];
  const maxTotalMs = data['maxTotalMs'];
  if (typeof serverTick !== 'number' || typeof sampleCount !== 'number') return null;
  if (typeof overBudgetCount !== 'number' || typeof total !== 'number') return null;
  if (typeof playerCount !== 'number' || playerCount < minPlayers) return null;
  return {
    serverTick,
    total,
    ...(typeof maxTotalMs === 'number' ? { maxTotalMs } : {}),
    overBudgetCount,
    sampleCount,
  };
}

/** Nearest-rank percentile over an UNSORTED list (copy-sorts). NaN if empty. */
export function framePercentile(deltas: readonly number[], q: number): number {
  if (deltas.length === 0) return Number.NaN;
  const sorted = [...deltas].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

export interface PerfAggregate {
  /** ISO timestamp the capture began. */
  capturedAt: string;
  scenario: string;
  /** 'desktop' | 'mobile-shaped' | 'device-ios' | 'device-android' */
  arm: string;
  /** Measure-window duration in ms. */
  durationMs: number;
  /** Number of per-tick samples in the window. */
  sampleCount: number;
  /** True if any sample had `diagEnabled` — invalidates the entire run. */
  diagEnabledAtCapture: boolean;
  /** Per-metric {median, p95, p99} over the measure window. */
  metrics: Record<string, { median: number; p95: number; p99: number; sampleCount: number }>;
  /** Server tick-budget summary aggregated from `/dev/events?tag=tick_budget`. */
  tickBudget: {
    sampleCount: number;
    totalAvgMs: number;
    totalMaxMs: number;
    /** Sum of overBudgetCount across samples / total sampleCount across samples. */
    overBudgetRatio: number;
  };
  /** Effective bot count / population (sol-prime-ambient only) read from /dev/population. */
  population?: {
    hunters: number;
    totalDrones: number;
  };
}

const NUMERIC_METRICS: Array<keyof PerSampleArm> = [
  'rafP50Ms',
  'rafP99Ms',
  'longtaskCount30s',
  'rafGapCount30s',
  'rollingCorrRate',
  'maxDriftUnits',
  'meanDriftUnits',
  'ticksAhead',
];

/**
 * Aggregate per-tick samples into the on-disk shape. Pure — `nowIso` is
 * a parameter so the test can pin it. NaN samples are dropped from the
 * per-metric arrays (some fields are NaN until the rolling window has
 * data — `rafP50Ms` for the first ~5 s of a session).
 */
export function aggregateSamples(args: {
  scenario: string;
  arm: string;
  durationMs: number;
  samples: readonly PerSampleArm[];
  tickBudgets: readonly TickBudgetSample[];
  capturedAt: string;
  population?: { hunters: number; totalDrones: number };
  heapStart?: number;
  heapEnd?: number;
}): PerfAggregate {
  const { scenario, arm, durationMs, samples, tickBudgets, capturedAt, population } = args;

  const metrics: PerfAggregate['metrics'] = {};
  for (const key of NUMERIC_METRICS) {
    const xs: number[] = [];
    for (const s of samples) {
      const v = s[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      xs.push(v);
    }
    metrics[key] = aggregateMetric(xs);
  }
  // Optional heap series — only meaningful on Chromium.
  const heapSeries: number[] = [];
  for (const s of samples) {
    if (typeof s.heapUsedMb === 'number' && Number.isFinite(s.heapUsedMb)) heapSeries.push(s.heapUsedMb);
  }
  if (heapSeries.length > 0) metrics['heapUsedMb'] = aggregateMetric(heapSeries);

  const diagEnabledAtCapture = samples.some((s) => s.diagEnabled);

  // Server-side tick budget. The events are emitted at ~1 Hz with
  // each carrying a windowed avg/max + the count of over-budget ticks
  // in the same window. We sum the counts and weight the averages.
  let totalAvgSum = 0;
  let totalAvgWeight = 0;
  let totalMax = 0;
  let overBudgetSum = 0;
  let tickSampleSum = 0;
  for (const tb of tickBudgets) {
    totalAvgSum += tb.total * tb.sampleCount;
    totalAvgWeight += tb.sampleCount;
    const tbMax = tb.maxTotalMs ?? tb.total;
    if (tbMax > totalMax) totalMax = tbMax;
    overBudgetSum += tb.overBudgetCount;
    tickSampleSum += tb.sampleCount;
  }
  const tickBudget = {
    sampleCount: tickBudgets.length,
    totalAvgMs: totalAvgWeight > 0 ? totalAvgSum / totalAvgWeight : 0,
    totalMaxMs: totalMax,
    overBudgetRatio: tickSampleSum > 0 ? overBudgetSum / tickSampleSum : 0,
  };

  return {
    capturedAt,
    scenario,
    arm,
    durationMs,
    sampleCount: samples.length,
    diagEnabledAtCapture,
    metrics,
    tickBudget,
    ...(population ? { population } : {}),
  };
}

function aggregateMetric(xs: number[]): { median: number; p95: number; p99: number; sampleCount: number } {
  if (xs.length === 0) return { median: Number.NaN, p95: Number.NaN, p99: Number.NaN, sampleCount: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    median: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    sampleCount: sorted.length,
  };
}

function nearestRank(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const qq = Math.max(0, Math.min(1, q));
  const rank = Math.ceil(qq * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]!;
}
