/**
 * Mobile-perf budget — the pure decision core of the Playwright +
 * Android (or CPU-throttled-desktop fallback) heap/DOM/jitter gate.
 *
 * Verdict and precondition logic MIRRORS `tests/netgate/netHealthBudget.ts`
 * exactly:
 *
 *   FAIL(m) = relativeBreach(m) AND absoluteBreach(m)
 *
 *   relativeBreach(m) = head[m] >  baseline[m] * (1 + MARGIN[m]) + EPS[m]
 *   absoluteBreach(m) = head[m] >  CEIL[m]
 *
 * Why AND (the anti-flake core, repeated for the mobile-perf domain):
 *   - The relative test catches a real code regression while
 *     same-session host load cancels (both arms ran back-to-back on
 *     one box / one device).
 *   - The absolute "still-playable" ceiling stops a lucky/unlucky
 *     baseline from false-failing — if HEAD is still under the
 *     documented playable ceiling it is not a regression no matter
 *     the ratio.
 *   - EPS is an additive floor so a near-zero baseline cannot make
 *     the multiplicative test infinitely sensitive (e.g. a fresh
 *     run with 0 leaked DOM nodes vs HEAD's 2 nodes).
 *   - The relative test is one-sided, so improvement (head ≤
 *     baseline) can never fail.
 *
 * Liveness preconditions are a SEPARATE channel: "the gate did not
 * validly run" (cold-boot incomplete, diag instrumentation still on)
 * must never be reported as "healthy" — same anti-false-confidence
 * rule as the netgate.
 *
 * PRINT-ONLY metrics:
 *   - `rafP50Ms` / `rafP99Ms` / `rafGapCount30s` are tracked but NOT
 *     gated. Same disqualifier as `snapshotJitterMs` in netHealthBudget:
 *     CPU throttle x4 (fallback arm) deterministically inflates rafP99
 *     ~4×, and device thermal state dominates on real Android. Log for
 *     diagnosis, never gate.
 *
 * Single-arm variant: `evaluateMobilePerfAbsolute(head)` runs the
 * absolute-ceiling branch only — the v1 deliverable ships with one
 * arm and a known set of `ceil` budgets calibrated against fallback-
 * mode captures. Two-arm baseline-vs-HEAD is a v2 follow-up once the
 * baseline storage story is decided (same trajectory as the netgate's
 * Phase-1 single-arm absolute → Phase-2 two-arm relative evolution).
 *
 * Zero IO, zero Playwright. Unit-locked by `mobilePerfBudget.test.ts`.
 */

/**
 * One arm's representative (median-across-reps — computed by the spec,
 * not here) mobile-perf sample. Derived from CDP
 * (`Performance.getMetrics` + `HeapProfiler.collectGarbage`) and the
 * in-page `data-pred-stats` JSON readout.
 */
export interface MobilePerfArm {
  /** Post-GC heap in MiB. CDP `Performance.getMetrics.JSHeapUsedSize`
   *  after `HeapProfiler.collectGarbage`. */
  jsHeapUsedMb: number;
  /** Post-GC heap growth (post − pre, both post-GC) over the stress
   *  window. Primary leak detector. */
  jsHeapGrowthMb: number;
  /** CDP `Performance.getMetrics.Documents`. Catches detached
   *  subtrees / iframe leaks. */
  documentCount: number;
  /** CDP `Performance.getMetrics.JSEventListeners`. Catches forgotten
   *  `addEventListener` (the #1 React/Pixi leak class). */
  jsEventListeners: number;
  /** Count of `longtask` events (>50 ms) in the rolling 30 s window
   *  read off `data-pred-stats.longtaskCount30s`. UI thread blocking;
   *  longtask threshold is wall-clock 50 ms so survives CPU throttle. */
  longtaskCount30s: number;

  // PRINT-ONLY — proxy/throttle-dominated, NOT gated (see header).
  /** Rolling p50 of `rafTick.elapsedMs` over the last 5 s, off
   *  `data-pred-stats.rafP50Ms`. */
  rafP50Ms: number;
  /** Rolling p99 of `rafTick.elapsedMs` over the last 5 s, off
   *  `data-pred-stats.rafP99Ms`. */
  rafP99Ms: number;
  /** Count of `raf_gap` (RAF elapsed > 100 ms) in the rolling 30 s
   *  window off `data-pred-stats.rafGapCount30s`. */
  rafGapCount30s: number;

  // Liveness preconditions (mirror netHealthBudget shape verbatim):
  /** The heavy diagnostic path was OFF for this arm — same rule as
   *  the netgate (Mechanism 1, e2e-rebuild plan). */
  diagEnabled: boolean;
  /** Total snapshots received during the run — proves the live loop
   *  actually exercised. ≈ 20 Hz × RUN_S minus warmup. */
  snapshotCount: number;

  // Diagnostic tags (NOT preconditions — surfaced in the verdict log
  // for debugging, never gate pass/fail by themselves).
  /** Which connection mode the spec ran in. */
  ranKind: 'android' | 'desktop-throttled';
  /** Wall-clock measure window (ms). */
  measuredMs: number;
}

export interface MetricBudget {
  /** Relative tolerance: head may exceed baseline by this fraction. */
  margin: number;
  /** Additive floor so a ~0 baseline can't make the ratio infinitely sensitive. */
  eps: number;
  /** Absolute "still-playable" ceiling; below it, a ratio breach is not a regression. */
  ceil: number;
}

export interface MobilePerfFailure {
  metric: string;
  head: number;
  baseline: number;
  /** head / baseline (Infinity when baseline is 0 — diagnostic only). */
  ratio: number;
  margin: number;
  ceil: number;
  /** Verdict shape. Two-arm path emits 'relative+absolute' (both
   *  branches breached); single-arm path emits 'absolute' (only the
   *  ceiling can fail because baseline = head ⇒ relative trivially
   *  passes). */
  kind: 'relative+absolute' | 'absolute';
}

export interface MobilePerfVerdict {
  pass: boolean;
  /** Non-empty ⇒ the gate did NOT validly run; pass is false and this
   *  is reported distinctly from a metric regression. */
  preconditionFailures: string[];
  failures: MobilePerfFailure[];
}

/**
 * The gated set. Adding/removing a metric is a deliberate, reviewed
 * change (locked by the unit test).
 *
 * Ceilings rationale:
 *   - `jsHeapUsedMb` 220 — Pixel 4a-class tab survival threshold;
 *     generous `eps: 8` because Chromium buckets `JSHeapUsedSize` in
 *     ~1 MB increments and `HeapProfiler.collectGarbage` is only
 *     deterministic to ~ a few MB.
 *   - `jsHeapGrowthMb` 25 — primary leak detector; tight `eps: 2`
 *     because consistent growth across the stress phase IS the
 *     signal (not noise). A pure leak rate of even 100 KB/s over a
 *     30 s game-time stress window @ `testTimeScale=10` (= 3 s
 *     wall-clock) is ~300 KB — well below eps. The injected-leak
 *     regression-lock spec uses 100 KB/tick @ 60 RAF ticks over 3 s
 *     wall-clock ≈ 18 MB, which clears eps (2 MB) but stays below the
 *     `jsHeapUsedMb` ceiling (220 MB) so the failure is unambiguously
 *     a growth detection, not an absolute breach.
 *   - `documentCount` 4 — every detached iframe / Pixi off-screen
 *     canvas counts. 4 is comfortable headroom over the legitimate
 *     ~1–2 documents the game uses.
 *   - `jsEventListeners` 400 — empirical fallback-arm baseline is
 *     ~250 with the full HUD + drawer mounted. 400 leaves slack but
 *     trips on a 100+ listener leak (a real React unmount cleanup
 *     bug).
 *   - `longtaskCount30s` 30 — per `src/client/CLAUDE.md` mobile-perf
 *     section: `raf_gap > 100 ms` events should be vanishing-rare on
 *     a healthy main-thread render path; 30 in 30 s is a stuttering
 *     mess (1/s sustained).
 */
export const MOBILE_PERF_BUDGET = {
  jsHeapUsedMb: { margin: 0.3, eps: 8, ceil: 220 },
  jsHeapGrowthMb: { margin: 0.5, eps: 2, ceil: 25 },
  documentCount: { margin: 0.1, eps: 1, ceil: 4 },
  jsEventListeners: { margin: 0.25, eps: 5, ceil: 400 },
  longtaskCount30s: { margin: 0.5, eps: 3, ceil: 30 },
} as const satisfies Record<string, MetricBudget>;

type GatedMetric = keyof typeof MOBILE_PERF_BUDGET;

/** Mirror of netHealthBudget's MIN_SNAPSHOTS — at the canonical 20 Hz
 *  cadence a valid run sees far more than 40 snapshots in any
 *  reasonable measure window. */
export const MIN_SNAPSHOTS = 40;

function checkPreconditions(arm: MobilePerfArm, label: 'HEAD' | 'baseline'): string[] {
  const failures: string[] = [];
  if (arm.diagEnabled) {
    failures.push(
      `${label} ran with diag instrumentation ON (diagEnabled=true) — measured an instrumented build, not the player program`,
    );
  }
  if (!(arm.snapshotCount > MIN_SNAPSHOTS)) {
    failures.push(
      `${label} snapshotCount ${arm.snapshotCount} ≤ ${MIN_SNAPSHOTS} — the run did not validly exercise the live loop`,
    );
  }
  return failures;
}

/**
 * Two-arm baseline-vs-HEAD evaluation. Mirrors `evaluateNetHealth`
 * exactly — relative AND absolute breach required to fail.
 *
 * v2-ready: not used by the v1 single-arm spec, but ships with the
 * v1 budget core so the relative-branch unit tests can exercise it
 * before two-arm baseline storage is wired up.
 */
export function evaluateMobilePerf(
  head: MobilePerfArm,
  baseline: MobilePerfArm,
): MobilePerfVerdict {
  const preconditionFailures = [
    ...checkPreconditions(head, 'HEAD'),
    ...checkPreconditions(baseline, 'baseline'),
  ];

  if (preconditionFailures.length > 0) {
    return { pass: false, preconditionFailures, failures: [] };
  }

  const failures: MobilePerfFailure[] = [];
  for (const metric of Object.keys(MOBILE_PERF_BUDGET) as GatedMetric[]) {
    const { margin, eps, ceil } = MOBILE_PERF_BUDGET[metric];
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

/**
 * Single-arm absolute-ceiling-only evaluation. v1 deliverable.
 *
 * IMPORTANT: this does NOT replicate the AND-gate of the two-arm
 * verdict. With no baseline, the relative branch cannot apply —
 * `kind: 'absolute'` makes that explicit. The unit test covers
 * "absolute breach trips" and "no breach passes"; tests for the
 * relative branch live on `evaluateMobilePerf`.
 *
 * The `head.ranKind` discriminator is preserved on the verdict log
 * so the spec can confirm which connection mode was measured.
 */
export function evaluateMobilePerfAbsolute(head: MobilePerfArm): MobilePerfVerdict {
  const preconditionFailures = checkPreconditions(head, 'HEAD');
  if (preconditionFailures.length > 0) {
    return { pass: false, preconditionFailures, failures: [] };
  }

  const failures: MobilePerfFailure[] = [];
  for (const metric of Object.keys(MOBILE_PERF_BUDGET) as GatedMetric[]) {
    const { margin, ceil } = MOBILE_PERF_BUDGET[metric];
    const h = head[metric];
    if (h > ceil) {
      failures.push({
        metric,
        head: h,
        baseline: h,
        ratio: 1,
        margin,
        ceil,
        kind: 'absolute',
      });
    }
  }

  return { pass: failures.length === 0, preconditionFailures: [], failures };
}
