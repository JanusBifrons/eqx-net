/**
 * Bench-budget decision core — the pure verdict module of `pnpm bench:check`
 * (plan: perf-floor, Phase 0). Zero IO, zero vitest. Mirrors the shape of
 * `tests/netgate/netHealthBudget.ts` (relative∧absolute AND-gate +
 * preconditionFailures distinct from metric regressions). Exhaustively
 * unit-locked by `benchmarks/benchBudget.test.ts`.
 *
 * Why AND: identical to the netgate's rationale. Same-session host load
 * is the dominant variance source for synthetic microbenches on a
 * developer box; the relative test cancels common-mode noise while the
 * absolute "still-fast-enough" ceiling stops a lucky/unlucky baseline
 * from false-failing.
 */

export interface BenchSample {
  /** Bench file path relative to the repo root (e.g. `benchmarks/spring.bench.ts`). */
  file: string;
  /** `describe()` group name. */
  group: string;
  /** `bench()` name. */
  name: string;
  /** Operations per second — the headline figure. Higher is better. */
  hz: number;
  /** Mean time per op in ms (vitest unit). */
  mean: number;
  /** 99th percentile time per op in ms. */
  p99: number;
  /** Number of samples collected. Below `MIN_SAMPLES` ⇒ precondition fail. */
  sampleCount: number;
}

export interface BenchBudget {
  /** Relative tolerance: head `hz` may dip below baseline by this fraction. */
  hzMargin: number;
  /** Additive floor on the hz absolute breach. */
  hzEps: number;
  /** Absolute floor: head hz below this is a regression regardless of ratio. */
  hzFloor: number;
}

export interface BenchFailure {
  key: string;
  metric: 'hz';
  head: number;
  baseline: number;
  /** baseline / head — slowdown ratio. 1.0 = unchanged. >1 = head is slower. */
  ratio: number;
  margin: number;
  floor: number;
  kind: 'relative+absolute';
}

export interface BenchVerdict {
  pass: boolean;
  /** Non-empty ⇒ the check did NOT validly run; pass is false and this is
   *  reported distinctly from a metric regression. */
  preconditionFailures: string[];
  failures: BenchFailure[];
}

/**
 * Default budget for every bench. Individual benches may be downgraded
 * to a wider margin via the per-key map below if their variance is
 * legitimately high (e.g., GC-pressure-sensitive enqueue benches).
 *
 * `hzMargin: 0.4` — head must drop more than 40 % vs baseline AND fall
 *   under `hzFloor` to fail. 40 % is the empirical "this is a real
 *   regression, not session noise" threshold from the e2e-rebuild
 *   netHealthBudget calibration.
 * `hzFloor: 1000` — any bench under 1000 ops/sec is by definition slow
 *   enough that further regression is unimportant absolute-wise; only
 *   the relative gate triggers below that.
 */
export const DEFAULT_BENCH_BUDGET: BenchBudget = {
  hzMargin: 0.4,
  hzEps: 100,
  hzFloor: 1000,
};

/**
 * Per-bench overrides. Only add an entry here when a captured baseline
 * confirms a bench is legitimately high-variance — never to silence a
 * flake (mirror the netgate's `snapshotJitterMs` demotion rule).
 *
 * Key format: `${file} > ${group} > ${name}` exact match.
 */
export const BENCH_BUDGET_OVERRIDES: Record<string, Partial<BenchBudget>> = {};

const MIN_SAMPLES = 100;

export function keyOf(s: BenchSample): string {
  return `${s.file} > ${s.group} > ${s.name}`;
}

export function resolveBudget(key: string): BenchBudget {
  const override = BENCH_BUDGET_OVERRIDES[key];
  if (!override) return DEFAULT_BENCH_BUDGET;
  return { ...DEFAULT_BENCH_BUDGET, ...override };
}

/**
 * Decide whether the current bench run regressed against baseline.
 * Pure: deterministic in its inputs, no IO.
 *
 * Liveness preconditions:
 *   - every baseline sample has `sampleCount >= MIN_SAMPLES`
 *   - every head sample has `sampleCount >= MIN_SAMPLES`
 *   - every baseline key exists in head (no silently-dropped benches)
 *
 * Metric verdict per matched pair (relative AND absolute):
 *   FAIL(hz) = (head.hz < baseline.hz / (1 + margin) - eps) AND
 *              (head.hz < floor)
 *
 * An improvement (head.hz >= baseline.hz) can never fail. New benches
 * (in head but not in baseline) are reported as preconditionFailures
 * (baseline must be regenerated).
 */
export function evaluateBench(
  head: readonly BenchSample[],
  baseline: readonly BenchSample[],
): BenchVerdict {
  const preconditionFailures: string[] = [];
  const failures: BenchFailure[] = [];

  const headMap = new Map<string, BenchSample>();
  for (const s of head) headMap.set(keyOf(s), s);
  const baseMap = new Map<string, BenchSample>();
  for (const s of baseline) baseMap.set(keyOf(s), s);

  for (const s of head) {
    if (s.sampleCount < MIN_SAMPLES) {
      preconditionFailures.push(
        `HEAD ${keyOf(s)} sampleCount=${s.sampleCount} below MIN_SAMPLES=${MIN_SAMPLES}`,
      );
    }
  }
  for (const s of baseline) {
    if (s.sampleCount < MIN_SAMPLES) {
      preconditionFailures.push(
        `baseline ${keyOf(s)} sampleCount=${s.sampleCount} below MIN_SAMPLES=${MIN_SAMPLES}`,
      );
    }
  }

  for (const [k] of baseMap) {
    if (!headMap.has(k)) {
      preconditionFailures.push(`baseline key missing from HEAD: ${k}`);
    }
  }
  for (const [k] of headMap) {
    if (!baseMap.has(k)) {
      preconditionFailures.push(`HEAD key missing from baseline: ${k} — regenerate baseline.json`);
    }
  }

  // Even if preconditions fail, we still evaluate matched pairs — the
  // user sees both signals; the verdict is `pass=false` either way.
  for (const [k, h] of headMap) {
    const b = baseMap.get(k);
    if (!b) continue;
    const budget = resolveBudget(k);
    if (h.hz >= b.hz) continue; // improvement — never fails

    const ratio = b.hz / h.hz; // >1.0 = head slower
    const relativeBreach = h.hz < b.hz / (1 + budget.hzMargin) - budget.hzEps;
    const absoluteBreach = h.hz < budget.hzFloor;

    if (relativeBreach && absoluteBreach) {
      failures.push({
        key: k,
        metric: 'hz',
        head: h.hz,
        baseline: b.hz,
        ratio,
        margin: budget.hzMargin,
        floor: budget.hzFloor,
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

/**
 * Normalise vitest's bench --outputJson shape into the slim BenchSample
 * array we commit + diff against. The vitest output is verbose (file +
 * group + benchmark trees with vitest-internal fields); we extract only
 * the load-bearing aggregates.
 */
export function normaliseVitestBench(report: unknown): BenchSample[] {
  const out: BenchSample[] = [];
  if (!isRecord(report)) return out;
  const files = report['files'];
  if (!Array.isArray(files)) return out;

  for (const file of files) {
    if (!isRecord(file)) continue;
    const filepath = typeof file['filepath'] === 'string'
      ? normaliseFilepath(file['filepath'])
      : '<unknown>';
    const groups = file['groups'];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const groupName = typeof group['fullName'] === 'string'
        ? extractGroupName(group['fullName'])
        : (typeof group['name'] === 'string' ? group['name'] : '<unknown>');
      const benchmarks = group['benchmarks'];
      if (!Array.isArray(benchmarks)) continue;
      for (const bn of benchmarks) {
        if (!isRecord(bn)) continue;
        const name = typeof bn['name'] === 'string' ? bn['name'] : '<unknown>';
        const hz = typeof bn['hz'] === 'number' ? bn['hz'] : Number.NaN;
        const mean = typeof bn['mean'] === 'number' ? bn['mean'] : Number.NaN;
        const p99 = typeof bn['p99'] === 'number' ? bn['p99'] : Number.NaN;
        const sampleCount = typeof bn['sampleCount'] === 'number' ? bn['sampleCount'] : 0;
        out.push({ file: filepath, group: groupName, name, hz, mean, p99, sampleCount });
      }
    }
  }
  return out;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function normaliseFilepath(raw: string): string {
  // vitest emits absolute paths; strip everything up to and including the
  // last "benchmarks/" segment for a stable repo-relative key. Falls back
  // to the raw path if the segment isn't found.
  const idx = raw.replace(/\\/g, '/').lastIndexOf('/benchmarks/');
  return idx >= 0 ? raw.slice(idx + 1).replace(/\\/g, '/') : raw;
}

function extractGroupName(fullName: string): string {
  // vitest's fullName is e.g.
  //   "benchmarks/spring.bench.ts > CritDampedSpring step cost"
  // The group itself is everything after the last " > ".
  const idx = fullName.lastIndexOf(' > ');
  return idx >= 0 ? fullName.slice(idx + 3) : fullName;
}
