import { describe, expect, it } from 'vitest';
import { INSPECTOR_EDGE, INSPECTOR_TOP_MIN, placeInspector, reclampHeldInspector, type InspectorAnchor } from './inspectorPlacement';

const out = { left: 0, top: 0 };
const W = 200;
const H = 150;
const VW = 1280;
const VH = 720;

describe('placeInspector', () => {
  it('follows its target when the whole panel fits', () => {
    expect(placeInspector(640, 400, 0, W, H, VW, VH, out)).toEqual({ left: 640, top: 400 });
  });

  it('keeps the whole panel on screen when the target is off the left or right edge', () => {
    placeInspector(-500, 400, 0, W, H, VW, VH, out);
    expect(out.left - W / 2).toBeGreaterThanOrEqual(INSPECTOR_EDGE);
    placeInspector(5000, 400, 0, W, H, VW, VH, out);
    expect(out.left + W / 2).toBeLessThanOrEqual(VW - INSPECTOR_EDGE);
  });

  it('keeps the top below the header and the bottom above the viewport edge', () => {
    placeInspector(640, -300, 0, W, H, VW, VH, out);
    expect(out.top - H).toBeGreaterThanOrEqual(INSPECTOR_TOP_MIN);
    placeInspector(640, 5000, 0, W, H, VW, VH, out);
    expect(out.top).toBeLessThanOrEqual(VH - INSPECTOR_EDGE);
  });

  it('a panel taller than the room keeps its bottom (the actions) on screen', () => {
    placeInspector(640, 100, 0, W, 900, VW, VH, out);
    expect(out.top).toBe(VH - INSPECTOR_EDGE);
  });
});

// Owner bug: on a sideways phone (~863x390) tapping a building put the card
// ON the building. The panel must sit clear of the selection box.
const PW = 220;
const PH = 200;
const PVW = 863;
const PVH = 390;

/** True when the placed panel's rect overlaps the selection box. */
function covers(at: InspectorAnchor, w: number, h: number, ssx: number, ssy: number, half: number): boolean {
  const pl = at.left - w / 2, pr = at.left + w / 2, pt = at.top - h, pb = at.top;
  return pl < ssx + half && pr > ssx - half && pt < ssy + 2 * half && pb > ssy;
}

function onScreen(at: InspectorAnchor, w: number, h: number, vw: number, vh: number): void {
  expect(at.left - w / 2).toBeGreaterThanOrEqual(INSPECTOR_EDGE);
  expect(at.left + w / 2).toBeLessThanOrEqual(vw - INSPECTOR_EDGE);
  expect(at.top - h).toBeGreaterThanOrEqual(INSPECTOR_TOP_MIN);
  expect(at.top).toBeLessThanOrEqual(vh - INSPECTOR_EDGE);
}

describe('placeInspector keeps clear of the selection (sideways phone)', () => {
  it('stays above the selection when it fits there', () => {
    placeInspector(430, 300, 30, PW, PH, PVW, PVH, out);
    expect(out).toEqual({ left: 430, top: 300 });
  });

  it('a tall panel over a building near the top goes beside it, not on it', () => {
    placeInspector(430, 120, 40, PW, PH, PVW, PVH, out);
    expect(covers(out, PW, PH, 430, 120, 40)).toBe(false);
    onScreen(out, PW, PH, PVW, PVH);
    expect(out.left - PW / 2).toBeGreaterThan(430 + 40); // right of the box
  });

  it('goes to the left when there is no room on the right', () => {
    placeInspector(760, 120, 40, PW, PH, PVW, PVH, out);
    expect(covers(out, PW, PH, 760, 120, 40)).toBe(false);
    onScreen(out, PW, PH, PVW, PVH);
    expect(out.left + PW / 2).toBeLessThan(760 - 40); // left of the box
  });

  it('goes below when neither side has room', () => {
    const wide = 600;
    placeInspector(430, 60, 30, wide, 150, PVW, PVH, out);
    expect(covers(out, wide, 150, 430, 60, 30)).toBe(false);
    onScreen(out, wide, 150, PVW, PVH);
    expect(out.top - 150).toBeGreaterThanOrEqual(60 + 60); // under the box
  });

  it('falls back to the on-screen clamp when nothing clear fits', () => {
    const wide = 600;
    placeInspector(430, 100, 80, wide, 250, PVW, PVH, out);
    expect(out).toEqual({ left: 430, top: INSPECTOR_TOP_MIN + 250 });
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
