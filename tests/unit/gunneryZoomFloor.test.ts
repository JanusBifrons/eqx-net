/**
 * Real-scale naval ranges: a capital pilot may zoom out to its longest gun's
 * reach (owner decision 2026-11-10). `zoomFloorForKind` is the ONE floor the
 * client camera (`zoomRangeForKind`) and the server's far-shell interest
 * (`shellViewHalfExtent`) share (#15). Sub-capitals and legacy mode keep
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
  SHELL_VIEW_HALF_PX,
  gunneryViewHalfExtent,
  hullZoomFactor,
  shellViewHalfExtent,
  startZoomForScale,
  zoomFloorForKind,
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

describe('shellViewHalfExtent parity with the camera floor (#15)', () => {
  it('is SHELL_VIEW_HALF_PX at zoomRangeForKind\'s floor, every kind, both modes', () => {
    for (const mode of MODES) {
      for (const k of SHIP_KINDS_LIST) {
        const { minScale } = zoomRangeForKind(k, 1, { minScale: 0, startZoom: 0 }, mode);
        expect(shellViewHalfExtent(k, mode), `${k.id} ${mode}`).toBeCloseTo(SHELL_VIEW_HALF_PX / minScale, 6);
      }
    }
  });

  it('the default mode is this process\'s and the cache agrees with a fresh computation', () => {
    for (const id of CAPITAL_IDS) {
      const k = getShipKind(id);
      const first = zoomFloorForKind(k);
      expect(zoomFloorForKind(k)).toBe(first);
      expect(shellViewHalfExtent(k)).toBeCloseTo(SHELL_VIEW_HALF_PX / first, 6);
    }
  });
});
