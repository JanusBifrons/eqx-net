/**
 * Client count gate (plan machine-independent-perf WS3): judge one count
 * reading against its budget. Pure, so the rules are unit-tested
 * (`countsGate.test.ts`) apart from the browser run (`run-counts.ts`).
 */
import type { ClientCountBudget } from '../src/shared-types/perf/perfBudgets.js';

/** What `run-counts.ts` reads from one scene × lighting window. */
export interface ClientCountReading {
  drawCallsP95: number;
  displayObjects: number;
  uploadTexels: number;
  atlasPages: number;
  /** Rendered frames the draw-call percentile came from. */
  frames: number;
}

/** Fewer rendered frames than this and the draw-call p95 means nothing. */
export const MIN_COUNT_FRAMES = 20;

/** Every broken budget, as a line each; empty = within budget. */
export function judgeCounts(r: ClientCountReading, b: ClientCountBudget): string[] {
  const out: string[] = [];
  if (r.frames < MIN_COUNT_FRAMES) out.push(`only ${r.frames} rendered frames (need ${MIN_COUNT_FRAMES}): the run is invalid`);
  const check = (name: keyof ClientCountReading & keyof ClientCountBudget, value: number): void => {
    const max = b[name];
    if (value > max) out.push(`${name} ${value} over the ${max} budget`);
  };
  check('drawCallsP95', r.drawCallsP95);
  check('displayObjects', r.displayObjects);
  check('uploadTexels', r.uploadTexels);
  check('atlasPages', r.atlasPages);
  return out;
}

/** A calibrated budget: max of the runs + 25 %, rounded up, never below `floor`. */
export function calibrate(values: readonly number[], floor = 1): number {
  const max = Math.max(...values);
  return Math.max(floor, Math.ceil(max * 1.25));
}
