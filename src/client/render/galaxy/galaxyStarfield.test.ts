import { describe, it, expect } from 'vitest';
import {
  GALAXY_STAR_LAYERS,
  starHash,
  starLayerAlphaAt,
  starRadiusAt,
  type GalaxyStarLayer,
} from './galaxyStarfield';

const L: GalaxyStarLayer = {
  parallax: 0.1,
  tileSize: 500,
  starsPerTile: 3,
  radius: 1.5,
  color: 0xffffff,
  baseAlpha: 0.8,
  seed: 7,
  fadeInAt: 0.2,
  fullAt: 0.4,
  dimAt: 1.0,
  fadedAt: 1.6,
};

describe('starLayerAlphaAt', () => {
  it('is 0 at/below fadeInAt and at/above fadedAt (outside the window)', () => {
    expect(starLayerAlphaAt(L, 0.2)).toBe(0);
    expect(starLayerAlphaAt(L, 0.1)).toBe(0);
    expect(starLayerAlphaAt(L, 1.6)).toBe(0);
    expect(starLayerAlphaAt(L, 2.0)).toBe(0);
  });

  it('reaches baseAlpha in the full plateau (fullAt..dimAt)', () => {
    expect(starLayerAlphaAt(L, 0.4)).toBeCloseTo(L.baseAlpha, 6);
    expect(starLayerAlphaAt(L, 0.7)).toBeCloseTo(L.baseAlpha, 6);
    expect(starLayerAlphaAt(L, 1.0)).toBeCloseTo(L.baseAlpha, 6);
  });

  it('ramps up monotonically across fade-in and down across fade-out', () => {
    expect(starLayerAlphaAt(L, 0.25)).toBeLessThan(starLayerAlphaAt(L, 0.35));
    expect(starLayerAlphaAt(L, 0.35)).toBeLessThan(starLayerAlphaAt(L, 0.4));
    expect(starLayerAlphaAt(L, 1.5)).toBeLessThan(starLayerAlphaAt(L, 1.1));
    // Mid fade-in is a partial alpha (between 0 and baseAlpha).
    const mid = starLayerAlphaAt(L, 0.3);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(L.baseAlpha);
  });
});

describe('GALAXY_STAR_LAYERS coverage', () => {
  it('keeps at least one layer visible across the whole galaxy zoom range (0.12–4)', () => {
    // The pan/zoom Camera clamps clusterRoot.scale to [0.12, 4]; the starfield
    // must never go completely empty inside that band.
    for (let scale = 0.12; scale <= 4.0001; scale += 0.04) {
      const total = GALAXY_STAR_LAYERS.reduce((a, l) => a + starLayerAlphaAt(l, scale), 0);
      expect(total, `no star layer visible at scale ${scale.toFixed(2)}`).toBeGreaterThan(0);
    }
  });
});

describe('starHash', () => {
  it('is deterministic and in [0, 1)', () => {
    for (let a = -5; a <= 5; a++) {
      for (let b = -5; b <= 5; b++) {
        const v = starHash(a, b, 13, 1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
        expect(starHash(a, b, 13, 1)).toBe(v); // stable
      }
    }
  });

  it('decorrelates adjacent inputs (different cells → different values)', () => {
    expect(starHash(0, 0, 7, 0)).not.toBe(starHash(1, 0, 7, 0));
    expect(starHash(0, 0, 7, 0)).not.toBe(starHash(0, 1, 7, 0));
    expect(starHash(0, 0, 7, 0)).not.toBe(starHash(0, 0, 7, 1));
  });
});

describe('starRadiusAt', () => {
  it('spans 0.5×–1.3× the base radius and is monotonic in the hash', () => {
    expect(starRadiusAt(L, 0)).toBeCloseTo(L.radius * 0.5, 6); // floor (no sub-pixel vanish)
    expect(starRadiusAt(L, 1)).toBeCloseTo(L.radius * 1.3, 6); // ceiling (no chunky dots)
    expect(starRadiusAt(L, 0.3)).toBeLessThan(starRadiusAt(L, 0.7));
  });

  it('biases toward small (most stars are fine dust)', () => {
    // h² weighting ⇒ the midpoint hash maps below the mid-radius, so the bulk of
    // the [0,1) hash range lands near the floor — fine dust, a few highlights.
    const mid = starRadiusAt(L, 0.5);
    const range = L.radius * 1.3 - L.radius * 0.5;
    expect(mid).toBeLessThan(L.radius * 0.5 + range * 0.5);
  });
});
