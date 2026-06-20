/**
 * WS-B PR1 (#2) + PR3 (#4) — pure on-screen exclusion + dead-zone band.
 *
 * #2: on-screen entities are excluded from the ring at CANDIDATE-BUILD
 *     time (not via a 500 ms timer), so a just-placed structure that is
 *     visible on screen never gets a ring icon at all.
 * #4: a dead-zone (hysteresis) band shrinks the "on screen" rectangle by a
 *     fixed pixel inset converted to world units, so an entity hovering at
 *     the very edge of the viewport doesn't flicker on/off the ring as it
 *     crosses the precise boundary. Desktop and mobile use different insets
 *     (mobile is smaller — the ring + glyphs are smaller there too).
 *
 * Both helpers are pure: they take a plain `{ x, y, width, height }`
 * world-space bounds rect (Pixi/world-container Y-down, as
 * `Camera.getVisibleBounds()` returns) and a world-per-pixel scale.
 */
import { describe, it, expect } from 'vitest';
import {
  getVisibleBoundsWithDeadZone,
  isEntityOnScreen,
  DEAD_ZONE_PX_DESKTOP,
  DEAD_ZONE_PX_MOBILE,
  type WorldBounds,
} from './visibility.js';

// A 800×600 world-unit viewport centred on the origin, Y-down (Pixi space).
const bounds: WorldBounds = { x: -400, y: -300, width: 800, height: 600 };

describe('isEntityOnScreen (WS-B #2)', () => {
  it('reports an entity at the viewport centre as on-screen', () => {
    // Game-space POI at origin → pixiY = -0 = 0, inside bounds.
    expect(isEntityOnScreen(0, 0, bounds)).toBe(true);
  });

  it('reports an entity well outside the viewport as off-screen', () => {
    expect(isEntityOnScreen(5000, 0, bounds)).toBe(false);
    expect(isEntityOnScreen(0, 5000, bounds)).toBe(false);
  });

  it('flips game-space Y to Pixi-down space before the bounds test', () => {
    // bounds.y..bounds.y+height = -300..300 in PIXI space. A game-space
    // POI at gameY = 250 maps to pixiY = -250, which is inside; a POI at
    // gameY = 400 maps to pixiY = -400, which is outside the bottom edge.
    expect(isEntityOnScreen(0, 250, bounds)).toBe(true);
    expect(isEntityOnScreen(0, 400, bounds)).toBe(false);
  });
});

describe('getVisibleBoundsWithDeadZone (WS-B #4)', () => {
  it('shrinks the rect by the dead-zone inset on all four sides', () => {
    // 1 world-unit per pixel — inset (48) stays well inside half the rect
    // (400 × 300) so no clamp engages and we read the raw shrink.
    const worldPerPx = 1;
    const out: WorldBounds = { x: 0, y: 0, width: 0, height: 0 };
    getVisibleBoundsWithDeadZone(bounds, DEAD_ZONE_PX_DESKTOP, worldPerPx, out);
    const insetWorld = DEAD_ZONE_PX_DESKTOP * worldPerPx;
    expect(out.x).toBeCloseTo(bounds.x + insetWorld);
    expect(out.y).toBeCloseTo(bounds.y + insetWorld);
    expect(out.width).toBeCloseTo(bounds.width - 2 * insetWorld);
    expect(out.height).toBeCloseTo(bounds.height - 2 * insetWorld);
  });

  it('an entity in the dead-zone band (near the edge) is NOT considered on-screen by the shrunk rect', () => {
    const worldPerPx = 1;
    const out: WorldBounds = { x: 0, y: 0, width: 0, height: 0 };
    getVisibleBoundsWithDeadZone(bounds, DEAD_ZONE_PX_DESKTOP, worldPerPx, out);
    // pixiY = 0 (centre row). x just inside the true right edge (399) but
    // within the dead-zone band → off-screen against the shrunk rect.
    const nearEdgeX = bounds.x + bounds.width - 1; // 399
    expect(isEntityOnScreen(nearEdgeX, 0, bounds)).toBe(true);
    expect(isEntityOnScreen(nearEdgeX, 0, out)).toBe(false);
  });

  it('never inverts the rect when the inset exceeds half the dimension', () => {
    const tiny: WorldBounds = { x: 0, y: 0, width: 10, height: 10 };
    const out: WorldBounds = { x: 0, y: 0, width: 0, height: 0 };
    getVisibleBoundsWithDeadZone(tiny, 100, 10, out); // huge inset
    expect(out.width).toBeGreaterThanOrEqual(0);
    expect(out.height).toBeGreaterThanOrEqual(0);
  });

  it('mobile dead-zone is smaller than desktop (ring + glyphs are smaller on touch)', () => {
    expect(DEAD_ZONE_PX_MOBILE).toBeLessThan(DEAD_ZONE_PX_DESKTOP);
  });
});
