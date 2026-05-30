/**
 * GC-bench verdict module — paradigm plan (quirky-rabbit) Phase 7-A.
 *
 * Same AND-gate shape as `benchBudget.ts` (perf-floor Phase 0) and
 * `tests/netgate/netHealthBudget.ts` (e2e-rebuild Phase 1) — relative
 * margin AND absolute ceiling, both must breach to fail. Improvements
 * never fail.
 *
 * Why a separate budget from `benchBudget.ts`: bench:check measures
 * synthetic microbench throughput (hz); GC-bench measures server-side
 * GC pressure under a real-room workload — different metric, different
 * variance profile, different production failure mode.
 *
 * The metrics tracked here come from `GcMonitor.ts`'s `gc_pause`
 * server-event stream (already shipping). The runner script
 * (`scripts/run-gc-bench.ts`, separate from this verdict module) boots
 * a SectorRoom-like workload for a fixed window, scrapes the events,
 * and feeds the aggregate into `evaluateGcBench`. This module is pure
 * — zero IO, zero vitest — and unit-tested in `gcBenchBudget.test.ts`.
 *
 * What counts as a "major GC": only the MSC (mark-sweep-compact) kind.
 * Scavenge pauses are <1 ms and excluded server-side by the
 * `GC_PAUSE_THRESHOLD_MS = 5` floor in GcMonitor; this module assumes
 * the runner passes only the filtered stream through.
 */

/** Aggregate of one bench run, produced by the runner. */
export interface GcBenchSample {
  /** Workload identifier (e.g. `swarm-tidi-30s`). Same workload key
   *  must appear in baseline + head for the comparison to make sense. */
  readonly workload: string;
  /** Total wall-clock seconds the workload ran. Used to derive per-second
   *  rates that are workload-duration-independent in the verdict. */
  readonly durationSec: number;
  /** Count of major GCs (`kind === 'mark-sweep-compact'`) over the window. */
  readonly majorGcCount: number;
  /** Sum of durationMs across every major GC in the window. */
  readonly gcPauseTotalMs: number;
  /** Longest single MSC pause in the window. */
  readonly gcPauseMaxMs: number;
}

export interface GcBenchBudget {
  /** Relative tolerance on `majorGcCount/sec`. Head may exceed baseline
   *  by this fraction without failing. */
  readonly countMargin: number;
  /** Absolute ceiling on `majorGcCount/sec`. Head must exceed both
   *  baseline×(1+countMargin) AND this floor to fail. */
  readonly countAbsoluteFloor: number;
  /** Relative tolerance on `gcPauseTotalMs/sec`. */
  readonly totalMarginMs: number;
  /** Absolute ceiling on `gcPauseTotalMs/sec`. */
  readonly totalAbsoluteFloorMs: number;
  /** Relative tolerance on `gcPauseMaxMs` — single longest pause. */
  readonly maxMarginMs: number;
  /** Absolute ceiling on `gcPauseMaxMs`. */
  readonly maxAbsoluteFloorMs: number;
}

/**
 * Defaults are deliberately conservative — the gate should ONLY fire
 * on real regressions, not on session-load jitter. Pair-tightening
 * happens after the first set of stable baselines is captured (see the
 * netHealthBudget calibration history for the same dance).
 *
 *   - countMargin 0.5: 50 % more MSCs/sec is significant.
 *   - countAbsoluteFloor 1.0: only fail if we're seeing >1 MSC/sec.
 *   - totalMarginMs 0.5: 50 % more total pause time.
 *   - totalAbsoluteFloorMs 50: only fail if we're losing >50 ms/sec to GC.
 *   - maxMarginMs 0.5 / maxAbsoluteFloorMs 30: only fail on >30 ms pauses
 *     past baseline×1.5.
 */
export const DEFAULT_GC_BENCH_BUDGET: GcBenchBudget = {
  countMargin: 0.5,
  countAbsoluteFloor: 1.0,
  totalMarginMs: 0.5,
  totalAbsoluteFloorMs: 50,
  maxMarginMs: 0.5,
  maxAbsoluteFloorMs: 30,
};

export interface GcBenchFailure {
  readonly workload: string;
  readonly metric: 'majorGcCount' | 'gcPauseTotalMs' | 'gcPauseMaxMs';
  /** Per-second value of `head` for count/total; raw ms for max. */
  readonly headValue: number;
  /** Per-second value of `baseline`. */
  readonly baselineValue: number;
  /** head / baseline — values >1 mean regression. */
  readonly ratio: number;
}

export interface GcBenchVerdict {
  readonly pass: boolean;
  /** Liveness — distinct from regression. The check did not validly run. */
  readonly preconditionFailures: readonly string[];
  readonly failures: readonly GcBenchFailure[];
}

/** Minimum window the gate trusts. Below this the GC sample is too
 *  small to draw any conclusion from (a single jittery MSC dominates). */
const MIN_DURATION_SEC = 10;

function perSecond(value: number, durationSec: number): number {
  return durationSec > 0 ? value / durationSec : 0;
}

/**
 * Evaluate one head vs baseline workload pair against the budget. Pure;
 * no IO. Returns a verdict the runner script can print/exit on.
 *
 * Multi-workload runs call this once per workload key and union the
 * failures.
 */
export function evaluateGcBench(
  head: GcBenchSample,
  baseline: GcBenchSample,
  budget: GcBenchBudget = DEFAULT_GC_BENCH_BUDGET,
): GcBenchVerdict {
  const preconditionFailures: string[] = [];
  const failures: GcBenchFailure[] = [];

  if (head.workload !== baseline.workload) {
    preconditionFailures.push(
      `workload mismatch: head=${head.workload} baseline=${baseline.workload}`,
    );
  }
  if (head.durationSec < MIN_DURATION_SEC) {
    preconditionFailures.push(
      `head.durationSec=${head.durationSec} below MIN_DURATION_SEC=${MIN_DURATION_SEC}`,
    );
  }
  if (baseline.durationSec < MIN_DURATION_SEC) {
    preconditionFailures.push(
      `baseline.durationSec=${baseline.durationSec} below MIN_DURATION_SEC=${MIN_DURATION_SEC}`,
    );
  }

  // Even on precondition failure we still emit metric-failures so the
  // operator sees both signals; pass=false either way.
  const countHead = perSecond(head.majorGcCount, head.durationSec);
  const countBase = perSecond(baseline.majorGcCount, baseline.durationSec);
  if (countHead > countBase) {
    const ratio = countBase > 0 ? countHead / countBase : Number.POSITIVE_INFINITY;
    const relativeBreach = countHead > countBase * (1 + budget.countMargin);
    const absoluteBreach = countHead > budget.countAbsoluteFloor;
    if (relativeBreach && absoluteBreach) {
      failures.push({
        workload: head.workload,
        metric: 'majorGcCount',
        headValue: countHead,
        baselineValue: countBase,
        ratio,
      });
    }
  }

  const totalHead = perSecond(head.gcPauseTotalMs, head.durationSec);
  const totalBase = perSecond(baseline.gcPauseTotalMs, baseline.durationSec);
  if (totalHead > totalBase) {
    const ratio = totalBase > 0 ? totalHead / totalBase : Number.POSITIVE_INFINITY;
    const relativeBreach = totalHead > totalBase * (1 + budget.totalMarginMs);
    const absoluteBreach = totalHead > budget.totalAbsoluteFloorMs;
    if (relativeBreach && absoluteBreach) {
      failures.push({
        workload: head.workload,
        metric: 'gcPauseTotalMs',
        headValue: totalHead,
        baselineValue: totalBase,
        ratio,
      });
    }
  }

  // gcPauseMaxMs is a per-event metric, not a rate — compare directly.
  if (head.gcPauseMaxMs > baseline.gcPauseMaxMs) {
    const ratio = baseline.gcPauseMaxMs > 0
      ? head.gcPauseMaxMs / baseline.gcPauseMaxMs
      : Number.POSITIVE_INFINITY;
    const relativeBreach = head.gcPauseMaxMs > baseline.gcPauseMaxMs * (1 + budget.maxMarginMs);
    const absoluteBreach = head.gcPauseMaxMs > budget.maxAbsoluteFloorMs;
    if (relativeBreach && absoluteBreach) {
      failures.push({
        workload: head.workload,
        metric: 'gcPauseMaxMs',
        headValue: head.gcPauseMaxMs,
        baselineValue: baseline.gcPauseMaxMs,
        ratio,
      });
    }
  }

  return {
    pass: preconditionFailures.length === 0 && failures.length === 0,
    preconditionFailures,
    failures,
  };
}

/** Format the verdict for stdout. Pure (testable). */
export function formatGcBenchVerdict(verdict: GcBenchVerdict): string {
  const lines: string[] = [];
  lines.push(`=== gc-bench verdict ===`);
  lines.push(`  pass: ${verdict.pass}`);
  if (verdict.preconditionFailures.length > 0) {
    lines.push(`  precondition failures:`);
    for (const f of verdict.preconditionFailures) lines.push(`    - ${f}`);
  }
  if (verdict.failures.length > 0) {
    lines.push(`  metric failures:`);
    for (const f of verdict.failures) {
      lines.push(
        `    - ${f.workload} ${f.metric}: head=${f.headValue.toFixed(3)} ` +
        `baseline=${f.baselineValue.toFixed(3)} ratio=${f.ratio.toFixed(2)}`,
      );
    }
  }
  return lines.join('\n');
}
