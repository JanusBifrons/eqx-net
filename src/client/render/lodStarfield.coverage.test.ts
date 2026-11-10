import { describe, it, expect } from 'vitest';
import { getShipKind } from '@shared-types/shipKinds';
import { CAPITAL_STYLE_VARIANTS } from '@shared-types/shipKinds/capitals/index';
import { zoomFloorForKind, zoomFloorForView } from '@shared-types/shipScale/tuning';
import { STAR_MAX_TILE_HALF, starLayerAlphaAt, starTileHalfRange } from './lodStarfield';
import { GAMEPLAY_STAR_LAYERS } from './StarfieldBackground';
import { GALAXY_STAR_LAYERS } from './galaxy/galaxyStarfield';

/**
 * Phase 5 — the starfield "huge square + harsh cut-off, fully zoomed out"
 * regression lock (the user's "literally zero change" report). This is the
 * OBJECTIVE test the prior alpha-only fix (#11) lacked: at the zoom-out floor,
 * the tiled field must COVER the whole viewport in world units — no uncovered
 * region, no hard edge — for every plausible device.
 *
 * It fails on the pre-fix `STAR_MAX_TILE_HALF = 12` clamp (which covers only
 * ±12 tiles ≈ ±4080 world-units for the coarsest gameplay layer, far narrower
 * than a 4K screen's ~12 800 half-width at 0.15) and passes once the half-range
 * is sized to the viewport.
 */

// The real camera zoom-out floors (PixiRenderer overrides the Camera default):
const GAMEPLAY_MIN_ZOOM = 0.15;
const GALAXY_MIN_ZOOM = 0.12;

// Plausible viewports the field must fully cover at the floor.
const VIEWPORTS = [
  { name: '4K desktop landscape', w: 3840, h: 2160 },
  { name: 'tall phone portrait', w: 1080, h: 2340 },
  { name: 'wide desktop 1080p', w: 1920, h: 1080 },
];

/** The world half-extent the tiled field actually covers along one axis. */
function coveredHalfWorld(halfViewportWorld: number, tileSize: number): number {
  return starTileHalfRange(halfViewportWorld, tileSize) * tileSize;
}

function assertFullCoverage(
  layers: readonly { tileSize: number }[],
  minZoom: number,
  label: string,
): void {
  // The farthest/overview layer (index 0) is the one carrying the field at the
  // zoom-out floor and has the LARGEST tileSize, so it needs the most tiles —
  // it's the binding case for the square cutoff.
  const far = layers[0]!;
  for (const vp of VIEWPORTS) {
    const hw = vp.w / (2 * minZoom);
    const hh = vp.h / (2 * minZoom);
    expect(
      coveredHalfWorld(hw, far.tileSize),
      `${label} far layer must cover ${vp.name} horizontally at min zoom`,
    ).toBeGreaterThanOrEqual(hw);
    expect(
      coveredHalfWorld(hh, far.tileSize),
      `${label} far layer must cover ${vp.name} vertically at min zoom`,
    ).toBeGreaterThanOrEqual(hh);
  }
}

describe('starfield tiling covers the full viewport at the zoom-out floor (Phase 5 square-cutoff lock)', () => {
  it('gameplay starfield covers every plausible viewport at the 0.15 floor', () => {
    assertFullCoverage(GAMEPLAY_STAR_LAYERS, GAMEPLAY_MIN_ZOOM, 'gameplay');
  });

  it('galaxy-map starfield covers every plausible viewport at the 0.12 floor', () => {
    assertFullCoverage(GALAXY_STAR_LAYERS, GALAXY_MIN_ZOOM, 'galaxy');
  });

  it('starTileHalfRange pads beyond the exact tile count (no hard edge at the boundary)', () => {
    // One extra tile of pad so a star near the viewport edge is never the last
    // drawn column. 1000 world-units / 340 tile ≈ 3 tiles → at least 4 with pad.
    expect(starTileHalfRange(1000, 340)).toBeGreaterThanOrEqual(
      Math.ceil(1000 / 340) + 1,
    );
  });
});

/**
 * Real-scale naval ranges (owner 2026-11-10): a capital pilot's floor is
 * `zoomFloorForKind` (down to ~0.0225 for a battleship in `real` mode, so its
 * 16" reach fits on a 16:9 desktop). At every capital floor, in both naval
 * range modes, some layer is at FULL alpha, and every layer drawn there tiles
 * the whole viewport inside the tile backstop (no square cutoff).
 */
describe('starfield covers every capital zoom-out floor (real-scale naval ranges)', () => {
  const capitalFloors = (): { label: string; floor: number }[] => {
    const out: { label: string; floor: number }[] = [];
    for (const id of Object.values(CAPITAL_STYLE_VARIANTS).flat()) {
      for (const mode of ['legacy', 'real'] as const) {
        out.push({ label: `${id} ${mode}`, floor: zoomFloorForKind(getShipKind(id), mode) });
      }
    }
    return out;
  };

  it('the real-mode battleship floor is below the deep layer (the abyss layer carries it)', () => {
    expect(zoomFloorForKind(getShipKind('battleship'), 'real')).toBeLessThan(0.024);
  });

  it('a layer is FULL at every capital floor, and every drawn layer covers every viewport', () => {
    for (const { label, floor } of capitalFloors()) {
      expect(
        GAMEPLAY_STAR_LAYERS.some((l) => Math.abs(starLayerAlphaAt(l, floor) - l.baseAlpha) < 1e-9),
        `${label}: a layer at full alpha at ${floor}`,
      ).toBe(true);
      for (const l of GAMEPLAY_STAR_LAYERS) {
        if (starLayerAlphaAt(l, floor) <= 0) continue;
        for (const vp of VIEWPORTS) {
          const hw = vp.w / (2 * floor);
          const hh = vp.h / (2 * floor);
          expect(Math.ceil(hw / l.tileSize) + 1, `${label} ${vp.name} inside backstop`).toBeLessThanOrEqual(STAR_MAX_TILE_HALF);
          expect(coveredHalfWorld(hw, l.tileSize), `${label} ${vp.name} horizontal`).toBeGreaterThanOrEqual(hw);
          expect(coveredHalfWorld(hh, l.tileSize), `${label} ${vp.name} vertical`).toBeGreaterThanOrEqual(hh);
        }
      }
    }
  });

  it('legacy floors draw the same layers as before the abyss layer (gone by 0.031)', () => {
    const abyss = GAMEPLAY_STAR_LAYERS.find((l) => l.seed === 606)!;
    for (const { label, floor } of capitalFloors()) {
      if (!label.endsWith('legacy')) continue;
      expect(floor, label).toBeGreaterThanOrEqual(abyss.fadedAt);
      expect(starLayerAlphaAt(abyss, floor), label).toBe(0);
    }
  });

  it('the LIVE capital floor (zoomFloorForView) keeps a layer FULL and inside the backstop at every viewport', () => {
    const viewports = [...VIEWPORTS, { name: '720p window', w: 1280, h: 720 }, { name: 'phone portrait css', w: 390, h: 844 }];
    for (const id of Object.values(CAPITAL_STYLE_VARIANTS).flat()) {
      for (const vp of viewports) {
        const floor = zoomFloorForView(getShipKind(id), vp.w, vp.h, 'real');
        const label = `${id} ${vp.name} @ ${floor}`;
        expect(GAMEPLAY_STAR_LAYERS.some((l) => Math.abs(starLayerAlphaAt(l, floor) - l.baseAlpha) < 1e-9), label).toBe(true);
        for (const l of GAMEPLAY_STAR_LAYERS) {
          if (starLayerAlphaAt(l, floor) <= 0) continue;
          const half = Math.max(vp.w, vp.h) / (2 * floor);
          expect(Math.ceil(half / l.tileSize) + 1, `${label} inside backstop`).toBeLessThanOrEqual(STAR_MAX_TILE_HALF);
        }
      }
    }
  });
});
