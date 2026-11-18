/**
 * The shared route line (navigation slice 14): one trace for the fleet patrol
 * pick (closed loop) and the helm course (open, from the ship).
 */
import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import { traceRoute, routeDots } from './routeLine.js';

function recorder(): { g: Graphics; ops: string[] } {
  const ops: string[] = [];
  const g = {
    moveTo(x: number, y: number) { ops.push(`M${x},${y}`); return g; },
    lineTo(x: number, y: number) { ops.push(`L${x},${y}`); return g; },
    circle(x: number, y: number, r: number) { ops.push(`C${x},${y},${r}`); return g; },
  };
  return { g: g as unknown as Graphics, ops };
}
const id = (x: number, y: number, out: { x: number; y: number }): void => { out.x = x; out.y = y; };
const pts = [1, 2, 3, 4, 5, 6];

describe('traceRoute', () => {
  it('open from a start point: start, then every point (game Y-up → Pixi Y-down)', () => {
    const { g, ops } = recorder();
    traceRoute(g, pts, 0, 3, false, 0, 0, id, { x: 0, y: 0 });
    expect(ops).toEqual(['M0,0', 'L1,-2', 'L3,-4', 'L5,-6']);
  });
  it('closed loop: from the last point round through all (the patrol pick)', () => {
    const { g, ops } = recorder();
    traceRoute(g, pts, 0, 3, true, NaN, NaN, id, { x: 0, y: 0 });
    expect(ops).toEqual(['M5,-6', 'L1,-2', 'L3,-4', 'L5,-6']);
  });
  it('a sub-range, and nothing for an empty one', () => {
    const { g, ops } = recorder();
    traceRoute(g, pts, 1, 2, false, NaN, NaN, id, { x: 0, y: 0 });
    traceRoute(g, pts, 0, 0, false, 0, 0, id, { x: 0, y: 0 });
    expect(ops).toEqual(['M3,-4', 'L3,-4', 'L5,-6']);
  });
});

describe('routeDots', () => {
  it('a dot at each point in range', () => {
    const { g, ops } = recorder();
    routeDots(g, pts, 0, 2, 3, id, { x: 0, y: 0 });
    expect(ops).toEqual(['C1,-2,3', 'C3,-4,3']);
  });
});
