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

/** The QA verdict on a take's real cadence (null = fine). */
export function cadenceProblem(label: string, uniqueFps: number, minFps: number): string | null {
  return uniqueFps < minFps ? `${label} ${uniqueFps} different frames/s (need >= ${minFps})` : null;
}
