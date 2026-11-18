import type { SectorHistorySample } from '../../shared-types/galaxySnapshot';

/**
 * The sector info panel's control maths — pure. The sparkline geometry (one
 * point per sample, oldest left, height = the holder's share 0–100 %, a mark
 * wherever the holder changed hands), the "who is gaining" line and the
 * relative-time labels. Runs once per fetch / render, never per frame.
 */
export interface SparklineGeometry {
  /** SVG path `d` for the share line ('' with no samples). */
  path: string;
  /** x of every sample where the holder differs from the one before. */
  flips: number[];
  /** The latest holder (null = nobody), for the line colour. */
  holder: string | null;
  /** The latest point (for the "now" dot), or null with no samples. */
  last: { x: number; y: number } | null;
}

function shareOf(s: SectorHistorySample): number {
  return Math.max(0, Math.min(100, s.holder === null ? 0 : s.holderShare));
}

export function sparklinePath(samples: readonly SectorHistorySample[], width: number, height: number): SparklineGeometry {
  const n = samples.length;
  if (n === 0) return { path: '', flips: [], holder: null, last: null };
  const step = n > 1 ? width / (n - 1) : 0;
  const parts: string[] = [];
  const flips: number[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    x = n > 1 ? i * step : width / 2;
    y = height - (shareOf(s) / 100) * height;
    parts.push(`${i === 0 ? 'M' : 'L'}${round(x)},${round(y)}`);
    if (i > 0 && s.holder !== samples[i - 1]!.holder) flips.push(round(x));
  }
  // A lone sample is a short flat dash, not an invisible point.
  if (n === 1) parts.push(`L${round(width / 2 + 1)},${parts[0]!.split(',')[1]}`);
  return { path: parts.join(' '), flips, holder: samples[n - 1]!.holder, last: { x: round(x), y: round(y) } };
}

/** How many one-minute samples back the "gaining" line looks (10 min). */
export const TREND_WINDOW = 10;

export interface ControlTrend {
  /** Who is gaining: the current holder, the side against it, or nobody. */
  gainer: 'holder' | 'challenger' | 'steady';
  /** Size of the holder-share change, whole percent (≥ 0). */
  pct: number;
  /** Minutes the change spans (≤ TREND_WINDOW once the hour fills). */
  minutes: number;
}

/**
 * The holder's share change over the last `TREND_WINDOW` samples. A holder that
 * took the sector inside the window counts from 0 (it did not hold it then).
 * Null with fewer than two samples (no change to read yet).
 */
export function controlTrend(samples: readonly SectorHistorySample[]): ControlTrend | null {
  const n = samples.length;
  if (n < 2) return null;
  const last = samples[n - 1]!;
  const first = samples[Math.max(0, n - 1 - TREND_WINDOW)]!;
  const start = first.holder === last.holder ? shareOf(first) : 0;
  const delta = Math.round(shareOf(last) - start);
  const minutes = Math.max(1, Math.round((last.atMs - first.atMs) / 60_000));
  if (delta === 0) return { gainer: 'steady', pct: 0, minutes };
  return { gainer: delta > 0 ? 'holder' : 'challenger', pct: Math.abs(delta), minutes };
}

/** The full under-the-bar line: "Sol Dominion gaining · +8% in 10 min". */
export function trendLine(t: ControlTrend, holder: string, challenger: string | null): string {
  if (t.gainer === 'steady') return 'Steady';
  if (t.gainer === 'holder') return `${holder} gaining · +${t.pct}% in ${t.minutes} min`;
  if (challenger !== null) return `${challenger} gaining · +${t.pct}% in ${t.minutes} min`;
  return `${holder} losing · −${t.pct}% in ${t.minutes} min`;
}

/** The phone's short label beside CONTROL: "Sol +8% / 10 min". */
export function trendShort(t: ControlTrend, holder: string, challenger: string | null): string {
  if (t.gainer === 'steady') return 'Steady';
  if (t.gainer === 'holder') return `${firstWord(holder)} +${t.pct}% / ${t.minutes} min`;
  if (challenger !== null) return `${firstWord(challenger)} +${t.pct}% / ${t.minutes} min`;
  return `${firstWord(holder)} −${t.pct}% / ${t.minutes} min`;
}

/** "just now", "12 min ago", "3 h ago", "2 days ago" (negative ages read as now). */
export function agoLabel(ageMs: number): string {
  const min = Math.floor(Math.max(0, ageMs) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

function firstWord(name: string): string {
  return name.split(' ')[0] ?? name;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
