/**
 * Showcase review (2026-11-12, `capital-guns-fighter`): "the shadows cast
 * from the cruiser to the battleship is just fundamentally wrong... Arguably
 * capitals don't cast shadows on each other might be the easiest fix."
 *
 * Rule: a capital hull (and the guns on it) takes no occluder that is another
 * capital: no shadow, no occlusion darkening, no bounce from it. Everything
 * else is unchanged: a capital still shades a fighter beside it, and a big
 * non-capital occluder still shades a capital.
 */
import { describe, expect, it, vi } from 'vitest';
import { Container, GlProgram, Texture } from 'pixi.js';
import { LitPass } from './litPass.js';
import { LitShipMesh, occluderShades, type LitTile } from './litShipShader.js';
import { ALL_ON } from './lightingSettings.js';
import { DEFAULT_RIG } from './shade.js';
import { MachinedShipSprite } from './MachinedShipSprite.js';
import { litPass } from './litPass.js';
import { buildArtShipSprite } from './shipArtSprites.js';
import type { ArtHandle, ShipArt } from './ArtService.js';
import { isCapitalKindId } from './capitalKind.js';

// Compiling the GLSL needs a WebGL context (none under Node).
vi.spyOn(GlProgram, 'from').mockImplementation(() => ({}) as GlProgram);

function tile(): LitTile {
  return { tex: Texture.WHITE, w: 1, rows: 1, y0: 0, hullH: 1, ppu: 1, maxH: 1, emisMax: 1 };
}

/** Occluder slots a mesh took last frame (`uOccSize[i].z > 0`). */
function occludersTaken(m: LitShipMesh): number {
  const S = (m.shader!.resources['litUniforms'] as { uniforms: Record<string, Float32Array> }).uniforms['uOccSize']!;
  let n = 0;
  for (let i = 0; i < S.length / 4; i++) if (S[i * 4 + 2]! > 0) n++;
  return n;
}

/** A hull at (x, 0) under `world`; `occ` = it casts as a box. */
function hull(pass: LitPass, world: Container, x: number, id: number, capital: boolean, occ: boolean): LitShipMesh {
  const c = new Container(); c.position.set(x, 0); world.addChild(c);
  const m = new LitShipMesh(tile(), ALL_ON);
  m.capitalHull = capital;
  if (occ) m.occluderId = id;
  c.addChild(m);
  pass.register(m, occ ? { hx: 40, hy: 600, h: 140, color: 0x9aa4b0, capital } : null);
  return m;
}

describe('capital shadows', () => {
  it('the pair rule: only capital onto capital is dropped', () => {
    expect(occluderShades(true, true)).toBe(false);
    expect(occluderShades(false, true)).toBe(true);
    expect(occluderShades(true, false)).toBe(true);
    expect(occluderShades(false, false)).toBe(true);
  });

  it('a heavy cruiser beside a battleship: neither shades the other; a fighter still takes both', () => {
    const pass = new LitPass();
    const world = new Container();
    const bs = hull(pass, world, 0, 1, true, true);
    const ca = hull(pass, world, 300, 2, true, true);
    const fighter = hull(pass, world, 150, -1, false, false);
    pass.begin();
    pass.finish(world, DEFAULT_RIG);
    expect(pass.scene.occluderCount).toBe(2); // both still cast (onto non-capitals)
    expect(occludersTaken(bs)).toBe(0);
    expect(occludersTaken(ca)).toBe(0);
    expect(occludersTaken(fighter)).toBe(2);
  });

  it('a capital still takes a big non-capital occluder', () => {
    const pass = new LitPass();
    const world = new Container();
    const bs = hull(pass, world, 0, 1, true, true);
    hull(pass, world, 300, 2, false, true);
    pass.begin();
    pass.finish(world, DEFAULT_RIG);
    expect(occludersTaken(bs)).toBe(1);
  });

  it('the capital flag comes from the ship kind (sizeClass), not the art size', () => {
    expect(isCapitalKindId('battleship')).toBe(true);
    expect(isCapitalKindId('heavy-cruiser')).toBe(true);
    expect(isCapitalKindId('fighter')).toBe(false);
    expect(isCapitalKindId('crossguard')).toBe(false); // big, but not a capital
    expect(isCapitalKindId('no-such-kind')).toBe(false);
  });

  it('a capital ship sprite marks its tiles and its occluder as capital', () => {
    const prev = litPass.settings;
    litPass.settings = ALL_ON;
    try {
      const art: ShipArt = {
        frames: [Texture.WHITE, Texture.WHITE], w: 80, h: 2400, tiles: 2, tileH: 1200, density: 1, nozzles: [], navLights: [],
        lit: { w: 80, h: 2400, ppu: 1, maxH: 10, emisMax: 1 } as ShipArt['lit'],
      };
      const handle = (id: string): ArtHandle => ({ state: 'ready', ship: art, job: { type: 'ship', id } }) as unknown as ArtHandle;
      const cap = buildArtShipSprite(handle('battleship'), () => new Container()) as MachinedShipSprite;
      const fig = buildArtShipSprite(handle('crossguard'), () => new Container()) as MachinedShipSprite;
      expect(cap.capital).toBe(true);
      expect(cap.lit.every((m) => m.capitalHull)).toBe(true);
      expect(fig.capital).toBe(false);
      expect(fig.lit.some((m) => m.capitalHull)).toBe(false);
      cap.destroy({ children: true }); fig.destroy({ children: true });
    } finally {
      litPass.settings = prev;
    }
  });
});
