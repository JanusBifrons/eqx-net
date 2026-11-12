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

/**
 * Server pace gate (2026-11-07). When the host can't give the server its CPU,
 * the physics worker drops time rather than replaying it, so the server runs
 * slower than wall-clock while the client keeps wall-clock time: the client's
 * lead swings and every swing is a correction (measured: 25 Hz on this laptop
 * with two browsers + Vite; 60.0 Hz alone, zero corrections in steady flight).
 * A take recorded on a starved server shows that jitter, so it is retaken.
 */
export const SERVER_HZ_MIN = 57;

export interface NetHealth { serverHz: number; serverGameHz?: number; corrections: number; snapshots: number }

export function netSummary(n: NetHealth | null): string {
  if (!n) return 'net: no local pilot';
  const game = n.serverGameHz !== undefined && Math.abs(n.serverGameHz - n.serverHz) > 1 ? ` (${n.serverGameHz} per game s)` : '';
  return `server ${n.serverHz} Hz${game}, ${n.corrections}/${n.snapshots} snapshots corrected`;
}

export function netProblem(n: NetHealth | null): string | null {
  if (!n) return null;
  // Game time scale: a 0.5× sector runs 30 ticks a WALL second by design, so
  // gate on ticks per GAME second when the client reports it.
  const hz = n.serverGameHz ?? n.serverHz;
  if (hz < SERVER_HZ_MIN) return `server behind: ${hz} Hz${n.serverGameHz !== undefined ? ' per game s' : ''} (min ${SERVER_HZ_MIN})`;
  return null;
}

/**
 * Game-side smoothness gate (2026-11-07), from the per-frame `pose-trace.json`
 * the recorder writes (rows [t, meX, meY, meA, bigX, bigY, bigA, lerpX, lerpY,
 * inputTick, frameTimeMs, tickDueMs, physX, physY, physVx, physVy]). The video
 * gates can't see a correction: the camera follows the ship, so a correction
 * moves the WORLD. This reads what the game itself did:
 *  - correction onsets: frames where the prediction's lerp offset jumps up;
 *  - one-tick jumps: frames whose physics state moved a whole tick more or
 *    less than the ticks that ran (the 2026-11-07 ack bug's signature).
 */
export const POSE_MAX_CORRECTIONS = 2;
const ONSET_U = 0.3;

export interface PoseHealth { frames: number; corrections: number; tickJumps: number; firstAtMs: number }

export function poseHealth(rows: number[][]): PoseHealth | null {
  if (rows.length < 30) return null;
  const t0 = rows[0]![10]!;
  let corrections = 0, tickJumps = 0, firstAtMs = -1;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!, b = rows[i]!;
    const la = Math.hypot(a[7]!, a[8]!), lb = Math.hypot(b[7]!, b[8]!);
    let bad = false;
    if (lb > ONSET_U && lb > la + ONSET_U) { corrections++; bad = true; }
    const ticks = b[9]! - a[9]!;
    const one = Math.hypot(b[14]!, b[15]!) / 60;
    // Only a STEADY speed can show a tick mislabel: a warp's engage / drop
    // (or a collision) changes the speed itself in one tick, legitimately.
    const prevOne = Math.hypot(a[14]!, a[15]!) / 60;
    const steady = Math.abs(one - prevOne) <= 0.25 * Math.max(one, prevOne);
    const moved = Math.hypot(b[12]! - a[12]!, b[13]! - a[13]!);
    if (steady && one > 0.5 && ticks >= 0 && ticks <= 3 && Math.abs(moved - ticks * one) > 0.6 * one) { tickJumps++; bad = true; }
    if (bad && firstAtMs < 0) firstAtMs = b[10]! - t0;
  }
  return { frames: rows.length, corrections, tickJumps, firstAtMs };
}

export function poseSummary(p: PoseHealth | null): string {
  return p ? `pose: ${p.corrections} corrections, ${p.tickJumps} tick jumps` : 'pose: not traced';
}

export function poseProblem(p: PoseHealth | null): string | null {
  if (!p) return null;
  if (p.tickJumps === 0 && p.corrections <= POSE_MAX_CORRECTIONS) return null;
  const at = p.firstAtMs >= 0 ? ` from ${(p.firstAtMs / 1000).toFixed(1)} s` : '';
  return `prediction corrections: ${p.corrections} (max ${POSE_MAX_CORRECTIONS}), ${p.tickJumps} tick jumps${at}`;
}
