import { describe, expect, it } from 'vitest';
import { rigClockTick } from './rigSync.js';
import type { MirrorPassCtx } from './mirrorPassCtx.js';

const TICK_MS = 1000 / 60;

/** The fields `rigClockTick` reads; game clock = wall clock (speed 1). */
function ctx(o: { inputTick: number; lastLocalTickAtMs: number; anchorTick: number; anchorMs: number; nowMs: number }): MirrorPassCtx {
  return {
    inputTick: o.inputTick,
    lastLocalTickAtMs: o.lastLocalTickAtMs,
    clockAnchorServerTick: o.anchorTick,
    clockAnchorPerfNow: o.anchorMs,
    gameClock: { at: (ms: number) => ms },
    clock: { now: () => o.nowMs },
  } as unknown as MirrorPassCtx;
}

describe('rigClockTick', () => {
  it('while piloting it follows the predicted input tick', () => {
    // inputTick 2000 was due at 10 000 ms; the server anchor is behind it (the lead).
    const c = ctx({ inputTick: 2000, lastLocalTickAtMs: 10_000, anchorTick: 1990, anchorMs: 10_000, nowMs: 10_000 });
    expect(rigClockTick(c, 10_000 + TICK_MS, true)).toBeCloseTo(2001, 5);
  });

  it('in command view (input tick held) a clip started later still plays', () => {
    // The input loop is held (no own ship: no acks, the over-prediction cap
    // stops inputTick at 1000), but the server clock runs on: anchored at
    // tick 1100 at 0 ms. A structure clip starts at server tick 1135.
    const startTick = 1135;
    const at = (ms: number): number => rigClockTick(
      ctx({ inputTick: 1000, lastLocalTickAtMs: -5000, anchorTick: 1100, anchorMs: 0, nowMs: ms }), ms, true,
    )!;
    const placedMs = 35 * TICK_MS;
    expect(at(placedMs + 300) - startTick).toBeCloseTo(18, 5);
    expect(at(placedMs + 4000) - startTick).toBeCloseTo(240, 5);
  });

  it('is undefined before welcome', () => {
    expect(rigClockTick(ctx({ inputTick: 0, lastLocalTickAtMs: -1, anchorTick: 0, anchorMs: 0, nowMs: 0 }), 0, false)).toBeUndefined();
  });
});
