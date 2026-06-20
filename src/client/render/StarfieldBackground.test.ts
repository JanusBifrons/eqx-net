import { describe, it, expect } from 'vitest';
import { GAMEPLAY_STAR_LAYERS } from './StarfieldBackground';
import { starLayerAlphaAt, starRadiusAt } from './lodStarfield';

// The gameplay camera clamps zoom to [0.15, 3] — PixiRenderer overrides the
// Camera default (0.4/4) with minScale 0.15 / maxScale 3. The field must never
// be blank anywhere in this real range (the 2026-06-19 "blank when fully zoomed
// out" report was layers tuned for 0.4 while the floor is actually 0.15).
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;

describe('GAMEPLAY_STAR_LAYERS — zoom-aware LOD coverage', () => {
  it('keeps ≥1 layer visible at EVERY zoom across the gameplay range (never a blank field)', () => {
    for (let s = MIN_ZOOM; s <= MAX_ZOOM + 1e-9; s += 0.1) {
      const total = GAMEPLAY_STAR_LAYERS.reduce((a, l) => a + starLayerAlphaAt(l, s), 0);
      expect(total).toBeGreaterThan(0);
    }
  });

  it('RESPONDS to zoom — the visible layer set changes between zoomed-out and zoomed-in', () => {
    // The whole point of the fix: the old fixed field ignored zoom entirely.
    // Different layers carry the field at the extremes ⇒ a real LOD cross-fade.
    const visibleAt = (s: number) =>
      GAMEPLAY_STAR_LAYERS.map((l) => starLayerAlphaAt(l, s) > 0).join(',');
    const out = visibleAt(MIN_ZOOM);
    const inn = visibleAt(MAX_ZOOM);
    expect(out).not.toBe(inn);
    // The far/overview layer (index 0) is visible zoomed OUT and gone zoomed IN;
    // the closest-dust layer (last) is the reverse.
    expect(starLayerAlphaAt(GAMEPLAY_STAR_LAYERS[0]!, MIN_ZOOM)).toBeGreaterThan(0);
    expect(starLayerAlphaAt(GAMEPLAY_STAR_LAYERS[0]!, MAX_ZOOM)).toBe(0);
    const last = GAMEPLAY_STAR_LAYERS[GAMEPLAY_STAR_LAYERS.length - 1]!;
    expect(starLayerAlphaAt(last, MIN_ZOOM)).toBe(0);
    expect(starLayerAlphaAt(last, MAX_ZOOM)).toBeGreaterThan(0);
  });

  it('each layer ramps its alpha in (low end) and out (high end)', () => {
    for (const l of GAMEPLAY_STAR_LAYERS) {
      // 0 below the window, climbs through fadeIn→full, falls through dim→faded.
      expect(starLayerAlphaAt(l, l.fadeInAt)).toBe(0);
      expect(starLayerAlphaAt(l, (l.fadeInAt + l.fullAt) / 2)).toBeGreaterThan(0);
      expect(starLayerAlphaAt(l, (l.fullAt + l.dimAt) / 2)).toBeCloseTo(l.baseAlpha, 5);
      expect(starLayerAlphaAt(l, l.fadedAt)).toBe(0);
    }
  });

  it('#11 — the farthest layer is at FULL coverage by the zoom-out floor (not a partial fade)', () => {
    // The bug: at max zoom-out (scale === MIN_ZOOM = 0.15) the far/overview layer
    // was still ramping in (fullAt 0.18 > 0.15), so coverage was only ~83% of
    // baseAlpha — the field looked thin/sparse fully zoomed out. The farthest
    // layer's `fullAt` must be <= the camera minScale floor so it carries FULL
    // alpha at (and below) the floor.
    const far = GAMEPLAY_STAR_LAYERS[0]!;
    expect(far.fullAt).toBeLessThanOrEqual(MIN_ZOOM);
    expect(starLayerAlphaAt(far, MIN_ZOOM)).toBeCloseTo(far.baseAlpha, 6);
  });

  it('keeps stars SMALL — no chunky "in front of the gameplay" dots', () => {
    // The old near layer rendered constant 2-px dots that read as foreground
    // stars. Every gameplay layer's max drawn radius stays ≤ ~1.3 px.
    for (const l of GAMEPLAY_STAR_LAYERS) {
      expect(l.radius).toBeLessThanOrEqual(1.0);
      expect(starRadiusAt(l, 1)).toBeLessThanOrEqual(1.3); // brightest star
    }
  });
});
