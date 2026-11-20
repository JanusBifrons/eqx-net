import { describe, expect, it } from 'vitest';
import { rigClockTick } from './rigSync.js';
import type { MirrorPassCtx } from './mirrorPassCtx.js';
import { UNFOLD_TICKS, unfoldPosition } from '../../../core/articulation/unfoldRig.js';
import { unfoldBodyAlpha, unfoldPanelAlpha } from '../../render/pixi/structureRigUnfold.js';

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

  it('in command view (input tick held) an unfold placed later still plays to the end', () => {
    // The input loop is held (no own ship: no acks, the over-prediction cap
    // stops inputTick at 1000), but the server clock runs on: anchored at
    // tick 1100 at 0 ms. The Capital is placed at server tick 1135.
    const startTick = 1135;
    const playing = { clipId: 'unfold', startTick };
    const at = (ms: number): number => rigClockTick(
      ctx({ inputTick: 1000, lastLocalTickAtMs: -5000, anchorTick: 1100, anchorMs: 0, nowMs: ms }), ms, true,
    )!;
    const placedMs = 35 * TICK_MS;
    // Just after confirm: the panels are still on the crate, the body hidden.
    const p0 = unfoldPosition(playing, at(placedMs + 0.3 * 1000));
    expect(p0).toBeGreaterThan(0);
    expect(p0).toBeLessThan(0.2);
    expect(unfoldBodyAlpha(p0)).toBe(0);
    // Mid slide.
    const pMid = unfoldPosition(playing, at(placedMs + 2000));
    expect(pMid).toBeCloseTo(0.5, 1);
    // After the clip: panels gone, the Capital's art at full.
    const pEnd = unfoldPosition(playing, at(placedMs + (UNFOLD_TICKS + 10) * TICK_MS));
    expect(pEnd).toBe(1);
    expect(unfoldPanelAlpha(pEnd)).toBe(0);
    expect(unfoldBodyAlpha(pEnd)).toBe(1);
  });

  it('is undefined before welcome', () => {
    expect(rigClockTick(ctx({ inputTick: 0, lastLocalTickAtMs: -1, anchorTick: 0, anchorMs: 0, nowMs: 0 }), 0, false)).toBeUndefined();
  });
});
