/**
 * Lit deck (`?deckLit=on`, .resume/deck-lit-plan.md slice 2) — the lit deck
 * plates. Locks: flag off builds nothing new (today's floor exactly); the lit
 * hex art is the vector plate's own geometry plus the seam grooves, on the
 * `struct` bake (keyed apart per role and variant, fits one atlas frame); the
 * zoom swap has hysteresis and hides with `renderable`, never destroying;
 * off-screen plates are culled; a plate leaving the floor frees its sprites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container, GlProgram, Graphics, Texture, TextureSource } from 'pixi.js';
import type { DeckPlatesMirror } from '../../../core/contracts/IRenderer.js';
import type { ArtHandle, ArtService, StructArt } from '../art/ArtService.js';
import type { ShipArtCtx } from '../art/shipArtSprites.js';
import { bakeKey, DECK_LIT_PPU } from '../art/bake.js';
import { forgeStructure } from '../art/fields.js';
import { LIT_GUTTER } from '../art/litMaps.js';
import { litPass } from '../art/litPass.js';
import { LOOK_NIGHT } from '../art/lightingSettings.js';
import { MachinedFlatSprite } from '../art/MachinedFlatSprite.js';
import { DECK_UNDER_Z, StructureDeckPlates, deckPlateContext, deckPlateOutlineContext } from './structureDeckPlates.js';
import { DECK_ZONE_Z } from './structureDeckZones.js';
import { DECK_LIT_FAR_SCALE, DECK_LIT_Z, StructureDeckLit, deckLitShown } from './structureDeckLit.js';
import { DECK_LIT_FILL, DECK_PLATE_HEX_BOX, deckLitArtId, deckLitPaintContext, deckLitVisual } from './structureDeckLitArt.js';
import { deckHexPolys, deckPlatePick, deckStyleCtx } from './structureDeckTexture.js';
import { ngon } from './structureStyleKit.js';
import { HEX_DIRS } from '../../../core/hex/hex.js';
import { DECK_HEX_SIZE } from '../../../core/hex/plates.js';
import { DECK_FILL } from './structureDeckPlates.js';
import { ROAD_LANE } from './structureStyleC.transport.road.js';

// Compiling the lit GLSL needs a WebGL context (none under Node).
vi.spyOn(GlProgram, 'from').mockImplementation(() => ({}) as GlProgram);

function mirrorOf(version: number, plates: Array<[number, number]>): DeckPlatesMirror {
  const ij = new Int32Array(Math.max(2, plates.length * 2));
  plates.forEach(([i, j], n) => { ij[2 * n] = i; ij[2 * n + 1] = j; });
  return { version, count: plates.length, ij, deck: true } as DeckPlatesMirror;
}

const litArt = (): StructArt => ({
  tex: new Texture({ source: new TextureSource({ width: 3 * 300 + 2 * LIT_GUTTER, height: 340 }) }),
  albedo: Texture.WHITE, w: 712, h: 810, density: DECK_LIT_PPU, navLights: [],
  lit: { w: 300, h: 340, ppu: DECK_LIT_PPU, maxH: 6, emisMax: 0 },
});

/** An art ctx whose `struct()` hands back ready lit art and counts the asks. */
function fakeArt(): { actx: ShipArtCtx; asks: string[] } {
  const asks: string[] = [];
  const art = {
    struct: (id: string, seed: number): ArtHandle => {
      asks.push(`${id}#${seed}`);
      return { key: `${id}#${seed}`, job: { type: 'struct', id, seed }, rig: {} as ArtHandle['rig'], state: 'ready', ship: null, struct: litArt() };
    },
  } as unknown as ArtService;
  return { actx: { art, handles: new Map(), sunAz: 0, deckLit: true }, asks };
}

const litRoots = (c: Container): Container[] => c.children.filter((ch) => ch.label === 'deckLit') as Container[];

describe('lit deck art — one geometry source', () => {
  it('the lit hex is the vector hex\x27s polygons (wear left to grime) plus 6 seam grooves', () => {
    for (const role of ['ring', 'yard'] as const) {
      for (let v = 0; v < 3; v++) {
        const plan = deckLitVisual(deckLitArtId('a', role), v + 1);
        const c = deckStyleCtx(ngon(0, 0, 2000, 6), v + 1);
        const cs: Array<[number, number]> = [];
        for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + (k * Math.PI) / 3; cs.push([DECK_HEX_SIZE * Math.cos(a), -DECK_HEX_SIZE * Math.sin(a)]); }
        const d = role === 'yard' ? { q: 0, r: 0 } : HEX_DIRS[0]!;
        deckHexPolys(c, 'a', v, [0, 0], cs, DECK_HEX_SIZE, d.q, d.r, DECK_LIT_FILL, 'floor');
        const solid = c.polys.filter((p) => (p.alpha ?? 1) >= 1).length;
        expect(plan.polys!.length).toBe(solid + 6);
        expect(plan.polys!.every((p) => (p.alpha ?? 1) >= 1)).toBe(true);
        expect(plan.polys!.some((p) => (p.lift ?? 0) < 0)).toBe(true); // grooves sink
        expect(plan.footprint).toEqual({ w: DECK_PLATE_HEX_BOX.w, h: DECK_PLATE_HEX_BOX.h });
      }
    }
  });

  it('paint stays out of the lit bake: no paint polys, the yard bakes like a plain floor hex', () => {
    for (let v = 0; v < 3; v++) {
      for (const role of ['ring', 'yard'] as const) {
        expect(deckLitVisual(deckLitArtId('a', role), v + 1).polys!.some((p) => p.mat === 'paint')).toBe(false);
      }
    }
  });

  it('one geometry source: all = floor then paint, in order; paint is the yard only', () => {
    const cs: Array<[number, number]> = [];
    for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + (k * Math.PI) / 3; cs.push([DECK_HEX_SIZE * Math.cos(a), -DECK_HEX_SIZE * Math.sin(a)]); }
    for (const tex of ['a', 'b'] as const) {
      for (const [q, r] of [[0, 0], [1, 0]] as const) {
        const run = (part: 'all' | 'floor' | 'paint') => {
          const c = deckStyleCtx(ngon(0, 0, 2000, 6));
          deckHexPolys(c, tex, 1, [0, 0], cs, DECK_HEX_SIZE, q, r, DECK_FILL, part);
          return c.polys;
        };
        expect(run('all')).toEqual([...run('floor'), ...run('paint')]);
        expect(run('paint').length > 0).toBe(q === 0 && r === 0);
        expect(run('floor').some((p) => p.mat === 'paint')).toBe(false);
      }
    }
  });

  it('the paint overlay draws the yard paint polys, crisp vector, one fill each', () => {
    const cs: Array<[number, number]> = [];
    for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + (k * Math.PI) / 3; cs.push([DECK_HEX_SIZE * Math.cos(a), -DECK_HEX_SIZE * Math.sin(a)]); }
    const c = deckStyleCtx(ngon(0, 0, 2000, 6));
    deckHexPolys(c, 'a', 2, [0, 0], cs, DECK_HEX_SIZE, 0, 0, DECK_FILL, 'paint');
    const ctx = deckLitPaintContext('a', 2);
    expect(ctx.instructions.filter((i) => i.action === 'fill')).toHaveLength(c.polys.length);
    expect(deckLitPaintContext('a', 2)).toBe(ctx); // shared, built once
  });

  it('the lit deck is lifted: lighter than the old fill, the road lane stays clearly darker', () => {
    const lum = (c: number): number => 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255);
    expect(lum(DECK_LIT_FILL)).toBeGreaterThan(lum(DECK_FILL) * 1.2);
    expect(lum(ROAD_LANE)).toBeLessThan(lum(DECK_LIT_FILL) * 0.5);
  });

  it('the yard (hazard ring) differs from a ring hex', () => {
    expect(deckLitVisual(deckLitArtId('a', 'yard'), 1).polys!.length).not.toBe(deckLitVisual(deckLitArtId('a', 'ring'), 1).polys!.length);
  });

  it('bake keys differ per role, variant and look, and carry the lit-deck version tag', () => {
    const keys = new Set<string>();
    for (const tex of ['a', 'b'] as const) {
      for (const role of ['ring', 'yard'] as const) {
        for (let seed = 1; seed <= 3; seed++) {
          const k = bakeKey({ type: 'struct', id: deckLitArtId(tex, role), seed, rot: 0, lit: true });
          expect(k).toContain(':D2');
          keys.add(k);
        }
      }
    }
    expect(keys.size).toBe(12);
  });

  it('the forged lit hex fits one atlas frame (3 slices + gutters ≤ 2048)', () => {
    const plan = deckLitVisual(deckLitArtId('b', 'yard'), 2);
    const f = forgeStructure(deckLitArtId('b', 'yard'), { ppu: DECK_LIT_PPU, box: DECK_PLATE_HEX_BOX, plan, seed: 2 });
    expect(3 * f.g.w + 2 * LIT_GUTTER).toBeLessThanOrEqual(2048);
    expect(f.g.h).toBeLessThanOrEqual(2048);
    expect(f.g.w).toBeGreaterThan(DECK_PLATE_HEX_BOX.w * DECK_LIT_PPU * 0.9);
  });
});

describe('lit deck — zoom swap', () => {
  it('hysteresis: shown down to the far scale, back only at ×1.25 of it', () => {
    expect(deckLitShown(1, false)).toBe(true);
    expect(deckLitShown(0.45, false)).toBe(false); // in the band, was hidden: stays hidden
    expect(deckLitShown(0.45, true)).toBe(true); // in the band, was shown: stays shown
    expect(deckLitShown(DECK_LIT_FAR_SCALE, true)).toBe(false);
    expect(deckLitShown(0.5, false)).toBe(true);
  });

  it('lit plates sit over the vector plate and under the zone paint', () => {
    expect(DECK_LIT_Z).toBeGreaterThan(DECK_UNDER_Z);
    expect(DECK_LIT_Z).toBeLessThan(DECK_ZONE_Z);
  });
});

describe('StructureDeckPlates — lit layer', () => {
  let prev: typeof litPass.settings;
  beforeEach(() => { prev = litPass.settings; litPass.settings = LOOK_NIGHT; });
  afterEach(() => { litPass.settings = prev; });

  it('flag off: no lit layer, nothing but the vector plates (today\x27s floor)', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'a', false);
    const { actx, asks } = fakeArt();
    deck.sync(mirrorOf(1, [[0, 0], [1, 0]]), { art: actx, cameraScale: 1 });
    expect(deck.lit).toBeUndefined();
    expect(asks).toHaveLength(0);
    expect(ship.children.every((ch) => ch.label === 'deckPlate')).toBe(true);
    // The plain look never lights, flag or not.
    expect(new StructureDeckPlates(new Container(), 'plain', false, new StructureDeckLit(new Container(), 'a')).lit).toBeUndefined();
  });

  it('flag on: each plate gets 7 lit hexes (no self-shadow) and its outline over the vector backing', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'a', false, new StructureDeckLit(ship, 'a'));
    const { actx } = fakeArt();
    const before = litPass.count;
    deck.sync(mirrorOf(1, [[0, 0], [1, 0]]), { art: actx, cameraScale: 1 });
    const roots = litRoots(ship);
    expect(roots).toHaveLength(2);
    expect(ship.children.filter((ch) => ch.label === 'deckPlate')).toHaveLength(2); // backing kept
    for (const r of roots) {
      expect(r.zIndex).toBe(DECK_LIT_Z);
      expect(r.children).toHaveLength(8);
      for (let k = 0; k < 7; k++) {
        const sp = r.children[k] as MachinedFlatSprite;
        expect(sp).toBeInstanceOf(MachinedFlatSprite);
        expect(sp.lit?.selfShadow).toBe(false);
      }
      expect((r.children[7] as Graphics).context).toBe(deckPlateOutlineContext());
      // The yard's paint rides its hex as crisp vector over the lit art; ring hexes carry none.
      const paint = r.children[0]!.children.filter((ch) => ch.label === 'deckLitPaint') as Graphics[];
      expect(paint).toHaveLength(1);
      expect(r.children[0]!.children.at(-1)).toBe(paint[0]);
      expect(paint[0]!.context).toBe(deckLitPaintContext('a', deckPlatePick(r === roots[0] ? 0 : 1, 0).variant));
      for (let k = 1; k < 7; k++) expect(r.children[k]!.children.some((ch) => ch.label === 'deckLitPaint')).toBe(false);
    }
    expect(litPass.count - before).toBe(14);
    // The handles live in the art ctx (collection sees them in use): 2 roles × the variants used.
    expect([...actx.handles.keys()].every((k) => k.startsWith('deckLit.a.'))).toBe(true);
    deck.destroy();
    expect(litPass.count).toBe(before);
  });

  it('zoomed out: hidden by renderable, never destroyed; zoomed back in: the same sprites', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'b', false, new StructureDeckLit(ship, 'b'));
    const { actx, asks } = fakeArt();
    const m = mirrorOf(1, [[0, 0]]);
    deck.sync(m, { art: actx, cameraScale: 1 });
    const root = litRoots(ship)[0]!;
    const asked = asks.length;
    deck.sync(m, { art: actx, cameraScale: 0.3 });
    expect(root.renderable).toBe(false);
    expect(root.destroyed).toBe(false);
    expect(deck.lit!.shownCount).toBe(0);
    deck.sync(m, { art: actx, cameraScale: 0.45 }); // inside the band: stays vector
    expect(root.renderable).toBe(false);
    deck.sync(m, { art: actx, cameraScale: 0.6 });
    expect(litRoots(ship)[0]).toBe(root);
    expect(root.renderable).toBe(true);
    expect(asks.length).toBe(asked); // no re-acquire on a swap
  });

  it('off-screen plates are culled and their art is not even asked for', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'a', false, new StructureDeckLit(ship, 'a'));
    const { actx, asks } = fakeArt();
    const far = new Float64Array([1e6, 1e6, 1e6 + 100, 1e6 + 100]);
    deck.sync(mirrorOf(1, [[0, 0]]), { art: actx, cameraScale: 1, viewBounds: far });
    expect(asks).toHaveLength(0);
    expect(litRoots(ship)).toHaveLength(0);
  });

  it('no GPU lighting: the plate stays vector', () => {
    litPass.settings = null;
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'a', false, new StructureDeckLit(ship, 'a'));
    deck.sync(mirrorOf(1, [[0, 0]]), { art: fakeArt().actx, cameraScale: 1 });
    expect(litRoots(ship)).toHaveLength(0);
    expect(ship.children.filter((ch) => ch.label === 'deckPlate')).toHaveLength(1);
  });

  it('a plate leaving the floor frees its lit sprites; the shared vector context survives', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'a', false, new StructureDeckLit(ship, 'a'));
    const { actx } = fakeArt();
    deck.sync(mirrorOf(1, [[0, 0], [1, 0]]), { art: actx, cameraScale: 1 });
    const before = litPass.count;
    deck.sync(mirrorOf(2, [[0, 0]]), { art: actx, cameraScale: 1 });
    expect(litRoots(ship)).toHaveLength(1);
    expect(before - litPass.count).toBe(7);
    expect(deckPlateContext('a', 0).destroyed).toBe(false);
    expect(deckPlateOutlineContext().destroyed).toBe(false);
    deck.destroy();
  });
});
