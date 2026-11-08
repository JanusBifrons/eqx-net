/**
 * GPU-lit bakes (plan prancy-squishing-donut R2): a `lit` job keeps the unlit
 * maps (one 3-slice frame) instead of lit sun frames, and its stored copy
 * doesn't depend on the sun, so one bake serves every sector.
 */
import { describe, expect, it } from 'vitest';
import { bakeKey, isLitKey, runBake, SUN_STEPS } from './bake.js';
import { storeKey } from './bakeStore.js';
import { DEFAULT_RIG } from './shade.js';
import { LIT_GUTTER } from './litMaps.js';

describe('lit bakes', () => {
  it('a lit ship is one 3-slice frame with its map facts', () => {
    const baked = runBake({ type: 'ship', id: 'fighter', lit: true }, DEFAULT_RIG);
    const lit = baked.lit!;
    expect(baked.frames).toHaveLength(1);
    expect(baked.frames[0]!.w).toBe(3 * lit.w + 2 * LIT_GUTTER);
    expect(baked.frames[0]!.h).toBe(lit.h);
    expect(lit.maxH).toBeGreaterThan(0);
    expect(baked.nozzles.length).toBeGreaterThan(0);
    // Against today's 16 lit frames: about a fifth of the texels.
    const today = runBake({ type: 'ship', id: 'fighter' }, DEFAULT_RIG);
    expect(today.frames).toHaveLength(SUN_STEPS);
    const texels = (b: typeof baked): number => b.frames.reduce((n, f) => n + f.w * f.h, 0);
    expect(texels(baked) / texels(today)).toBeLessThan(0.21);
  });

  it('lit keys are marked, kept apart from baked ones, and stored without the sun', () => {
    const k = bakeKey({ type: 'ship', id: 'fighter', paint: 3, lit: true });
    expect(isLitKey(k)).toBe(true);
    expect(k).not.toBe(bakeKey({ type: 'ship', id: 'fighter', paint: 3 }));
    expect(isLitKey(bakeKey({ type: 'ship', id: 'fighter', paint: 3 }))).toBe(false);
    const other = { ...DEFAULT_RIG, sunAz: DEFAULT_RIG.sunAz + 1, sunElev: 0.2 };
    expect(storeKey(k, DEFAULT_RIG)).toBe(storeKey(k, other));
    const baked = bakeKey({ type: 'ship', id: 'fighter', paint: 3 });
    expect(storeKey(baked, DEFAULT_RIG)).not.toBe(storeKey(baked, other));
  });

  it("a structure's or rock's turn doesn't change its lit key (the mesh turns)", () => {
    expect(bakeKey({ type: 'struct', id: 'solar', seed: 1, rot: Math.PI / 2, lit: true }))
      .toBe(bakeKey({ type: 'struct', id: 'solar', seed: 1, rot: 0, lit: true }));
    expect(bakeKey({ type: 'rock', id: 'asteroid', entityId: 4, radius: 30, rot: 1.1, lit: true }))
      .toBe(bakeKey({ type: 'rock', id: 'asteroid', entityId: 4, radius: 30, rot: 0, lit: true }));
  });
});
