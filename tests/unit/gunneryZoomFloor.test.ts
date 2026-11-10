/**
 * Real-scale naval ranges: a capital pilot may zoom out to its longest gun's
 * reach (owner decision 2026-11-10). `zoomFloorForView` (the live viewport;
 * `zoomFloorForKind` is its 1920-px reference) is the client camera floor;
 * the server's far-shell interest (`shellViewHalfExtent`) bounds it (#15). Sub-capitals and legacy mode keep
 * today's floor exactly. Modes are passed explicitly, so this runs the same
 * whatever `EQX_NAVAL_RANGE` the process has.
 */
import { describe, it, expect } from 'vitest';
import { getShipKind, SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';
import { CAPITAL_STYLE_VARIANTS } from '../../src/shared-types/shipKinds/capitals/index.js';
import { REAL_NAVAL_GUNS, navalGunEngageReach, type NavalGunId } from '../../src/shared-types/combat/navalGuns.js';
import {
  GAMEPLAY_MIN_ZOOM,
  GUN_VIEW_MARGIN,
  MAX_VIEW_ASPECT,
  SHELL_VIEW_HALF_PX,
  gunneryViewHalfExtent,
  hullZoomFactor,
  shellViewHalfExtent,
  startZoomForScale,
  zoomFloorForKind,
  zoomFloorForView,
  zoomRangeForKind,
} from '../../src/shared-types/shipScale/tuning.js';
import type { ShipKind } from '../../src/shared-types/shipKinds/types.js';

const CAPITAL_IDS = Object.values(CAPITAL_STYLE_VARIANTS).flat();
const MODES = ['legacy', 'real'] as const;

/** Longest naval gun reach from the hull centre (engage reach + mount offset). */
function longestReach(kind: ShipKind): number {
  let r = 0;
  for (const m of kind.mounts ?? []) {
    if (!(m.weaponId in REAL_NAVAL_GUNS)) continue;
    r = Math.max(r, navalGunEngageReach(m.weaponId as NavalGunId, 'real') + Math.hypot(m.localX, m.localY));
  }
  return r;
}

describe('zoomFloorForKind — capitals see their guns\' reach in real mode', () => {
  it('a capital floor shows its longest gun\'s full reach across a 16:9 desktop (1920x1080)', () => {
    for (const id of CAPITAL_IDS) {
      const k = getShipKind(id);
      const reach = longestReach(k);
      expect(reach, id).toBeGreaterThan(10_000);
      const floor = zoomRangeForKind(k, 0.5, { minScale: 0, startZoom: 0 }, 'real').minScale;
      const halfWidthU = 1920 / 2 / floor;
      expect(halfWidthU, id).toBeGreaterThanOrEqual(reach);
      // Never further out than the reach plus the margin.
      expect(halfWidthU, id).toBeLessThanOrEqual(Math.max(reach * GUN_VIEW_MARGIN, SHELL_VIEW_HALF_PX * hullZoomFactor(k) / GAMEPLAY_MIN_ZOOM) + 1e-6);
    }
  });

  it('the battleship\'s 16" (38.7 km) fits on screen', () => {
    const bs = getShipKind('battleship');
    expect(shellViewHalfExtent(bs, 'real')).toBeGreaterThan(38_700);
    expect(zoomFloorForKind(bs, 'real')).toBeLessThan(zoomFloorForKind(bs, 'legacy'));
  });

  it('legacy mode is unchanged: the hull floor, for every kind', () => {
    for (const k of SHIP_KINDS_LIST) {
      expect(gunneryViewHalfExtent(k, 'legacy')).toBe(0);
      expect(zoomFloorForKind(k, 'legacy')).toBe(GAMEPLAY_MIN_ZOOM / hullZoomFactor(k));
      const r = zoomRangeForKind(k, 0.5, { minScale: 0, startZoom: 0 }, 'legacy');
      expect(r.minScale).toBe(GAMEPLAY_MIN_ZOOM / hullZoomFactor(k));
      expect(r.startZoom).toBe(startZoomForScale(0.5) / hullZoomFactor(k));
    }
  });

  it('sub-capitals keep today\'s floor exactly in real mode', () => {
    for (const k of SHIP_KINDS_LIST) {
      if (k.sizeClass === 'capital') continue;
      expect(gunneryViewHalfExtent(k, 'real'), k.id).toBe(0);
      expect(zoomFloorForKind(k, 'real'), k.id).toBe(zoomFloorForKind(k, 'legacy'));
    }
    // Even a sub-capital carrying a naval gun (the floor is for capitals only).
    const armed = { radius: 100, sizeClass: 'cruiser' as const, mounts: [{ weaponId: 'naval_xl' as const, localX: 0, localY: 0 }] };
    expect(zoomFloorForKind(armed, 'real')).toBe(GAMEPLAY_MIN_ZOOM);
  });

  it('the start zoom follows the hull only (the same in both modes)', () => {
    for (const id of CAPITAL_IDS) {
      const k = getShipKind(id);
      const a = zoomRangeForKind(k, 0.5, { minScale: 0, startZoom: 0 }, 'legacy');
      const b = zoomRangeForKind(k, 0.5, { minScale: 0, startZoom: 0 }, 'real');
      expect(b.startZoom).toBe(a.startZoom);
      expect(b.minScale).toBeLessThanOrEqual(a.minScale);
    }
  });

  it('a capital whose hull floor already covers its reach keeps the hull floor', () => {
    const k = { radius: 60_000, sizeClass: 'capital' as const, mounts: [{ weaponId: 'naval_s' as const, localX: 0, localY: 0 }] };
    expect(zoomFloorForKind(k, 'real')).toBe(GAMEPLAY_MIN_ZOOM / hullZoomFactor(k));
  });
});

/**
 * The floor follows the ACTUAL viewport (bug: it assumed a 1920-px view, so in
 * the 1280×720 showcase window a target 30 km off a battleship's beam sat at
 * the right edge, under the weapon strip, at full zoom-out and never showed).
 */
const VIEWPORTS = [
  { name: '1280x720', w: 1280, h: 720 },
  { name: '1920x1080', w: 1920, h: 1080 },
  { name: '1366x768 laptop', w: 1366, h: 768 },
  { name: '390x844 phone', w: 390, h: 844 },
  { name: '3840x2160', w: 3840, h: 2160 },
  { name: '2560x1080 ultrawide', w: 2560, h: 1080 },
] as const;

describe('zoomFloorForView — the live viewport shows the reach', () => {
  it('a 1280x720 and a 1920x1080 window both show the battleship\'s 16" reach on BOTH axes at the floor', () => {
    const bs = getShipKind('battleship');
    const reach = longestReach(bs);
    expect(reach).toBeGreaterThan(38_700);
    for (const vp of [VIEWPORTS[0], VIEWPORTS[1]]) {
      const floor = zoomRangeForKind(bs, 0.5, { minScale: 0, startZoom: 0 }, 'real', vp.w, vp.h).minScale;
      expect(zoomFloorForView(bs, vp.w, vp.h, 'real')).toBe(floor);
      expect(vp.w / 2 / floor, vp.name).toBeGreaterThanOrEqual(reach);
      expect(vp.h / 2 / floor, vp.name).toBeGreaterThanOrEqual(reach);
    }
  });

  it('every capital sees its reach on the short axis of every common viewport', () => {
    for (const id of CAPITAL_IDS) {
      const k = getShipKind(id);
      const reach = longestReach(k);
      for (const vp of VIEWPORTS) {
        const floor = zoomFloorForView(k, vp.w, vp.h, 'real');
        expect(Math.min(vp.w, vp.h) / 2 / floor, `${id} ${vp.name}`).toBeGreaterThanOrEqual(reach);
      }
    }
  });

  it('sub-capitals and legacy mode ignore the viewport (the hull floor)', () => {
    for (const k of SHIP_KINDS_LIST) {
      for (const vp of VIEWPORTS) {
        expect(zoomFloorForView(k, vp.w, vp.h, 'legacy'), `${k.id} ${vp.name}`).toBe(GAMEPLAY_MIN_ZOOM / hullZoomFactor(k));
        if (k.sizeClass !== 'capital') {
          expect(zoomFloorForView(k, vp.w, vp.h, 'real'), `${k.id} ${vp.name}`).toBe(GAMEPLAY_MIN_ZOOM / hullZoomFactor(k));
        }
      }
    }
  });

  it('no viewport size falls back to the reference floor', () => {
    const bs = getShipKind('battleship');
    expect(zoomFloorForView(bs, 0, 0, 'real')).toBe(zoomFloorForKind(bs, 'real'));
  });
});

describe('shellViewHalfExtent bounds every client view (#15)', () => {
  const extremes = [...VIEWPORTS, { name: '320x1000 sliver', w: 320, h: 1000 }, { name: '5120x1440 super-ultrawide', w: 5120, h: 1440 }];

  it('covers the longer half of every viewport at a capital\'s real-mode floor (up to 1920-px wide hull floors)', () => {
    for (const id of CAPITAL_IDS) {
      const k = getShipKind(id);
      for (const vp of extremes) {
        const floor = zoomFloorForView(k, vp.w, vp.h, 'real');
        // A floor clamped at the hull floor is the pre-existing 1920-px bound.
        const longHalfPx = floor === GAMEPLAY_MIN_ZOOM / hullZoomFactor(k) ? Math.min(Math.max(vp.w, vp.h) / 2, SHELL_VIEW_HALF_PX) : Math.max(vp.w, vp.h) / 2;
        expect(shellViewHalfExtent(k, 'real'), `${id} ${vp.name}`).toBeGreaterThanOrEqual(longHalfPx / floor - 1e-6);
      }
    }
  });

  it('is the 1920-px view at the hull floor for every sub-capital and in legacy mode (unchanged)', () => {
    for (const mode of MODES) {
      for (const k of SHIP_KINDS_LIST) {
        if (mode === 'real' && k.sizeClass === 'capital') continue;
        const { minScale } = zoomRangeForKind(k, 1, { minScale: 0, startZoom: 0 }, mode);
        expect(shellViewHalfExtent(k, mode), `${k.id} ${mode}`).toBeCloseTo(SHELL_VIEW_HALF_PX / minScale, 6);
      }
    }
  });

  it('a real-mode capital\'s bound is its reach × margin × MAX_VIEW_ASPECT; the cache agrees', () => {
    for (const id of CAPITAL_IDS) {
      const k = getShipKind(id);
      expect(shellViewHalfExtent(k, 'real'), id).toBeCloseTo(Math.max(
        SHELL_VIEW_HALF_PX * hullZoomFactor(k) / GAMEPLAY_MIN_ZOOM,
        gunneryViewHalfExtent(k, 'real') * MAX_VIEW_ASPECT,
      ), 6);
      expect(shellViewHalfExtent(k)).toBe(shellViewHalfExtent(k));
    }
  });
});
