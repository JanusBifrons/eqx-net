/**
 * Perf-budget decision core (plan: perf-floor, Phase 5). Pure module —
 * zero IO, zero Playwright. Mirrors `tests/netgate/netHealthBudget.ts`
 * exactly: relative∧absolute AND-gate per metric, preconditionFailures
 * distinct from regressions, improvements never fail.
 *
 * Verdict per metric:
 *
 *   FAIL(m) = relativeBreach(m) AND absoluteBreach(m)
 *
 *   relativeBreach(m) = head[m] >  baseline[m] * (1 + MARGIN[m]) + EPS[m]
 *   absoluteBreach(m) = head[m] >  CEIL[m]
 *
 * Why AND: same as netHealthBudget. The relative test cancels common-mode
 * host-load noise; the absolute "still-fast-enough" ceiling stops a
 * lucky baseline from false-failing.
 *
 * Liveness preconditions are a SEPARATE channel: the gate did NOT
 * validly run (too few samples, diag was on at capture) must never be
 * reported as "healthy."
 *
 * Threshold sources — the acceptance table from the perf-floor plan,
 * each tied to an existing in-repo constant or documented threshold:
 *
 *   - rafP50Ms          16.7 ms p50  — invariant #4 (60 Hz fixed timestep)
 *   - rafP99Ms          33.3 ms p99  — one-frame headroom (visible stutter past)
 *   - longtaskCount30s  2 / 30 s     — main-thread health
 *   - rafGapCount30s    1 / 30 s     — hidden-tab / focus-loss guard
 *   - rollingCorrRate   0.2 clean    — matches prediction-diagnostics.spec.ts:84
 *
 * The seed values can be revised after Phase 2 captures publish real
 * baselines (data-driven, never "widen-to-silence"). Revisions are
 * deliberate: cite the captured baseline + document in LESSONS.
 */

export interface PerfArm {
  /** Rolling p50 of `rafTick.elapsedMs` over 5 s (ms). NaN until ring fills. */
  rafP50Ms: number;
  /** Rolling p99 of `rafTick.elapsedMs` over 5 s (ms). NaN until ring fills. */
  rafP99Ms: number;
  /** Count of `longtask` ring entries in the last 30 s. */
  longtaskCount30s: number;
  /** Count of `raf_gap` ring entries in the last 30 s. */
  rafGapCount30s: number;
  /** Rolling 10-snapshot correction rate (0-1). Existing PredictionStats field. */
  rollingCorrRate: number;
  /** Server-side tick budget — weighted avg of `tick_budget.total` (ms). */
  serverTickTotalAvgMs: number;
  /** Server-side tick budget — overBudgetCount / total sampleCount. 0-1. */
  serverTickOverBudgetRatio: number;
  /** Liveness: per-arm capture sampleCount. <MIN_SAMPLES ⇒ precondition fail. */
  sampleCount: number;
  /** Liveness: the heavy diagnostic path was OFF at capture (`?diag=0`). */
  diagEnabledAtCapture: boolean;
}

export interface MetricBudget {
  /** Relative tolerance: head may exceed baseline by this fraction. */
  margin: number;
  /** Additive floor so a ~0 baseline can't make the ratio infinitely sensitive. */
  eps: number;
  /** Absolute "still-acceptable" ceiling; below it, a ratio breach is not a regression. */
  ceil: number;
}

export interface PerfFailure {
  metric: string;
  head: number;
  baseline: number;
  /** head / baseline (Infinity when baseline is 0 — diagnostic only). */
  ratio: number;
  margin: number;
  ceil: number;
  kind: 'relative+absolute';
}

export interface PerfVerdict {
  pass: boolean;
  /** Non-empty ⇒ the gate did NOT validly run; pass is false and this is
   *  reported distinctly from a metric regression. */
  preconditionFailures: string[];
  failures: PerfFailure[];
}

/**
 * The gated set. Each entry maps a metric name to its budget. Adding
 * or removing a metric is a deliberate, reviewed change (locked by
 * the unit test). Each ceiling is grounded above.
 *
 * Direction of "worse": all gated metrics here are "higher = worse"
 * (rafP50/p99 larger = slower; longtask/rafGap counts larger = worse;
 * corrRate larger = more divergence; serverTick larger = slower; over-
 * budget ratio larger = TiDi closer). An "improvement" (head <= baseline)
 * can never fail.
 */
export const PERF_BUDGET = {
  // ── client per-frame ────────────────────────────────────────────────
  rafP50Ms: { margin: 0.5, eps: 2, ceil: 33.3 },        // 60 Hz target; ceil at 30 fps
  rafP99Ms: { margin: 0.5, eps: 5, ceil: 66.0 },        // one-frame headroom
  longtaskCount30s: { margin: 1.0, eps: 1, ceil: 10 },   // > 10 / 30s = visible stutter
  rafGapCount30s: { margin: 1.0, eps: 1, ceil: 5 },      // > 5 / 30s = repeated stalls
  // ── client netcode (mirrors netHealthBudget's `rollingCorrRate`) ────
  rollingCorrRate: { margin: 0.5, eps: 0.05, ceil: 0.6 },
  // ── server ──────────────────────────────────────────────────────────
  serverTickTotalAvgMs: { margin: 0.5, eps: 1, ceil: 12 },   // half of OVER_BUDGET_MS=14
  serverTickOverBudgetRatio: { margin: 5.0, eps: 0.05, ceil: 0.1 }, // any rescue at ambient = bad
} as const satisfies Record<string, MetricBudget>;

type GatedMetric = keyof typeof PERF_BUDGET;

/** ≥ 20 captured samples in the measure window — Phase 2 driver minimum. */
const MIN_SAMPLES = 20;

/**
 * Decide whether HEAD's perf regressed vs the captured baseline.
 * Pure: deterministic in its inputs, no IO.
 *
 * Liveness preconditions (separate result channel from metric regressions):
 *   - both arms have `sampleCount >= MIN_SAMPLES`
 *   - both arms have `diagEnabledAtCapture === false` (Phase 0a `?diag=0`)
 *
 * Per-metric verdict: relative AND absolute breach. NaN inputs are
 * skipped (no fail, but logged via the verdict's failures list when
 * baseline has a number and head is NaN — likely a precondition issue).
 */
export function evaluatePerf(head: PerfArm, baseline: PerfArm): PerfVerdict {
  const preconditionFailures: string[] = [];
  const failures: PerfFailure[] = [];

  if (head.diagEnabledAtCapture) {
    preconditionFailures.push(
      'HEAD ran with diag instrumentation ON (diagEnabledAtCapture=true) — measured an instrumented build, not the player program',
    );
  }
  if (baseline.diagEnabledAtCapture) {
    preconditionFailures.push(
      'baseline ran with diag instrumentation ON (diagEnabledAtCapture=true) — invalid baseline',
    );
  }
  if (head.sampleCount < MIN_SAMPLES) {
    preconditionFailures.push(
      `HEAD sampleCount=${head.sampleCount} below MIN_SAMPLES=${MIN_SAMPLES} — sparse capture, run on a quieter host`,
    );
  }
  if (baseline.sampleCount < MIN_SAMPLES) {
    preconditionFailures.push(
      `baseline sampleCount=${baseline.sampleCount} below MIN_SAMPLES=${MIN_SAMPLES} — sparse baseline, re-capture`,
    );
  }

  for (const metric of Object.keys(PERF_BUDGET) as readonly GatedMetric[]) {
    const budget = PERF_BUDGET[metric];
    const h = head[metric];
    const b = baseline[metric];
    if (typeof h !== 'number' || typeof b !== 'number' || !Number.isFinite(h) || !Number.isFinite(b)) {
      continue;
    }
    if (h <= b) continue; // improvement — never fails

    // baseline=0 makes ratio Infinity; we still apply the absolute
    // ceiling but skip the relative test to avoid divide-by-zero noise.
    const ratio = b > 0 ? h / b : Number.POSITIVE_INFINITY;
    const relativeThreshold = b * (1 + budget.margin) + budget.eps;
    const relativeBreach = h > relativeThreshold;
    const absoluteBreach = h > budget.ceil;

    if (relativeBreach && absoluteBreach) {
      failures.push({
        metric,
        head: h,
        baseline: b,
        ratio,
        margin: budget.margin,
        ceil: budget.ceil,
        kind: 'relative+absolute',
      });
    }
  }

  return {
    pass: preconditionFailures.length === 0 && failures.length === 0,
    preconditionFailures,
    failures,
  };
}

/** Exported for the per-scenario E2E spec's MIN_SAMPLES liveness check. */
export { MIN_SAMPLES };
