import { describe, expect, it } from 'vitest';
import { INSPECTOR_EDGE, INSPECTOR_TOP_MIN, placeInspector } from './inspectorPlacement';

const out = { left: 0, top: 0 };
const W = 200;
const H = 150;
const VW = 1280;
const VH = 720;

describe('placeInspector', () => {
  it('follows its target when the whole panel fits', () => {
    expect(placeInspector(640, 400, W, H, VW, VH, out)).toEqual({ left: 640, top: 400 });
  });

  it('keeps the whole panel on screen when the target is off the left or right edge', () => {
    placeInspector(-500, 400, W, H, VW, VH, out);
    expect(out.left - W / 2).toBeGreaterThanOrEqual(INSPECTOR_EDGE);
    placeInspector(5000, 400, W, H, VW, VH, out);
    expect(out.left + W / 2).toBeLessThanOrEqual(VW - INSPECTOR_EDGE);
  });

  it('keeps the top below the header and the bottom above the viewport edge', () => {
    placeInspector(640, -300, W, H, VW, VH, out);
    expect(out.top - H).toBeGreaterThanOrEqual(INSPECTOR_TOP_MIN);
    placeInspector(640, 5000, W, H, VW, VH, out);
    expect(out.top).toBeLessThanOrEqual(VH - INSPECTOR_EDGE);
  });

  it('a panel taller than the room keeps its bottom (the actions) on screen', () => {
    placeInspector(640, 100, W, 900, VW, VH, out);
    expect(out.top).toBe(VH - INSPECTOR_EDGE);
  });
});
