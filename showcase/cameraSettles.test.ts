import { describe, it, expect } from 'vitest';
import { SHOTS } from './registry.js';

// Review 2026-11-12 (capital-lineup): the pull-back to the whole fleet used
// smoothMs 9000 with 12 s of take left. The camera spring
// (render/camera/smoothDamp.ts, omega = 2 / smoothMs) had covered only ~3/4
// of the move when the take ended, so it closed mid-move with the hulls
// cropped and read as a zoom IN. Measured in a browser: zoom 0.18 at 10 s
// against a target of 0.066.
//
// A cue's move must be ~95 % done before the take ends. A critically damped
// spring leaves (1 + wt)e^-wt of the move; that is 5 % at wt ~ 4.74, i.e.
// after 2.37 x smoothMs.
const SETTLE_FACTOR = 2.37;

describe('scripted camera moves finish inside the take', () => {
  for (const shot of SHOTS) {
    for (const cue of shot.camera ?? []) {
      const smooth = cue.smoothMs ?? 0;
      if (smooth <= 0) continue;
      it(`${shot.id}: cue at ${cue.atMs} ms settles before ${shot.durationMs} ms`, () => {
        expect(cue.atMs + SETTLE_FACTOR * smooth).toBeLessThanOrEqual(shot.durationMs);
      });
    }
  }
});
