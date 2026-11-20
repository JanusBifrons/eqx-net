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

// Live still, sideways Pixel 7 (863x360): a building selected near the top in
// Fly mode put the inspector's title over the helm row's Stop button.
describe('placeInspector with the top-centre HUD band', () => {
  const PW = 863;
  const PH = 360;
  const helm = { left: 280, right: 583, top: 64, bottom: 130 };

  it('a panel that would overlap the band is pushed below it', () => {
    placeInspector(430, 120, 120, 50, PW, PH, out, helm);
    expect(out.top - 50).toBeGreaterThanOrEqual(helm.bottom + INSPECTOR_EDGE);
    expect(out.left).toBe(430);
  });

  it('a panel clear of the band (below it) is unchanged', () => {
    expect(placeInspector(430, 260, 120, 50, PW, PH, out, helm)).toEqual({ left: 430, top: 260 });
  });

  it('a panel beside the band (not under it) only keeps the header rule', () => {
    expect(placeInspector(120, 120, 120, 50, PW, PH, out, helm)).toEqual({ left: 120, top: 120 });
  });

  it('an empty band (bottom 0) changes nothing', () => {
    const empty = { left: 0, right: 0, top: 0, bottom: 0 };
    expect(placeInspector(430, 120, 120, 50, PW, PH, out, empty)).toEqual({ left: 430, top: 120 });
  });

  it('a held panel over the band is moved below it', () => {
    expect(reclampHeldInspector(430, 120, 120, 50, PW, PH, out, helm)).toBe(true);
    expect(out.top).toBe(helm.bottom + INSPECTOR_EDGE + 50);
  });
});

// #1046 live check (sideways Pixel 7): clamped under the helm, a ~210 px card
// ran down over the bottom-centre status capsule.
describe('placeInspector between the top and bottom HUD bands', () => {
  const PW = 863;
  const PH = 360;
  const helm = { left: 280, right: 583, top: 64, bottom: 100 };
  const capsule = { left: 300, right: 563, top: 304, bottom: 344 };

  it('a panel that fits between the bands keeps its bottom above the capsule', () => {
    placeInspector(430, 340, 120, 150, PW, PH, out, helm, capsule);
    expect(out.top).toBe(capsule.top - INSPECTOR_EDGE);
    expect(out.top - 150).toBeGreaterThanOrEqual(helm.bottom + INSPECTOR_EDGE);
  });

  it('a panel too tall for the gap keeps the helm clear and overlaps the capsule as little as possible', () => {
    placeInspector(430, 340, 120, 210, PW, PH, out, helm, capsule);
    expect(out.top - 210).toBe(helm.bottom + INSPECTOR_EDGE);
  });

  it('a panel already clear of the capsule is unchanged', () => {
    expect(placeInspector(430, 250, 120, 100, PW, PH, out, helm, capsule)).toEqual({ left: 430, top: 250 });
  });

  it('a panel beside the capsule (not over it) may go below its top', () => {
    expect(placeInspector(120, 340, 120, 100, PW, PH, out, helm, capsule)).toEqual({ left: 120, top: 340 });
  });

  it('a held panel over the capsule is lifted off it', () => {
    expect(reclampHeldInspector(430, 340, 120, 150, PW, PH, out, helm, capsule)).toBe(true);
    expect(out.top).toBe(capsule.top - INSPECTOR_EDGE);
  });
});
