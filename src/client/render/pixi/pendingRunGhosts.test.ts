import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import { drawPendingRun } from './pendingRunGhosts.js';

/** Records the draw calls a run makes. */
function fakeGfx() {
  const calls = { lines: 0, circles: 0, strokes: 0 };
  const g = {
    moveTo: () => g, lineTo: () => { calls.lines++; return g; },
    circle: () => { calls.circles++; return g; }, stroke: () => { calls.strokes++; return g; },
  };
  return { g: g as unknown as Graphics, calls };
}

describe('the pending fence run draws in the preview pass', () => {
  it('a post ghost per corner and a beam ghost per step', () => {
    const { g, calls } = fakeGfx();
    expect(drawPendingRun(g, [0, 0, 100, 0, 100, 100], 1)).toBe(3);
    expect(calls.circles).toBe(3);
    expect(calls.lines).toBe(2);
  });

  it('a NaN pair breaks the line between two clicks; a repeated corner draws no beam', () => {
    const { g, calls } = fakeGfx();
    drawPendingRun(g, [0, 0, 100, 0, NaN, NaN, 100, 0, 100, 100], 1);
    expect(calls.circles).toBe(4);
    expect(calls.lines).toBe(2);
  });

  it('nothing to draw without a run', () => {
    const { g, calls } = fakeGfx();
    expect(drawPendingRun(g, undefined, 1)).toBe(0);
    expect(drawPendingRun(g, [], 1)).toBe(0);
    expect(calls.circles + calls.lines).toBe(0);
  });
});
