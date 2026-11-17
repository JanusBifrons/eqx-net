/**
 * Rock cut: a cut rock's pieces keep the uncut rock's look. With the field
 * layer each piece is one field-rock-shader mesh of its stretch of the rock
 * (no mask: a stencil mask per piece costs 3 draw calls); without it, an ice
 * or crystal rock's plain pieces stay ice or crystal (a coloured rock turning
 * grey when it breaks is a bug); every rock piece takes the far-zoom speck.
 * The rest-frame contract of the piece mesh: `field/placedRockMesh.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

// A GL program needs a canvas; node has none (the look is checked in stills).
vi.mock('../field/fieldRockShader', () => ({
  fieldRockProgram: () => ({}),
  fieldRockBatchProgram: () => ({}),
  fieldRockShaderResources: () => ({}),
  setFieldRockView: () => {},
  setFieldOreStyle: () => {},
}));
import { Container, Graphics } from 'pixi.js';
import { buildRockPieceArt, classicRockTint, rockPieceLook, rockPieceSpeckColor } from './rockPieceArt.js';
import { WreckPieceSprite, coolWreckInfo } from './wreckArt.js';
import { rebuildWreckPieces } from '../../net/wreckGeometryStore.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import { WRECK_ROCK_PARENT_KIND, type WreckDescriptor, type WreckRockRef } from '../../../shared-types/messages/wreckDescriptor.js';
import { CutFieldLayer, isFieldRockMesh } from '../field/CutFieldLayer.js';
import { RockBatchMember } from '../field/rockBatch.js';

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

describe('a cut rock piece keeps the rock look (rock cut)', () => {
  it('uses the uncut rock art key and classic tint', () => {
    expect(rockPieceLook(PLAIN)).toEqual({ resource: undefined, tint: 0xffffff });
    expect(rockPieceLook(ICE)).toEqual({ resource: 'ice', tint: classicRockTint('ice') });
    expect(rockPieceLook(CRYSTAL)).toEqual({ resource: 'crystal', tint: classicRockTint('crystal') });
  });

  it('a plain-look piece (no field layer) of an ice rock is ice, not grey', () => {
    const g = rebuildWreckPieces(desc(ICE))[0]!;
    const c = buildRockPieceArt(g, ICE);
    const art = c.children[0]!;
    expect(art).toBeInstanceOf(Graphics);
    expect(art.tint).toBe(0xa8dcff);
    expect(c.shaded).toBe(false);
    expect(buildRockPieceArt(g, PLAIN).children[0]!.tint).toBe(0xffffff);
  });

  it('with the field layer, each piece is one member of the rock batch, no mask, freed with the piece', () => {
    const layer = new CutFieldLayer();
    for (const g of rebuildWreckPieces(desc(CRYSTAL))) {
      const c = buildRockPieceArt(g, CRYSTAL, layer);
      expect(c.shaded).toBe(true);
      expect(c.children.length).toBe(1);
      const member = c.children[0]!;
      expect(member).toBeInstanceOf(RockBatchMember);
      expect(isFieldRockMesh(member)).toBe(true);
      for (const o of [c, ...c.children] as Container[]) expect(o.mask ?? null).toBeNull();
      const n = layer.rockBatch.count;
      c.destroy({ children: true });
      expect(layer.rockBatch.count).toBe(n - 1);
    }
  });

  it('a plain-look piece draws its own outline, no mask', () => {
    const g = rebuildWreckPieces(desc(ICE))[0]!;
    const c = buildRockPieceArt(g, ICE);
    for (const o of [c, ...c.children] as Container[]) expect(o.mask ?? null).toBeNull();
    expect(c.children.length).toBe(1);
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
