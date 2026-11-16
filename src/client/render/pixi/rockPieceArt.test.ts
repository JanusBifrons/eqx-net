/**
 * Rock cut: a cut rock's pieces keep the uncut rock's look. An ice or
 * crystal rock's pieces stay ice or crystal (a coloured rock turning grey
 * when it breaks is a bug); once the rock's Machined bake is ready each
 * piece draws its own stretch of it as one batchable mesh (no mask: a stencil
 * mask per piece costs 3 draw calls); and every rock piece takes the
 * far-zoom speck.
 */
import { describe, expect, it } from 'vitest';
import { Container, Graphics, Mesh, MeshGeometry, Texture, TextureSource } from 'pixi.js';
import { buildRockPieceArt, classicRockTint, rockPieceLook, rockPieceSpeckColor } from './rockPieceArt.js';
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

  it('a ready Machined rock bake is drawn on the piece, and its geometry is freed with it', () => {
    const g = rebuildWreckPieces(desc(CRYSTAL))[0]!;
    const c = buildRockPieceArt(g, CRYSTAL, ready);
    const mesh = c.children[0] as Mesh;
    expect(mesh).toBeInstanceOf(Mesh);
    expect(mesh.texture).toBe(struct.tex);
    expect(c.struct).toBe(struct);
    const geo = c.geom!;
    expect(geo).toBe(mesh.geometry);
    let freed = false;
    geo.once('destroy', () => { freed = true; });
    c.destroy({ children: true });
    expect(freed).toBe(true);
  });

  it('a baked piece is one batchable Mesh of its outline on the rock texture, UVs at its spot in the rock, no mask', () => {
    // A 64x48 rock bake at 2 texels per world unit (a 32x24 u rock).
    const tex = new Texture({ source: new TextureSource({ width: 64, height: 48 }) });
    const bake: StructArt = { tex, albedo: tex, w: 64, h: 48, density: 2, navLights: [] };
    const h = { state: 'ready', struct: bake, ship: null } as unknown as ArtHandle;
    for (const g of rebuildWreckPieces(desc(CRYSTAL))) {
      const c = buildRockPieceArt(g, CRYSTAL, h);
      for (const o of [c, ...c.children] as Container[]) expect(o.mask ?? null).toBeNull();
      expect(c.children.some((o) => o instanceof Graphics)).toBe(false);
      expect(c.children.length).toBe(1);
      const mesh = c.children[0] as Mesh;
      expect(mesh).toBeInstanceOf(Mesh);
      expect(mesh.texture).toBe(tex);
      const geo = mesh.geometry as MeshGeometry;
      expect(geo.batchMode).toBe('batch');
      const pos = geo.positions, uv = geo.uvs;
      expect(pos.length).toBe(uv.length);
      // Every vertex samples the rock texture where that point of the rock
      // was: rock-centred Pixi-down (x + cx, y - cy) * density + size / 2.
      const ox = mesh.position.x, oy = mesh.position.y;
      for (let i = 0; i < pos.length; i += 2) {
        expect(uv[i]! * 64).toBeCloseTo((pos[i]! + ox + g.cx) * 2 + 32, 4);
        expect(uv[i + 1]! * 48).toBeCloseTo((pos[i + 1]! + oy - g.cy) * 2 + 24, 4);
      }
      // The mesh covers the piece outline: every outline vertex is a mesh vertex.
      for (const v of g.outline) {
        let hit = false;
        for (let i = 0; i < pos.length; i += 2) {
          if (Math.abs(pos[i]! + ox - v.x) < 1e-4 && Math.abs(pos[i + 1]! + oy + v.y) < 1e-4) hit = true;
        }
        expect(hit).toBe(true);
      }
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
