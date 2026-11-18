import { describe, expect, it } from 'vitest';
import { INSPECTOR_EDGE, INSPECTOR_TOP_MIN, placeInspector, reclampHeldInspector } from './inspectorPlacement';

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

// Cargo pods slice 17 stills: a held inspector (pointer on it) that grows when
// the loot window opens was left half off screen.
describe('reclampHeldInspector', () => {
  it('a held panel that still fits stays exactly where it is', () => {
    expect(reclampHeldInspector(640, 400, W, H, VW, VH, out)).toBe(false);
  });
  it('a held panel that grew past the left edge comes back on screen', () => {
    expect(reclampHeldInspector(60, 400, 300, H, VW, VH, out)).toBe(true);
    expect(out.left).toBe(INSPECTOR_EDGE + 150);
    expect(out.top).toBe(400);
  });
  it('a held panel that grew under the header comes back down', () => {
    expect(reclampHeldInspector(640, 120, W, 300, VW, VH, out)).toBe(true);
    expect(out.top).toBe(INSPECTOR_TOP_MIN + 300);
  });
});
