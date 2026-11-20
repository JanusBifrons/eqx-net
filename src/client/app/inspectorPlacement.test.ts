import { describe, expect, it } from 'vitest';
import { INSPECTOR_EDGE, INSPECTOR_TOP_MIN, hudRects, placeInspector, reclampHeldInspector, type InspectorAnchor } from './inspectorPlacement';

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

// #1046 phone still (863x360, Refinery): the 209 px card spanned y 106-315
// with the capsule top at 304, so its action-icon row sat on the capsule.
// When it can't fit between the bands it slides beside the bottom stack.
describe('placeInspector slides beside the bottom stack when it cannot fit between the bands', () => {
  const PW = 863;
  const PH = 360;
  const helm = { left: 280, right: 583, top: 64, bottom: 98 };
  const capsule = { left: 300, right: 563, top: 304, bottom: 344 };
  const CW = 150;
  const CH = 209;
  // Rest spots of the move stick (left), lock stick and boost (right).
  const sticks = hudRects([16, 244, 116, 344], [679, 252, 771, 344], [795, 298, 841, 344]);

  it('slides to the side nearer its target, clear of the capsule and the controls', () => {
    placeInspector(430, 340, CW, CH, PW, PH, out, helm, capsule, sticks);
    expect(out.left + CW / 2).toBeLessThanOrEqual(capsule.left);
    expect(out.left - CW / 2).toBeGreaterThanOrEqual(116);
    expect(out.top - CH).toBeGreaterThanOrEqual(helm.bottom + INSPECTOR_EDGE);
    expect(out.top).toBe(340);
  });

  it('a target right of centre slides right when that side has room', () => {
    const roomy = hudRects([16, 244, 116, 344], [800, 252, 850, 344]);
    placeInspector(470, 340, CW, CH, PW, PH, out, helm, capsule, roomy);
    expect(out.left - CW / 2).toBeGreaterThanOrEqual(capsule.right);
    expect(out.left + CW / 2).toBeLessThanOrEqual(800);
  });

  it('with no room on either side it keeps the helm clear and overlaps the capsule as little as possible', () => {
    const wide = hudRects([16, 200, 250, 344], [610, 200, 850, 344]);
    placeInspector(430, 340, CW, CH, PW, PH, out, helm, capsule, wide);
    expect(out.left).toBe(430);
    expect(out.top - CH).toBe(helm.bottom + INSPECTOR_EDGE);
  });

  it('a card that fits between the bands just lifts and does not slide', () => {
    placeInspector(430, 340, CW, 150, PW, PH, out, helm, capsule, sticks);
    expect(out).toEqual({ left: 430, top: capsule.top - INSPECTOR_EDGE });
  });
});

// Owner bug: on a sideways phone (~863x390) tapping a building put the card
// ON the building. The panel must sit clear of the selection box.
describe('placeInspector keeps clear of the selection (sideways phone)', () => {
  const PW = 220;
  const PH = 200;
  const VW2 = 863;
  const VH2 = 390;
  /** Selection box (half px) only, no HUD. */
  const place = (ssx: number, ssy: number, half: number, w: number, h: number) =>
    placeInspector(ssx, ssy, w, h, VW2, VH2, out, undefined, undefined, undefined, half);

  it('stays above the selection when it fits there', () => {
    expect(place(430, 300, 30, PW, PH)).toEqual({ left: 430, top: 300 });
  });

  it('a tall panel over a building near the top goes beside it, not on it', () => {
    place(430, 120, 40, PW, PH);
    expect(covers(out, PW, PH, 430, 120, 40)).toBe(false);
    onScreen(out, PW, PH, VW2, VH2);
    expect(out.left - PW / 2).toBeGreaterThan(430 + 40); // right of the box
  });

  it('goes to the left when there is no room on the right', () => {
    place(760, 120, 40, PW, PH);
    expect(covers(out, PW, PH, 760, 120, 40)).toBe(false);
    onScreen(out, PW, PH, VW2, VH2);
    expect(out.left + PW / 2).toBeLessThan(760 - 40); // left of the box
  });

  it('goes below when neither side has room', () => {
    place(430, 60, 30, 600, 150);
    expect(covers(out, 600, 150, 430, 60, 30)).toBe(false);
    onScreen(out, 600, 150, VW2, VH2);
    expect(out.top - 150).toBeGreaterThanOrEqual(60 + 60); // under the box
  });

  it('falls back to the on-screen clamp when nothing clear fits', () => {
    expect(place(430, 100, 80, 600, 250)).toEqual({ left: 430, top: INSPECTOR_TOP_MIN + 250 });
  });

  it('beside the selection it also keeps clear of the bottom HUD band and the controls', () => {
    const capsule = { left: 300, right: 563, top: 300, bottom: 344 };
    const lockStick = hudRects([679, 252, 771, 344]); // blocks the right-hand spot
    const w = 200, h = 220;
    placeInspector(520, 120, w, h, VW2, VH2, out, undefined, capsule, lockStick, 40);
    expect(covers(out, w, h, 520, 120, 40)).toBe(false);
    onScreen(out, w, h, VW2, VH2);
    expect(out.left + w / 2).toBeLessThanOrEqual(520 - 40); // left of the box
    expect(out.top).toBeLessThanOrEqual(capsule.top - INSPECTOR_EDGE); // off the capsule
  });
});

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

// Live still (Build mode, refinery selected, sideways 1132x473): the card went
// right of the selection but over the Build menu's label pills ("Back",
// "Core", "Economy"), left of the round dial buttons.
describe('placeInspector keeps clear of the speed-dial label pills', () => {
  const VW3 = 1132;
  const VH3 = 473;
  const w = 220, h = 260;
  const pills = hudRects([790, 150, 905, 180], [790, 200, 905, 230], [790, 250, 905, 280]);
  const fabs = hudRects([910, 145, 960, 185], [910, 195, 960, 235], [910, 245, 960, 285]);
  const both = hudRects([790, 150, 905, 180], [790, 200, 905, 230], [790, 250, 905, 280],
    [910, 145, 960, 185], [910, 195, 960, 235], [910, 245, 960, 285]);

  it('with only the round buttons measured the right-hand spot is taken (the bug)', () => {
    placeInspector(560, 150, w, h, VW3, VH3, out, undefined, undefined, fabs, 50);
    expect(out.left - w / 2).toBeGreaterThan(610);
    expect(out.left + w / 2).toBeGreaterThan(790); // over the pills
  });

  it('a selection with room on its right but labels there goes left (or below), clear of the pills', () => {
    for (const c of [pills, both]) {
      placeInspector(560, 150, w, h, VW3, VH3, out, undefined, undefined, c, 50);
      expect(covers(out, w, h, 560, 150, 50)).toBe(false);
      onScreen(out, w, h, VW3, VH3);
      expect(out.left + w / 2 <= 790 || out.top - h >= 280).toBe(true);
      expect(out.left + w / 2).toBeLessThanOrEqual(510); // left of the box
    }
  });
});
