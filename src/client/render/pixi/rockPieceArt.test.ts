/**
 * Rock cut: a cut rock's pieces keep the uncut rock's look. An ice or
 * crystal rock's pieces stay ice or crystal (a coloured rock turning grey
 * when it breaks is a bug); once the rock's Machined bake is ready the
 * pieces draw it, masked to each piece; and every rock piece (its art is
 * masked, so it never batches) takes the far-zoom speck.
 */
import { describe, expect, it } from 'vitest';
import { Graphics, Texture } from 'pixi.js';
import { buildRockPieceArt, classicRockTint, rockPieceLook, rockPieceSpeckColor } from './rockPieceArt.js';
import { MachinedFlatSprite } from '../art/MachinedFlatSprite.js';
import { WreckPieceSprite, coolWreckInfo } from './wreckArt.js';
import { rebuildWreckPieces } from '../../net/wreckGeometryStore.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import { WRECK_ROCK_PARENT_KIND, type WreckDescriptor, type WreckRockRef } from '../../../shared-types/messages/wreckDescriptor.js';
import type { ArtHandle, StructArt } from '../art/ArtService.js';

const PLAIN: WreckRockRef = { id: 'rock-17', shape: 4242, r: 60 };
const ICE: WreckRockRef = { ...PLAIN, res: 'ice' };
const CRYSTAL: WreckRockRef = { ...PLAIN, res: 'crystal' };

function desc(rock: WreckRockRef): WreckDescriptor {
  return {
    wreckId: 9, parentKind: WRECK_ROCK_PARENT_KIND, seed: 1234, killX: 5, killY: -8,
    killBlowDamage: 0, recentDamageRate: 0, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION,
    deathTick: 1, rock, cutKind: 'slice', cutAng: 0.3,
  };
}

const struct: StructArt = { tex: Texture.WHITE, albedo: Texture.WHITE, w: 32, h: 32, density: 2, navLights: [] };
const ready = { state: 'ready', struct, ship: null } as unknown as ArtHandle;
const pending = { state: 'pending', struct: null, ship: null } as unknown as ArtHandle;

describe('a cut rock piece keeps the rock look (rock cut)', () => {
  it('uses the uncut rock art key and classic tint', () => {
    expect(rockPieceLook(PLAIN)).toEqual({ resource: undefined, tint: 0xffffff });
    expect(rockPieceLook(ICE)).toEqual({ resource: 'ice', tint: classicRockTint('ice') });
    expect(rockPieceLook(CRYSTAL)).toEqual({ resource: 'crystal', tint: classicRockTint('crystal') });
  });

  it('a plain-look piece of an ice rock is ice, not grey', () => {
    const g = rebuildWreckPieces(desc(ICE))[0]!;
    for (const h of [null, pending]) {
      const c = buildRockPieceArt(g, ICE, h);
      const art = c.children[0]!;
      expect(art).toBeInstanceOf(Graphics);
      expect(art.tint).toBe(0xa8dcff);
      expect(c.struct).toBeNull();
    }
    expect(buildRockPieceArt(g, PLAIN).children[0]!.tint).toBe(0xffffff);
  });

  it('a ready Machined rock bake is drawn, masked to the piece', () => {
    const g = rebuildWreckPieces(desc(CRYSTAL))[0]!;
    const c = buildRockPieceArt(g, CRYSTAL, ready);
    const [art, mask] = c.children as [MachinedFlatSprite, Graphics];
    expect(art).toBeInstanceOf(MachinedFlatSprite);
    expect(art.art).toBe(struct);
    expect(art.mask).toBe(mask);
    expect(c.struct).toBe(struct);
    expect(art.position.x).toBeCloseTo(-g.cx);
    expect(art.position.y).toBeCloseTo(g.cy);
  });

  it('every rock piece takes the far-zoom speck, in the rock colour', () => {
    const d = desc(ICE);
    const g = rebuildWreckPieces(d)[0]!;
    const p = new WreckPieceSprite(g, WRECK_ROCK_PARENT_KIND, null, coolWreckInfo(d), 0, buildRockPieceArt(g, ICE));
    p.setFarZoom(1e-4);
    expect(p.farZoom).toBe(true);
    p.setFarZoom(1);
    expect(p.farZoom).toBe(false);
    expect(rockPieceSpeckColor(ICE)).not.toBe(rockPieceSpeckColor(PLAIN));
  });
});
