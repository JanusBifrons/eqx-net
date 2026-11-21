/**
 * Unit tests for the drawn-motion counters in `./assertions.ts`
 * (netcode gap smoothing plan, section 9.1). Hand-built tracks on a
 * simulated 60 Hz frame clock; no wall-clock time.
 */
import { describe, it, expect } from 'vitest';
import { countMotionArtefacts, type MotionFrame } from './assertions.js';

const FRAME_MS = 1000 / 60;
const SPEED_U_PER_S = 300; // 5 u per frame
const FRAME_COUNT = 180;

function trueX(atMs: number): number {
  return (SPEED_U_PER_S * atMs) / 1000;
}

/** Straight eastward track; `drawnAt(i, atMs)` returns the drawn x for frame i. */
function straightTrack(drawnAt: (i: number, atMs: number) => number): MotionFrame[] {
  const frames: MotionFrame[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const atMs = i * FRAME_MS;
    frames.push({ atMs, drawnX: drawnAt(i, atMs), drawnY: 0, trueX: trueX(atMs), trueY: 0 });
  }
  return frames;
}

describe('countMotionArtefacts', () => {
  it('clean straight track gives all zeros', () => {
    const c = countMotionArtefacts(straightTrack((_i, atMs) => trueX(atMs)));
    expect(c.snaps).toBe(0);
    expect(c.largestSnapU).toBe(0);
    expect(c.totalSnapU).toBe(0);
    expect(c.freezeFrames).toBe(0);
    expect(c.backwardSteps).toBe(0);
    expect(c.meanLatenessMs).toBeCloseTo(0, 6);
    expect(c.maxLatenessMs).toBeCloseTo(0, 6);
  });

  it('clean curved track gives all zeros', () => {
    const frames: MotionFrame[] = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const atMs = i * FRAME_MS;
      const a = atMs / 1000;
      const x = 200 * Math.cos(a);
      const y = 200 * Math.sin(a);
      frames.push({ atMs, drawnX: x, drawnY: y, trueX: x, trueY: y });
    }
    const c = countMotionArtefacts(frames);
    expect(c.snaps).toBe(0);
    expect(c.freezeFrames).toBe(0);
    expect(c.backwardSteps).toBe(0);
    expect(c.meanLatenessMs).toBeCloseTo(0, 6);
    expect(c.maxLatenessMs).toBeCloseTo(0, 6);
  });

  it('one 90 u jump gives snaps = 1, largest = 90', () => {
    const c = countMotionArtefacts(straightTrack((i, atMs) => trueX(atMs) + (i >= 60 ? 90 : 0)));
    expect(c.snaps).toBe(1);
    expect(c.largestSnapU).toBeCloseTo(90, 6);
    expect(c.totalSnapU).toBeCloseTo(90, 6);
    expect(c.freezeFrames).toBe(0);
    expect(c.backwardSteps).toBe(0);
  });

  it('a track that stops for 18 frames gives freeze frames = 18', () => {
    const STOP_AT = 60;
    const STOP_FRAMES = 18;
    const c = countMotionArtefacts(
      straightTrack((i) => {
        if (i <= STOP_AT) return trueX(i * FRAME_MS);
        if (i <= STOP_AT + STOP_FRAMES) return trueX(STOP_AT * FRAME_MS);
        return trueX((i - STOP_FRAMES) * FRAME_MS);
      }),
    );
    expect(c.freezeFrames).toBe(STOP_FRAMES);
    expect(c.snaps).toBe(0);
    expect(c.backwardSteps).toBe(0);
    expect(c.maxLatenessMs).toBeCloseTo(STOP_FRAMES * FRAME_MS, 6);
  });

  it('a late-by-100 ms track gives lateness 100', () => {
    const LATE_MS = 100;
    const c = countMotionArtefacts(
      straightTrack((_i, atMs) => trueX(atMs - LATE_MS)),
      // The first 100 ms have no true-track history to be late against.
      { ignoreFirstMs: LATE_MS },
    );
    expect(c.meanLatenessMs).toBeCloseTo(LATE_MS, 6);
    expect(c.maxLatenessMs).toBeCloseTo(LATE_MS, 6);
    expect(c.snaps).toBe(0);
    expect(c.freezeFrames).toBe(0);
    expect(c.backwardSteps).toBe(0);
  });

  it('a drawn step against the true direction counts as one backward step', () => {
    const c = countMotionArtefacts(straightTrack((i, atMs) => trueX(atMs) - (i === 60 ? 8 : 0)));
    expect(c.backwardSteps).toBe(1);
    // Recovering from the dip is a 13 u step against a 5 u true step: an 8 u snap.
    expect(c.snaps).toBe(1);
    expect(c.largestSnapU).toBeCloseTo(8, 6);
  });
});
