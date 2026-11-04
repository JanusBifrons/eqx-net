/**
 * FX_VERSION lock (plan iridescent-seeking-rainbow v3, B1).
 *
 * Effect textures are cached on players' devices under FX_VERSION. If any
 * generator's output changes without a version bump, players keep the old
 * textures. When this fails: bump FX_VERSION in fxTextures.ts AND update the
 * recorded hash below, in the same change.
 */
import { describe, it, expect } from 'vitest';
import { FX_VERSION, bakeFxImg, FX_SPECS, type FxId } from './fxTextures.js';

function hashBytes(h: number, b: Uint8ClampedArray): number {
  for (let i = 0; i < b.length; i += 7) h = Math.imul(h ^ b[i]!, 16777619);
  return h;
}

describe('FX_VERSION lock', () => {
  it('reference bakes match the hash recorded for this FX_VERSION', () => {
    // A cheap subset that still covers every generator family.
    const ids: FxId[] = ['glow', 'streak', 'ring', 'spark', 'smoke', 'trail', 'shieldContact', 'spikeStar', 'galaxy', 'sun', 'planet'];
    let h = 2166136261;
    for (const id of ids) {
      expect(FX_SPECS[id]).toBeDefined();
      h = hashBytes(h, bakeFxImg(id, undefined, 7, -0.6).data);
    }
    expect({ version: FX_VERSION, hash: (h >>> 0).toString(16) }).toEqual({ version: 'fx2', hash: '7e748caf' });
  });
});
