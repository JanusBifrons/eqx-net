/**
 * Real cadence of a take: how many DIFFERENT frames per second it shows.
 *
 * Bug 2026-11-10: the take QA said "60 fps" while the encoded clips showed
 * ~25 different frames a second in a 2/3-slot judder. The capture really was
 * 60 different frames a second; the encode lost them. ffmpeg's concat demuxer
 * opens each JPEG with the image demuxer's default 25 fps time base, so every
 * 16.7 ms frame duration rounded to 0 or 40 ms, frames piled onto the same
 * timestamps, and the `fps=60` filter kept one per 40 ms. `deliveredFps`
 * counts frames that ARRIVED, so it could not see this. These measures count
 * frames that differ, before (capture) and after (encode) the compositor.
 */

/** Frames that differ from the frame before them (the first frame counts). */
export function distinctRuns(keys: readonly string[]): number {
  let n = 0;
  for (let i = 0; i < keys.length; i++) if (i === 0 || keys[i] !== keys[i - 1]) n++;
  return n;
}

/** Longest run of identical consecutive frames (1 = no repeats). */
export function longestRepeat(keys: readonly string[]): number {
  let best = keys.length ? 1 : 0, run = 1;
  for (let i = 1; i < keys.length; i++) {
    run = keys[i] === keys[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/** Frames per second over a span, one decimal. */
export function perSecond(count: number, durationMs: number): number {
  return durationMs > 0 ? Math.round((count / (durationMs / 1000)) * 10) / 10 : 0;
}

/**
 * How many input frames survive an `fps=<outFps>` filter: one per distinct
 * output slot (the filter rounds each timestamp to the nearest slot and
 * keeps one frame per slot; the rest are dropped).
 */
export function slotsKept(ptsSec: readonly number[], outFps: number): number {
  const seen = new Set<number>();
  for (const p of ptsSec) seen.add(Math.round(p * outFps));
  return seen.size;
}

/**
 * Timestamps the concat demuxer gives a list of per-file durations when each
 * file is read at `demuxFps` (its time base 1/demuxFps): every duration is
 * rounded to whole ticks of that time base, then summed. A model of the
 * 2026-11-10 bug (demuxFps 25) and its fix (demuxFps = the output rate).
 */
export function concatPts(durationsSec: readonly number[], demuxFps: number): number[] {
  const pts: number[] = [];
  let ticks = 0;
  for (const d of durationsSec) {
    pts.push(ticks / demuxFps);
    ticks += Math.round(d * demuxFps);
  }
  return pts;
}

/** Frame-to-frame PSNR above this: the world did not move (HUD text alone
 *  barely moves PSNR). Below MOVING_DB: the scene moved. */
export const STILL_DB = 55;
export const MOVING_DB = 50;

export interface WorldStalls {
  /** Runs of >= 2 still frame pairs with a moving pair on each side. */
  stalls: number;
  /** Longest such run, in frame pairs. */
  longest: number;
  /** Frame pairs where the scene moved. */
  motionPairs: number;
}

/**
 * Where the WORLD froze mid-motion (2026-11-12). `psnr[i]` compares frame i
 * with frame i + 1 (Infinity = identical). Byte-level cadence can't see this:
 * HUD text changes while the world stands still (the long-guns zoom "chugs
 * like crazy" yet QA said 60 different frames/s). A still scene, still frames
 * at either end and single repeats are not stalls.
 */
export function worldStalls(psnr: readonly number[], minRun = 2): WorldStalls {
  const moving = (i: number): boolean => i >= 0 && i < psnr.length && psnr[i]! < MOVING_DB;
  /** At least `need` of the `n` pairs from `from` (stepping `dir`) moved. */
  const busy = (from: number, dir: 1 | -1): boolean => {
    let k = 0;
    for (let j = 0; j < STALL_CONTEXT; j++) if (moving(from + dir * j)) k++;
    return k >= STALL_CONTEXT_MOVING;
  };
  let stalls = 0, longest = 0, motionPairs = 0;
  for (let i = 0; i < psnr.length; i++) if (moving(i)) motionPairs++;
  for (let i = 0; i < psnr.length; ) {
    if (!(psnr[i]! > STILL_DB)) { i++; continue; }
    let j = i;
    while (j < psnr.length && psnr[j]! > STILL_DB) j++;
    const run = j - i;
    // A stall: a short freeze inside sustained motion. A long still stretch
    // is the scene at rest (a sparse scene, ships parked), not a stall.
    if (run >= minRun && run <= STALL_MAX_RUN && busy(i - 1, -1) && busy(j, 1)) {
      stalls++;
      if (run > longest) longest = run;
    }
    i = j;
  }
  return { stalls, longest, motionPairs };
}
/** Pairs on each side of a freeze that must be mostly moving for it to count. */
const STALL_CONTEXT = 5;
const STALL_CONTEXT_MOVING = 3;
/** Longer still runs are the scene at rest, not a stall. */
const STALL_MAX_RUN = 10;

/** QA verdict on world stalls (null = fine): more than one stall per two
 *  seconds of motion, or any freeze of 6+ frames (100 ms at 60 fps). */
export function stallProblem(s: WorldStalls, fps: number): string | null {
  const motionSec = s.motionPairs / fps;
  if (s.longest >= 6) return `the world froze for ${s.longest} frames mid-motion`;
  if (motionSec > 0 && s.stalls / motionSec > 0.5) return `${s.stalls} world stalls in ${motionSec.toFixed(1)} s of motion`;
  return null;
}

/** The QA verdict on a take's real cadence (null = fine). */
export function cadenceProblem(label: string, uniqueFps: number, minFps: number): string | null {
  return uniqueFps < minFps ? `${label} ${uniqueFps} different frames/s (need >= ${minFps})` : null;
}
