/**
 * Command view zooms out as far as the far-zoom levels go, whatever you fly
 * (owner 2026-11-16: a fighter in command view stopped at the fighter's floor).
 * Its floor is the widest any ship can reach on this viewport, the floors the
 * starfield is already locked for (`lodStarfield.coverage.test.ts`); flying
 * keeps the hull's own floor.
 */
import { describe, it, expect } from 'vitest';
import { getShipKind, SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';
import { zoomFloorForView } from '../../src/shared-types/shipScale/tuning.js';
import { zoomFloorFor } from '../../src/shared-types/shipScale/commandZoom.js';

const VIEWS = [[390, 844], [844, 390], [1920, 1080]] as const;

describe('zoomFloorFor (command view floor)', () => {
  it.each(VIEWS)('command view from a fighter reaches the widest floor of any ship (%i x %i)', (w, h) => {
    const fighter = getShipKind('fighter');
    let widest = Infinity;
    for (const k of SHIP_KINDS_LIST) widest = Math.min(widest, zoomFloorForView(k, w, h));
    const floor = zoomFloorFor(fighter, true, w, h);
    expect(floor).toBe(widest);
    expect(floor).toBeLessThan(zoomFloorForView(fighter, w, h) / 10);
  });

  it.each(VIEWS)('flying keeps the hull floor (%i x %i)', (w, h) => {
    for (const k of SHIP_KINDS_LIST) expect(zoomFloorFor(k, false, w, h)).toBe(zoomFloorForView(k, w, h));
  });
});
