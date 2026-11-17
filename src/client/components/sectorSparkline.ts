import type { SectorHistorySample } from '../../shared-types/galaxySnapshot';

/**
 * The sector info panel's control-history sparkline — the pure geometry. One
 * point per sample (oldest left), height = the holder's share (0–100 %), and
 * a mark wherever the holder changed hands. Runs once per fetch, never per
 * frame.
 */
export interface SparklineGeometry {
  /** SVG path `d` for the share line ('' with no samples). */
  path: string;
  /** x of every sample where the holder differs from the one before. */
  flips: number[];
  /** The latest holder (null = nobody), for the line colour. */
  holder: string | null;
}

export function sparklinePath(samples: readonly SectorHistorySample[], width: number, height: number): SparklineGeometry {
  const n = samples.length;
  if (n === 0) return { path: '', flips: [], holder: null };
  const step = n > 1 ? width / (n - 1) : 0;
  const parts: string[] = [];
  const flips: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    const x = n > 1 ? i * step : width / 2;
    const share = Math.max(0, Math.min(100, s.holder === null ? 0 : s.holderShare));
    const y = height - (share / 100) * height;
    parts.push(`${i === 0 ? 'M' : 'L'}${round(x)},${round(y)}`);
    if (i > 0 && s.holder !== samples[i - 1]!.holder) flips.push(round(x));
  }
  // A lone sample is a short flat dash, not an invisible point.
  if (n === 1) parts.push(`L${round(width / 2 + 1)},${parts[0]!.split(',')[1]}`);
  return { path: parts.join(' '), flips, holder: samples[n - 1]!.holder };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
