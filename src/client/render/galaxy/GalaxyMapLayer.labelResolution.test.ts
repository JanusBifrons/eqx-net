import { describe, it, expect } from 'vitest';
import { MAP_LABEL_RESOLUTION } from './GalaxyMapLayer';

/**
 * WS-14 / R2.7 — "galaxy map looks low-res / blurry". The cluster is fractionally
 * downscaled to fit, and a Pixi `Text` is a baked texture, so the labels must be
 * OVERSAMPLED (resolution ≥ the device pixel ratio of common phones) to stay
 * crisp under the downscale. This guards against a regression that drops the
 * label resolution back to the renderer default (which softened the text). The
 * actual sharpness is a [V] on-device verdict; this locks the structural intent.
 */
describe('galaxy map label resolution (R2.7)', () => {
  it('oversamples the sector-label glyphs for a crisp downscale', () => {
    expect(MAP_LABEL_RESOLUTION).toBeGreaterThanOrEqual(2);
  });
});
