import { describe, expect, it } from 'vitest';
import { CAPITAL_PORTRAIT_ROT, CAPITAL_PORTRAIT_ZOOM, PORTRAIT_KINDS, portraitFraming, portraitQuery, shipPortraitUrl, STRUCTURE_PORTRAIT_KINDS, structurePortraitQuery, structurePortraitUrl, reframeStructure, STRUCTURE_PORTRAIT_PAD } from './shipPortraits.js';
import { BUILD_CATEGORIES } from '../../components/buildCategories.js';
import { shipParts } from './fields.js';
import { shipTurrets } from './turretLayout.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';

/** Widest a hull and its guns span on screen (world units) at the capital
 *  pose: the larger of its rotated bounding box's width and height. */
function span(kind: string): number {
  const c = Math.cos(CAPITAL_PORTRAIT_ROT), s = Math.sin(CAPITAL_PORTRAIT_ROT);
  let mx = 0, my = 0;
  const add = (x: number, y: number, pad: number): void => {
    mx = Math.max(mx, Math.abs(x * c - y * s) + pad);
    my = Math.max(my, Math.abs(x * s + y * c) + pad);
  };
  for (const p of shipParts(getShipKind(kind))) for (const [x, y] of p.pts) add(x, y, 0);
  for (const t of shipTurrets(kind)) add(t.px, t.py, Math.max(t.len, t.cap, t.naval ? t.naval.houseL : 0));
  return 2 * Math.max(mx, my);
}

describe('ship portraits (join flow stage 3)', () => {
  it('resolves a flyable hull and nothing else', () => {
    expect(shipPortraitUrl('fighter')).toBe('/ships/fighter.webp');
    expect(shipPortraitUrl('battleship-rail')).toBe('/ships/battleship-rail.webp');
    expect(shipPortraitUrl('crossguard')).toBeNull(); // engineering-only
    expect(shipPortraitUrl('no-such-hull')).toBeNull();
  });

  it('capitals share one zoom, with turrets and no engine glow; sub-caps fit alone', () => {
    expect(portraitFraming('battleship')).toEqual({ zm: 1, cz: CAPITAL_PORTRAIT_ZOOM, rot: CAPITAL_PORTRAIT_ROT, th: 0, turrets: true });
    expect(portraitFraming('destroyer')).toEqual(portraitFraming('battleship'));
    expect(portraitFraming('fighter')).toEqual({ zm: 1, th: 0.6, turrets: false });
    expect(portraitQuery('destroyer')).toBe(`style=machined&scene=portrait&kind=destroyer&zm=1&th=0&cz=${CAPITAL_PORTRAIT_ZOOM}&rot=-0.7854&turrets=1`);
    expect(portraitQuery('fighter')).toBe('style=machined&scene=portrait&kind=fighter&zm=1&th=0.6');
  });

  it('the Barge (Shipyard-built) is fitted on its own', () => {
    expect(portraitFraming('barge')).toEqual({ zm: 1, rot: CAPITAL_PORTRAIT_ROT, th: 0, turrets: true });
  });

  it('the largest warship fills most of the 900 px crop without clipping', () => {
    const caps = PORTRAIT_KINDS.filter((k) => portraitFraming(k).cz !== undefined);
    expect(caps.length).toBe(8);
    const widest = Math.max(...caps.map(span)) * CAPITAL_PORTRAIT_ZOOM;
    expect(widest).toBeLessThanOrEqual(900 * 0.95);
    expect(widest).toBeGreaterThanOrEqual(900 * 0.7);
  });
});

describe('structure portraits (build menu P1)', () => {
  it('covers exactly the kinds in the build categories', () => {
    const categorised = BUILD_CATEGORIES.flatMap((c) => c.kinds);
    expect(new Set(STRUCTURE_PORTRAIT_KINDS)).toEqual(new Set(categorised));
  });

  it('resolves a buildable structure and nothing else', () => {
    expect(structurePortraitUrl('solar')).toBe('/structures/solar.webp');
    expect(structurePortraitUrl('shipyard')).toBe('/structures/shipyard.webp');
    expect(structurePortraitUrl('fighter')).toBeNull();
    expect(structurePortraitUrl('no-such-structure')).toBeNull();
  });

  it('asks the art lab for one machined structure, guns drawn', () => {
    expect(structurePortraitQuery('refinery')).toBe('style=machined&scene=portrait&struct=refinery&turrets=1&zm=1&ox=0&oy=0');
    expect(structurePortraitQuery('turret', { zm: 1.23456, cx: -12.345, cy: 7 }, true))
      .toBe('style=machined&scene=portrait&struct=turret&turrets=1&zm=1.2346&ox=-12.35&oy=7&bare=1');
  });

  it('reframes a measured box: centred on the box, longer side filling the crop less an even pad', () => {
    const view = { w: 1600, h: 900 };
    // A box 200 px tall, 100 wide, centred 50 px right of and 100 px above the canvas centre, drawn at zm 0.4.
    const f = reframeStructure({ zm: 0.4, cx: 10, cy: 0 }, { x0: 800, y0: 250, x1: 900, y1: 450 }, view, 900);
    expect(f.zm).toBeCloseTo((0.4 * 900 * (1 - 2 * STRUCTURE_PORTRAIT_PAD)) / 200);
    // Offsets are in px at zm 1: 50 px at zm 0.4 is 125.
    expect(f.cx).toBeCloseTo(10 + 50 / 0.4);
    expect(f.cy).toBeCloseTo(-100 / 0.4);
    // Re-measuring at the new frame gives a centred box of the padded size: the fixed point.
    const side = 900 * (1 - 2 * STRUCTURE_PORTRAIT_PAD);
    const again = reframeStructure(f, { x0: 800 - side / 4, y0: 450 - side / 2, x1: 800 + side / 4, y1: 450 + side / 2 }, view, 900);
    expect(again.zm).toBeCloseTo(f.zm);
    expect(again.cx).toBeCloseTo(f.cx);
    expect(again.cy).toBeCloseTo(f.cy);
  });
});
