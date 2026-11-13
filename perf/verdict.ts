/**
 * Perf-scene verdict (plan prancy-squishing-donut P3; three-way verdict and
 * noise floor: plan machine-independent-perf WS1): is head worse than base?
 *
 * Per metric, over the valid reps of each arm:
 *  - ratio = median(head) / median(base);
 *  - p = exact two-sided Mann-Whitney U (no normality assumption; small n);
 *  - RED only when ALL hold: ratio > 1 + rel, head − base > abs, p < 0.05,
 *    and (with an A/A noise floor) the ratio is beyond the same-code spread.
 *    The AND keeps noise (small absolute moves, unsure ranks) from failing a
 *    run, the same "relative AND absolute" rule as the netgate. Improvements
 *    never fail.
 *  - GREEN only when the move is under the thresholds AND the sample sizes
 *    could have reached p < 0.05 at all. Otherwise INCONCLUSIVE.
 *
 * Why the three-way verdict (2026-11-08): the exact two-sided test's smallest
 * possible p at 3 v 3 is 2/20 = 0.10, so a 3-rep A/B could never go RED and
 * its "GREEN" meant nothing. Every GPU-lighting decision (#344–#346) was one.
 *
 * A metric is only gated once a main-vs-main self-test shows its spread fits
 * inside its thresholds (see docs/architecture/perf-scenes.md).
 *
 * Print-only by decision (self-test 2026-11-06, 5 reps of identical code):
 * `clientFrameP99` is bimodal (one or two vsync refreshes, 16.8 or 33.3 ms)
 * and flipped between runs, so `clientHitchesPerMin` gates that signal.
 */
export interface RunMetrics {
  valid: boolean;
  invalidReason?: string;
  timing: Record<string, number>;
  counts: Record<string, number>;
  raw: unknown;
  /** Host-load samples around the run (perf runner; showcase/hostLoad.ts `LoadSample`). */
  load?: { before: unknown; after: unknown };
  /** Over-time samples (`perf:scenes --sample-ms`, a soak's curve). Print-only. */
  series?: unknown[];
}

export interface Threshold { rel: number; abs: number }

/** Gated metrics and their thresholds. Anything else is printed only. */
export const THRESHOLDS: Record<string, Threshold> = {
  serverTickP95: { rel: 0.25, abs: 0.5 },
  serverTickP99: { rel: 0.30, abs: 1.0 },
  clientFrameP95: { rel: 0.15, abs: 2.0 },
  clientHitchesPerMin: { rel: 0.50, abs: 6 },
  renderP95: { rel: 0.25, abs: 0.5 },
  rxKBps: { rel: 0.10, abs: 5 },
  displayObjects: { rel: 0.10, abs: 50 },
};

export type RowStatus = 'GREEN' | 'RED' | 'INCONCLUSIVE' | 'PRINT';
export interface VerdictRow {
  metric: string; base: number; head: number; ratio: number; p: number; status: RowStatus;
  /** Same-code spread from the A/A pair (`--noise-check`): max(A/A', A'/A) of the two base arms' medians. */
  noise?: number;
  /** Why a gated row is INCONCLUSIVE (e.g. "within host noise (×1.8)"). */
  note?: string;
}
export interface ArmVerdict { status: 'GREEN' | 'RED' | 'INCONCLUSIVE' | 'INVALID'; reason?: string; rows: VerdictRow[] }

/** The decision level. */
export const ALPHA = 0.05;

/** Reps per arm below which the exact test can never reject at {@link ALPHA}. */
export const MIN_DECISIVE_REPS = 4;

export function median(xs: readonly number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return NaN;
  return n % 2 ? v[n >> 1]! : (v[n / 2 - 1]! + v[n / 2]!) / 2;
}

/**
 * The smallest p the exact two-sided Mann-Whitney can return for these sample
 * sizes (no ties): the two fully separated orderings out of C(n1+n2, n1).
 * 3 v 3 → 2/20 = 0.10 (can NEVER reject at 0.05); 3 v 4 → 0.057; 4 v 4 → 0.029.
 */
export function minAchievableP(n1: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 1;
  const k = Math.min(n1, n2), n = n1 + n2;
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return Math.min(1, 2 / c);
}

/** Exact two-sided Mann-Whitney U p-value (ties get mid-ranks; enumerates
 *  every split, fine for the ≤ 10 reps an arm has). */
export function mannWhitneyP(a: readonly number[], b: readonly number[]): number {
  const n1 = a.length, n2 = b.length, n = n1 + n2;
  if (n1 === 0 || n2 === 0) return 1;
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array<number>(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && all[j + 1]!.v === all[i]!.v) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  let r1 = 0;
  for (let i = 0; i < n; i++) if (all[i]!.g === 0) r1 += ranks[i]!;
  const mean = (n1 * (n + 1)) / 2;
  const obs = Math.abs(r1 - mean);
  // Enumerate every choice of n1 ranks out of n.
  let total = 0, extreme = 0;
  const pick = (start: number, left: number, sum: number): void => {
    if (left === 0) { total++; if (Math.abs(sum - mean) >= obs - 1e-9) extreme++; return; }
    for (let i = start; i <= n - left; i++) pick(i + 1, left - 1, sum + ranks[i]!);
  };
  pick(0, n1, 0);
  return extreme / total;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

const valOf = (metric: string) => (m: RunMetrics): number => m.timing[metric] ?? m.counts[metric] ?? NaN;

function metricNames(runs: readonly RunMetrics[]): Set<string> {
  const out = new Set<string>();
  for (const m of runs) { for (const k of Object.keys(m.timing)) out.add(k); for (const k of Object.keys(m.counts)) out.add(k); }
  return out;
}

/**
 * Same-code spread per metric from an A/A pair: max(A/A', A'/A) of the two
 * base arms' medians. The same statistic the head-vs-base ratio uses, over the
 * same number of reps, so the two compare like with like.
 */
export function noiseFloor(base: readonly RunMetrics[], aa: readonly RunMetrics[]): Record<string, number> {
  const vb = base.filter((m) => m.valid), va = aa.filter((m) => m.valid);
  const out: Record<string, number> = {};
  if (vb.length === 0 || va.length === 0) return out;
  for (const metric of metricNames([...vb, ...va])) {
    const a = vb.map(valOf(metric)).filter(Number.isFinite), b = va.map(valOf(metric)).filter(Number.isFinite);
    if (a.length === 0 || b.length === 0) continue;
    const ma = median(a), mb = median(b);
    out[metric] = ma > 0 && mb > 0 ? Math.max(ma / mb, mb / ma) : (ma === mb ? 1 : Infinity);
  }
  return out;
}

export interface CompareOptions {
  /** Fewer valid runs than this in either arm ⇒ INVALID (default 3). */
  minValid?: number;
  /** A second base arm (same code, same params) run alongside: the A/A noise
   *  floor. A head-vs-base move no bigger than base-vs-A/A can't be RED. */
  noise?: readonly RunMetrics[];
}

/**
 * Three-way verdict per gated metric:
 *  - RED: over both thresholds, p < 0.05, and beyond the A/A noise floor;
 *  - GREEN: under the thresholds, with enough reps that p < 0.05 was reachable;
 *  - INCONCLUSIVE: too few reps to ever reject, over the thresholds but not
 *    significant, or over the thresholds but inside the host's own noise.
 * Overall: RED if any RED, else INCONCLUSIVE if any gated metric is, else GREEN.
 */
export function compareArms(base: readonly RunMetrics[], head: readonly RunMetrics[], opts: CompareOptions = {}): ArmVerdict {
  const minValid = opts.minValid ?? 3;
  const vb = base.filter((m) => m.valid), vh = head.filter((m) => m.valid);
  if (vb.length < minValid || vh.length < minValid) {
    return { status: 'INVALID', reason: `valid runs base ${vb.length}, head ${vh.length} (need ${minValid} each)`, rows: [] };
  }
  const noise = opts.noise ? noiseFloor(vb, opts.noise) : null;
  const rows: VerdictRow[] = [];
  for (const metric of metricNames([...vb, ...vh])) {
    const a = vb.map(valOf(metric)).filter(Number.isFinite), b = vh.map(valOf(metric)).filter(Number.isFinite);
    if (a.length === 0 || b.length === 0) continue;
    const mb = median(a), mh = median(b);
    const ratio = mb > 0 ? mh / mb : (mh > 0 ? Infinity : 1);
    const p = mannWhitneyP(a, b);
    const t = THRESHOLDS[metric];
    const nf = noise?.[metric];
    const row: VerdictRow = { metric, base: r2(mb), head: r2(mh), ratio: r2(ratio), p: r2(p), status: 'PRINT' };
    if (nf !== undefined) row.noise = r2(nf);
    if (t) {
      const minP = minAchievableP(a.length, b.length);
      const over = ratio > 1 + t.rel && mh - mb > t.abs;
      if (minP >= ALPHA) {
        row.status = 'INCONCLUSIVE';
        row.note = `${a.length} v ${b.length} reps can never reach p < ${ALPHA} (min p ${r2(minP)})`;
      } else if (!over) {
        row.status = 'GREEN';
      } else if (nf !== undefined && ratio <= nf) {
        row.status = 'INCONCLUSIVE';
        row.note = `within host noise (×${r2(nf)})`;
      } else if (p < ALPHA) {
        row.status = 'RED';
      } else {
        row.status = 'INCONCLUSIVE';
        row.note = `over threshold but p ${r2(p)} ≥ ${ALPHA}`;
      }
    }
    rows.push(row);
  }
  const rank: Record<RowStatus, number> = { RED: 0, INCONCLUSIVE: 1, GREEN: 2, PRINT: 3 };
  rows.sort((x, y) => rank[x.status] - rank[y.status] || x.metric.localeCompare(y.metric));
  const status: ArmVerdict['status'] = rows.some((r) => r.status === 'RED') ? 'RED'
    : rows.some((r) => r.status === 'INCONCLUSIVE') ? 'INCONCLUSIVE' : 'GREEN';
  const v: ArmVerdict = { status, rows };
  if (status === 'INCONCLUSIVE') v.reason = rows.filter((r) => r.status === 'INCONCLUSIVE').map((r) => `${r.metric}: ${r.note}`).join('; ');
  return v;
}
