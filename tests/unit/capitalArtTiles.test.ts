/**
 * Capital-ship R&D round 3 E — capital hull art is tiled.
 *
 * A 10× battleship baked in one texture was capped at 1024 texels for a
 * 5.8 km hull (≈5× upscaled at the fly-by zoom). Capitals now bake up to
 * 3072 texels long, cut into tiles of at most TILE_MAX_SIDE, with only
 * CAPITAL_SUN_STEPS sun angles. Every other kind is unchanged (16 suns,
 * one texture each).
 */
import { describe, expect, it } from 'vitest';
import { CAPITAL_SUN_STEPS, SUN_STEPS, TILE_MAX_SIDE, bakeKey, runBake } from '../../src/client/render/art/bake';
import { DEFAULT_RIG } from '../../src/client/render/art/shade';

describe('capital hull art tiles', () => {
  it('a fighter bakes as before: 16 suns, untiled', () => {
    const b = runBake({ type: 'ship', id: 'fighter' }, DEFAULT_RIG);
    expect(b.tiles ?? 1).toBe(1);
    expect(b.frames.length).toBe(SUN_STEPS);
    expect(bakeKey({ type: 'ship', id: 'fighter' })).not.toContain(':T');
  });

  it('a battleship is tiled along the hull, 4 suns, each tile within 1024 texels, sharper than before', () => {
    const b = runBake({ type: 'ship', id: 'battleship' }, DEFAULT_RIG);
    const tiles = b.tiles ?? 1;
    expect(tiles).toBeGreaterThan(1);
    expect(b.frames.length).toBe(CAPITAL_SUN_STEPS * tiles);
    // The long axis is rows (the hull runs nose-to-stern down the frame).
    expect(b.h).toBeGreaterThan(b.w);
    let rows = 0;
    for (let t = 0; t < tiles; t++) {
      const f = b.frames[t]!;
      expect(f.w).toBe(b.w);
      expect(f.h).toBeLessThanOrEqual(TILE_MAX_SIDE);
      rows += f.h;
    }
    expect(rows).toBe(b.h);
    // ~3x the old 1024-texel cap along a 5.8 km hull.
    expect(b.h).toBeGreaterThan(2 * 1024);
    expect(bakeKey({ type: 'ship', id: 'battleship' })).toContain(':T');
    // Texture budget: measured 17.4 MB (2026-11-05; destroyer..battlecruiser 15-16 MB).
    let bytes = 0;
    for (const f of b.frames) bytes += f.w * f.h * 4;
    expect(bytes / 1048576).toBeLessThan(24);
  }, 60_000);
});
