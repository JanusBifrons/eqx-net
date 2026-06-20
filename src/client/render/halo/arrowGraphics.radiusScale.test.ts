/**
 * WS-B PR2 (#3) — mobile glyph radius scaling unit lock.
 *
 * GLYPH_RADIUS (7) / GLYPH_RADIUS_GROUPED (9) are fixed screen px. On a
 * phone (smaller screen, smaller ring) the markers read too large, so on a
 * touch device the glyph radius scales to ~0.65× of the desktop size. The
 * pure `haloGlyphRadius(grouped, isTouch)` helper is the single source for
 * that scaling, consumed by `paintHaloGlyph` / `buildHaloGlyph`.
 */
import { describe, it, expect } from 'vitest';
import {
  haloGlyphRadius,
  GLYPH_RADIUS,
  GLYPH_RADIUS_GROUPED,
  HALO_GLYPH_TOUCH_SCALE,
} from './arrowGraphics.js';

describe('haloGlyphRadius (WS-B #3 mobile scaling)', () => {
  it('returns the full desktop radius when not on touch', () => {
    expect(haloGlyphRadius(false, false)).toBeCloseTo(GLYPH_RADIUS);
    expect(haloGlyphRadius(true, false)).toBeCloseTo(GLYPH_RADIUS_GROUPED);
  });

  it('scales the radius down on touch', () => {
    expect(haloGlyphRadius(false, true)).toBeCloseTo(GLYPH_RADIUS * HALO_GLYPH_TOUCH_SCALE);
    expect(haloGlyphRadius(true, true)).toBeCloseTo(GLYPH_RADIUS_GROUPED * HALO_GLYPH_TOUCH_SCALE);
  });

  it('touch glyph is 60-70% of the desktop glyph (per the WS-B brief)', () => {
    const ratio = haloGlyphRadius(false, true) / haloGlyphRadius(false, false);
    expect(ratio).toBeGreaterThanOrEqual(0.6);
    expect(ratio).toBeLessThanOrEqual(0.7);
  });

  it('grouped is always larger than singleton at the same device class', () => {
    expect(haloGlyphRadius(true, false)).toBeGreaterThan(haloGlyphRadius(false, false));
    expect(haloGlyphRadius(true, true)).toBeGreaterThan(haloGlyphRadius(false, true));
  });
});
