/**
 * Netcode-health budget — the pure decision core of the Phase-1 gate
 * (plan: e2e-rebuild). Zero IO, zero Playwright. This is the single
 * most flake-critical unit, so it is pure and exhaustively unit-locked
 * by `netHealthBudget.test.ts`.
 *
 * Verdict per metric:
 *
 *   FAIL(m) = relativeBreach(m) AND absoluteBreach(m)
 *
 *   relativeBreach(m) = head[m] >  baseline[m] * (1 + MARGIN[m]) + EPS[m]
 *   absoluteBreach(m) = head[m] >  CEIL[m]
 *
 * Why AND (the anti-flake core): the relative test catches a code
 * regression while same-session host load cancels (Mechanism 3 ran both
 * arms back-to-back on one box); the absolute "still-playable" ceiling
 * stops a lucky/unlucky baseline from false-failing — if HEAD is still
 * under the documented playable ceiling it is not a regression no matter
 * the ratio. EPS is an additive floor so a near-zero baseline cannot
 * make the multiplicative test infinitely sensitive. The relative test
 * is one-sided, so an improvement (head ≤ baseline) can never fail.
 *
 * Liveness preconditions are a SEPARATE channel: "the gate did not
 * validly run" (too few snapshots, or the heavy diagnostic path was on)
 * must never be reported as "healthy" — that false-confidence class is
 * exactly why this whole plan exists.
 *
 * Thresholds (re-verified this session against in-repo assertions /
 * system caps — hostile S4):
 *   - rollingCorrRate clean < 0.2  (tests/e2e/prediction-diagnostics.spec.ts:84)
 *   - maxDriftUnits   clean < 1.0u (prediction-diagnostics.spec.ts:76);
 *                     ~12u realistic / >50u catastrophic (:153-155)
 *   - ticksAhead  cap = 30         (src/client/net/lookaheadController.ts:40
 *                     CEILING_TICKS — the system's own prediction-window
 *                     saturation cap; the incident's ≈43 is past it)
 *   - droppedSnapshotsRecent window = last 10 (PredictionStats:134)
 *
 * `snapshotJitterMs` is PRINT-ONLY, NOT gated (demoted 2026-05-19 from
 * Step-5 data): the gate's proxy deliberately injects ±30 ms delivery
 * jitter, so this metric is dominated by the injected noise + host
 * scheduling, not a code property — baseline spanned 19.5–130.8 ms over
 * 4 reps on IDENTICAL code (6.7×). Same disqualifier the gate uses to
 * exclude `rtt*` ("proxy-dominated ⇒ tests the proxy, not the code").
 * The plan pre-authorised this data-driven demotion (acceptance step 3
 * / self-critique #1); regression power is unaffected — the code-side
 * acceptance trips on the drift/correction metrics, never jitter.
 */

/**
 * One arm's representative (median-across-reps — computed by the spec,
 * not here) netcode-health sample. Derived from `PredictionStats`:
 * `meanDriftUnits = totalDriftUnits / max(1, snapshotCount)`.
 */
export interface NetHealthArm {
  rollingCorrRate: number;
  ticksAhead: number;
  maxDriftUnits: number;
  meanDriftUnits: number;
  /** PRINT-ONLY — proxy-jitter-dominated, NOT gated (see header). Kept
   *  on the arm so the spec can log it for diagnosis. */
  snapshotJitterMs: number;
  droppedSnapshotsRecent: number;
  /** Liveness: snapshots actually flowed (≈ RUN_MS at 20 Hz, minus warmup). */
  snapshotCount: number;
  /** Liveness: the heavy diagnostic path was OFF for this arm (Mechanism 1). */
  diagEnabled: boolean;
}

export interface MetricBudget {
  /** Relative tolerance: head may exceed baseline by this fraction. */
  margin: number;
  /** Additive floor so a ~0 baseline can't make the ratio infinitely sensitive. */
  eps: number;
  /** Absolute "still-playable" ceiling; below it, a ratio breach is not a regression. */
  ceil: number;
}

export interface NetHealthFailure {
  metric: string;
  head: number;
  baseline: number;
  /** head / baseline (Infinity when baseline is 0 — diagnostic only). */
  ratio: number;
  margin: number;
  ceil: number;
  kind: 'relative+absolute';
}

export interface NetHealthVerdict {
  pass: boolean;
  /** Non-empty ⇒ the gate did NOT validly run; pass is false and this is
   *  reported distinctly from a metric regression. */
  preconditionFailures: string[];
  failures: NetHealthFailure[];
}

/**
 * The gated set. Adding/removing a metric is a deliberate, reviewed
 * change (locked by the unit test). Each ceiling is grounded above.
 */
export const NET_HEALTH_BUDGET = {
  rollingCorrRate: { margin: 0.5, eps: 0.05, ceil: 0.6 },
  ticksAhead: { margin: 0.4, eps: 3, ceil: 30 },
  maxDriftUnits: { margin: 0.5, eps: 0.5, ceil: 12.0 },
  meanDriftUnits: { margin: 0.4, eps: 0.2, ceil: 3.0 },
  // snapshotJitterMs DEMOTED to print-only (proxy-jitter-dominated — see
  // header). Re-adding it without solving the injected-jitter confound
  // is a deliberate, reviewed change.
  droppedSnapshotsRecent: { margin: 1.0, eps: 1, ceil: 4 },
} as const satisfies Record<string, MetricBudget>;

export type GatedMetric = keyof typeof NET_HEALTH_BUDGET;

/** ≈ RUN_MS (8 s) at 20 Hz minus warmup — a valid run sees far more. */
const MIN_SNAPSHOTS = 40;

/**
 * Decide whether HEAD's netcode health regressed vs the same-session
 * baseline. Pure: deterministic in its inputs, no IO.
 *
 * `budgetOverride` (multi-scenario netgate, plan: misty-teapot) lets a
 * scenario tune the relative/absolute margins of EXISTING gated metrics
 * without changing the gated SET (the set stays locked by the unit test).
 * A scenario with a heavier or lighter workload than `core` (e.g. a
 * structures-load or scrap-load room) may legitimately sit at a different
 * steady-state for a metric; the override merges over `NET_HEALTH_BUDGET`
 * per-metric. Absent ⇒ the default `core` budget (back-compatible — the
 * 2-arg call is unchanged).
 */
export function evaluateNetHealth(
  head: NetHealthArm,
  baseline: NetHealthArm,
  budgetOverride?: Partial<Record<GatedMetric, MetricBudget>>,
): NetHealthVerdict {
  const preconditionFailures: string[] = [];

  if (head.diagEnabled) {
    preconditionFailures.push(
      'HEAD ran with diag instrumentation ON (diagEnabled=true) — measured an instrumented build, not the player program',
    );
  }
  if (baseline.diagEnabled) {
    preconditionFailures.push(
      'baseline ran with diag instrumentation ON (diagEnabled=true) — measured an instrumented build, not the player program',
    );
  }
  if (!(head.snapshotCount > MIN_SNAPSHOTS)) {
    preconditionFailures.push(
      `HEAD snapshotCount ${head.snapshotCount} ≤ ${MIN_SNAPSHOTS} — the run did not validly exercise the live loop`,
    );
  }
  if (!(baseline.snapshotCount > MIN_SNAPSHOTS)) {
    preconditionFailures.push(
      `baseline snapshotCount ${baseline.snapshotCount} ≤ ${MIN_SNAPSHOTS} — the run did not validly exercise the live loop`,
    );
  }

  if (preconditionFailures.length > 0) {
    // Distinct channel — "did not validly run" must never read as "healthy".
    return { pass: false, preconditionFailures, failures: [] };
  }

  const failures: NetHealthFailure[] = [];
  for (const metric of Object.keys(NET_HEALTH_BUDGET) as GatedMetric[]) {
    const { margin, eps, ceil } = budgetOverride?.[metric] ?? NET_HEALTH_BUDGET[metric];
    const h = head[metric];
    const b = baseline[metric];
    const relativeBreach = h > b * (1 + margin) + eps;
    const absoluteBreach = h > ceil;
    if (relativeBreach && absoluteBreach) {
      failures.push({
        metric,
        head: h,
        baseline: b,
        ratio: b === 0 ? Infinity : h / b,
        margin,
        ceil,
        kind: 'relative+absolute',
      });
    }
  }

  return { pass: failures.length === 0, preconditionFailures: [], failures };
}
