/**
 * Smoothness gate for captured takes.
 *
 * Frames are captured in real time, so any stall on the host becomes a visible
 * hitch in the video. The first gate (>= 20 fps, < 1.5 s freeze) let visibly
 * choppy clips through; this one encodes what "smooth" means at the output
 * frame rate. Measured with `showcase/bench-capture.ts`: at 1280x720 the game
 * holds 60 fps and CDP screencast delivers ~52-60, so 55 is reachable on a
 * quiet host; a take below it is re-taken (best-of-N in run-showcase).
 */
export const SMOOTH: Readonly<Record<number, { minFps: number; maxGapMs: number }>> = {
  60: { minFps: 55, maxGapMs: 100 },
  30: { minFps: 28, maxGapMs: 120 },
};

export interface TakeStats {
  frames: number;
  deliveredFps: number;
  gapMaxMs: number;
}

export function smoothnessProblems(take: TakeStats, fps: number): string[] {
  const gate = SMOOTH[fps];
  if (!gate) throw new Error(`no smoothness gate for ${fps} fps`);
  const problems: string[] = [];
  if (take.frames < 30) problems.push(`only ${take.frames} frames captured`);
  if (take.deliveredFps < gate.minFps) problems.push(`${take.deliveredFps} fps delivered (need >= ${gate.minFps})`);
  if (take.gapMaxMs > gate.maxGapMs) problems.push(`a ${take.gapMaxMs} ms hitch (max ${gate.maxGapMs})`);
  return problems;
}

/** Higher is smoother: frame rate, penalised by the worst hitch. */
export function smoothScore(take: TakeStats): number {
  return take.deliveredFps - take.gapMaxMs / 20;
}
