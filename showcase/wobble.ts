/**
 * Ship wobble gate for captured takes (review 2026-11-07: "Why does it take me
 * watching the video for you to notice?"). The frame-rate gate can't see a
 * ship that jumps back and forth while frames keep arriving on time, which is
 * what prediction corrections look like. This measures it on every take.
 *
 * `motion.mjs` tracks the local (green) ship and the star background frame to
 * frame. With the camera following the ship, the ship should sit still on
 * screen: what's left after a short moving average is jitter. Two numbers:
 * the 99th-percentile per-frame jump and the count of jumps over 3 px.
 * Calibrated on real takes: a good one 1.00 px / 1 jump, the visibly jittery
 * capital-guns-fighter take 2.87 px / 11 jumps.
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/** Flag a take whose 99th-percentile frame jump exceeds this (px)... */
export const WOBBLE_P99_MAX_PX = 1.6;
/** ...or that has at least this many jumps over SPIKE_PX. */
export const WOBBLE_MAX_SPIKES = 5;
export const SPIKE_PX = 3;

export interface Wobble {
  /** 99th-percentile per-frame jump of the ship on screen (px); NaN if not tracked. */
  p99Px: number;
  /** Frames where the ship jumped more than SPIKE_PX. */
  spikes: number;
  /** Time of the first spike (ms into the take), -1 when none. */
  firstSpikeMs: number;
  /** The tracker locked onto the local ship (else the score means nothing). */
  shipSeen: boolean;
}

function resid(a: number[], h = 3): number[] {
  return a.map((v, i) => {
    let s = 0, n = 0;
    for (let j = i - h; j <= i + h; j++) if (j >= 0 && j < a.length && Number.isFinite(a[j]!)) { s += a[j]!; n++; }
    return Number.isFinite(v) && n > 2 ? v - s / n : NaN;
  });
}

/** Score a motion CSV (f,t,dt,shipX,shipY,sdx,sdy,bgdx,bgdy,bgN,bgSpread,greenN). */
export function wobbleFromCsv(csv: string): Wobble {
  const rows = csv.trim().split('\n').slice(1).map((l) => l.split(',').map(Number));
  // motion.mjs writes greenN only when it (re)acquires the green ship; any
  // hit means it locked onto the local ship rather than the screen centre.
  const shipSeen = rows.some((r) => (r[11] ?? 0) > 0);
  if (rows.length < 30) return { p99Px: NaN, spikes: 0, firstSpikeMs: -1, shipSeen };
  const rx = resid(rows.map((r) => r[5]!));
  const ry = resid(rows.map((r) => r[6]!));
  const jump: number[] = [];
  let spikes = 0, firstSpikeMs = -1;
  for (let i = 0; i < rows.length; i++) {
    const j = Math.max(Math.abs(rx[i]!), Math.abs(ry[i]!));
    if (!Number.isFinite(j)) continue;
    jump.push(j);
    if (j > SPIKE_PX) { spikes++; if (firstSpikeMs < 0) firstSpikeMs = rows[i]![1]!; }
  }
  jump.sort((a, b) => a - b);
  const p99Px = jump.length ? jump[Math.floor(jump.length * 0.99)]! : NaN;
  return { p99Px, spikes, firstSpikeMs, shipSeen };
}

/** Measure a recorded take directory (frames/ + frames.json). */
export async function measureWobble(takeDir: string): Promise<Wobble> {
  const csvPath = path.join(takeDir, 'motion.csv');
  const script = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'motion.mjs');
  await new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, [script, takeDir, '0', '1e9', csvPath], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`motion.mjs exited ${code}`))));
  });
  try {
    return wobbleFromCsv(readFileSync(csvPath, 'utf8'));
  } finally {
    rmSync(csvPath, { force: true });
  }
}

/** One-line summary for the take log. */
export function wobbleSummary(w: Wobble): string {
  if (!w.shipSeen || !Number.isFinite(w.p99Px)) return 'ship wobble: no local ship in view';
  return `ship wobble p99 ${w.p99Px.toFixed(2)} px, ${w.spikes} jumps > ${SPIKE_PX} px`;
}

/** QA problem text for a take's wobble, or null when it passes / can't be scored. */
export function wobbleProblem(w: Wobble): string | null {
  if (!w.shipSeen || !Number.isFinite(w.p99Px)) return null;
  if (w.p99Px <= WOBBLE_P99_MAX_PX && w.spikes < WOBBLE_MAX_SPIKES) return null;
  const at = w.firstSpikeMs >= 0 ? ` from ${(w.firstSpikeMs / 1000).toFixed(0)} s` : '';
  return `ship jitter: p99 ${w.p99Px.toFixed(2)} px, ${w.spikes} jumps > ${SPIKE_PX} px${at}`;
}
