/**
 * Perf-scene verdict (plan prancy-squishing-donut P3): is head worse than base?
 *
 * Per metric, over the valid reps of each arm:
 *  - ratio = median(head) / median(base);
 *  - p = exact two-sided Mann-Whitney U (no normality assumption; small n);
 *  - RED only when ALL hold: ratio > 1 + rel, head − base > abs, and p < 0.05.
 *    The AND keeps noise (small absolute moves, unsure ranks) from failing a
 *    run, the same "relative AND absolute" rule as the netgate. Improvements
 *    never fail.
 *
 * A metric is only gated once a main-vs-main self-test shows its spread fits
 * inside its thresholds (see docs/architecture/perf-scenes.md).
 */
export interface RunMetrics {
  valid: boolean;
  invalidReason?: string;
  timing: Record<string, number>;
  counts: Record<string, number>;
  raw: unknown;
}

export interface Threshold { rel: number; abs: number }

/** Gated metrics and their thresholds. Anything else is printed only. */
export const THRESHOLDS: Record<string, Threshold> = {
  serverTickP95: { rel: 0.25, abs: 0.5 },
  serverTickP99: { rel: 0.30, abs: 1.0 },
  clientFrameP95: { rel: 0.15, abs: 2.0 },
  clientFrameP99: { rel: 0.25, abs: 4.0 },
  clientHitchesPerMin: { rel: 0.50, abs: 6 },
  renderP95: { rel: 0.25, abs: 0.5 },
  rxKBps: { rel: 0.10, abs: 5 },
  displayObjects: { rel: 0.10, abs: 50 },
};

export interface VerdictRow { metric: string; base: number; head: number; ratio: number; p: number; status: 'GREEN' | 'RED' | 'PRINT' }
export interface ArmVerdict { status: 'GREEN' | 'RED' | 'INVALID'; reason?: string; rows: VerdictRow[] }

export function median(xs: readonly number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return NaN;
  return n % 2 ? v[n >> 1]! : (v[n / 2 - 1]! + v[n / 2]!) / 2;
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

export function compareArms(base: readonly RunMetrics[], head: readonly RunMetrics[], minValid = 3): ArmVerdict {
  const vb = base.filter((m) => m.valid), vh = head.filter((m) => m.valid);
  if (vb.length < minValid || vh.length < minValid) {
    return { status: 'INVALID', reason: `valid runs base ${vb.length}, head ${vh.length} (need ${minValid} each)`, rows: [] };
  }
  const metrics = new Set<string>();
  for (const m of [...vb, ...vh]) { for (const k of Object.keys(m.timing)) metrics.add(k); for (const k of Object.keys(m.counts)) metrics.add(k); }
  const rows: VerdictRow[] = [];
  for (const metric of metrics) {
    const val = (m: RunMetrics): number => m.timing[metric] ?? m.counts[metric] ?? NaN;
    const a = vb.map(val).filter(Number.isFinite), b = vh.map(val).filter(Number.isFinite);
    if (a.length === 0 || b.length === 0) continue;
    const mb = median(a), mh = median(b);
    const ratio = mb > 0 ? mh / mb : (mh > 0 ? Infinity : 1);
    const p = mannWhitneyP(a, b);
    const t = THRESHOLDS[metric];
    const status: VerdictRow['status'] = !t ? 'PRINT' : (ratio > 1 + t.rel && mh - mb > t.abs && p < 0.05 ? 'RED' : 'GREEN');
    rows.push({ metric, base: r2(mb), head: r2(mh), ratio: r2(ratio), p: r2(p), status });
  }
  rows.sort((x, y) => (x.status === 'RED' ? -1 : 0) - (y.status === 'RED' ? -1 : 0) || x.metric.localeCompare(y.metric));
  return { status: rows.some((r) => r.status === 'RED') ? 'RED' : 'GREEN', rows };
}
