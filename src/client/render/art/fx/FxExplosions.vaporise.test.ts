/**
 * The vaporise variant of the death explosion (fracture v11): the hull was
 * burned away by a heavy beam or railgun slug, so no fireball and no dark
 * smoke: a weapon-tinted flash, a short expanding glow and ring, glowing
 * motes, over in the profile's `vaporiseSeconds`. Same pool as every burst.
 */
import { describe, expect, it } from 'vitest';
import { Sprite, Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { FxExplosions } from './FxExplosions.js';

function fakeArt(): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
    fx: { tex: Texture.WHITE, frames: Array.from({ length: 16 }, () => Texture.WHITE), w: 1, h: 1 } });
  return { fx: () => h() } as unknown as ArtService;
}

const TINT = 0xc8a8ff;

describe('FxExplosions.spawnVaporise', () => {
  it('a flash in the weapon tint, no fireball, no smoke; gone after its seconds', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    expect(fx.spawnVaporise(0, 0, 40, 1000, TINT, 0.7)).toBe(true);
    fx.tick(1050);
    const fire = fx.fireLayer.children as Sprite[];
    const lit = fire.filter((c) => c.visible);
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.some((s) => s.tint === TINT), 'tinted by the weapon').toBe(true);
    // No fireball flipbook frames: every lit sprite is the flash, ring or a mote.
    fx.tick(1400);
    expect(fx.smokeLayer.children.every((c) => !c.visible), 'no dark smoke').toBe(true);
    fx.tick(1000 + 700);
    expect(fx.activeCount()).toBe(0);
    expect(fire.every((c) => !c.visible)).toBe(true);
  });

  it('the glow expands over the burst', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    fx.spawnVaporise(0, 0, 40, 1000, TINT, 0.7);
    fx.tick(1020);
    const glow = (fx.overLayer.children as Sprite[]).find((s) => s.visible && s.tint === TINT)!;
    const early = glow.scale.x;
    fx.tick(1300);
    expect(glow.scale.x).toBeGreaterThan(early);
  });

  it('a pooled burst reused for a normal blast gets its fire colours back', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    fx.spawnVaporise(0, 0, 40, 1000, TINT, 0.7);
    fx.tick(1800); // freed
    fx.spawn(0, 0, 40, 2000);
    fx.tick(2010);
    const lit = (fx.fireLayer.children as Sprite[]).filter((c) => c.visible);
    expect(lit.some((s) => s.tint === TINT)).toBe(false);
  });

  it('fewer motes on a lower effects tier', () => {
    const count = (q: string): number => {
      const fx = new FxExplosions(fakeArt(), () => q);
      fx.spawnVaporise(0, 0, 40, 1000, TINT, 0.7);
      fx.tick(1050);
      return fx.fireLayer.children.filter((c) => c.visible).length;
    };
    expect(count('low')).toBeLessThan(count('high'));
  });
});

/**
 * Filmed (beam-vaporise-subcap v10, hostile review "Is the violet vaporise
 * flash visible? NO"): the flash drew in `fireLayer`, UNDER the heavy beam's
 * containers, at R x 1.6 wide on the glow texture (its visible core is ~a
 * third of its half-width), so a ~28 u blast showed a ~10 u dot under a 60 u
 * beam; the ring started at 0.3 R and only read ~130 ms later. The vaporise
 * flash, glow and ring now draw in `overLayer` (stacked above the beams),
 * full strength on the first frame.
 */
describe('FxExplosions.spawnVaporise reads on the kill frame', () => {
  const vapSprites = (fx: FxExplosions): Sprite[] => (fx.overLayer.children as Sprite[]).filter((s) => s.visible);

  it('the flash is in the over-the-beams layer, bright and wide on the first frame', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    const r = 77;
    fx.spawnVaporise(0, 0, r, 1000, TINT, 0.7);
    fx.tick(1000);
    const lit = vapSprites(fx);
    expect(lit.length, 'flash / glow / ring drawn above the beams').toBeGreaterThanOrEqual(2);
    const widest = Math.max(...lit.map((s) => s.width / 2));
    expect(widest, 'flash half-width (glow texture: visible core ~1/3 of it)').toBeGreaterThanOrEqual(r * 2);
    expect(Math.max(...lit.map((s) => s.alpha)), 'full strength at once').toBeGreaterThanOrEqual(0.85);
  });

  it('the ring shows on the first frame, already hull-sized', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    fx.spawnVaporise(0, 0, 60, 1000, TINT, 0.7);
    fx.tick(1016);
    const ring = vapSprites(fx).filter((s) => s.alpha >= 0.6);
    expect(ring.length).toBeGreaterThan(0);
  });

  it('a normal blast draws nothing above the beams', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    fx.spawn(0, 0, 60, 1000);
    fx.tick(1016);
    expect(vapSprites(fx).length).toBe(0);
  });

  it('the whole vaporise is gone in its seconds, over layer included', () => {
    const fx = new FxExplosions(fakeArt(), () => 'high');
    fx.spawnVaporise(0, 0, 60, 1000, TINT, 0.7);
    fx.tick(1300);
    expect(vapSprites(fx).length).toBeGreaterThan(0);
    fx.tick(1700);
    expect(vapSprites(fx).length).toBe(0);
    expect(fx.activeCount()).toBe(0);
  });
});
