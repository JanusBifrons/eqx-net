/**
 * Lit deck spike, slice 1 (`?deckLit=on`): the road's carriageway baked into
 * its own `struct` art. Locks: the flag parse and its worker hop; flag OFF is
 * today's overlay and bake key exactly; flag ON skips the overlay and keys the
 * bake by the arm mask; the lit frame fits one 2048 page; a mirrored road's
 * lit art is counter-flipped (never a negative scale on a lit mesh).
 */
import { describe, it, expect } from 'vitest';
import { deckHexCentreInto } from '../../../core/hex/plates.js';
import { DECK_HEX_INRADIUS } from '../../../core/hex/deckCorners.js';
import { Container, GraphicsContext, Sprite } from 'pixi.js';
import { readDeckLitFlag, readRestyleLook, resolveRestyleLook, applyRestyleLook } from './rendererSetup/restyleLook.js';
import { rendererArgsFromBoot } from '../worker/bootRenderer.js';
import {
  armAngle, circle, drawRoadOverlay, roadOverlayPlan, ROAD_ARM_LEN, ROAD_HALF_W,
} from './structureStyleC.transport.road.js';
import { bakeKey, DECK_HEX_BOX, DECK_LIT_PPU, type BakeJob } from '../art/bake.js';
import { forgeStructure } from '../art/fields.js';
import { LIT_GUTTER } from '../art/litMaps.js';
import { socketNubsOf, updateSocketNubs } from './structureSocketNubs.js';
import { counterFlipStructureParts, applyStructureMirror, DECK_LIT_LABEL } from './structureMirrorFlip.js';
import { deriveRoadArms, ROAD_STRAIGHT_MASK, type RoadPiece } from './roadJoins.js';
import { structHandleFor, type ShipArtCtx } from '../art/shipArtSprites.js';
import type { ArtHandle, ArtService } from '../art/ArtService.js';

describe('?deckLit flag', () => {
  it('parses on; anything else or absent is off', () => {
    expect(readDeckLitFlag('?room=deck-bases&deckLit=on')).toBe(true);
    expect(readDeckLitFlag('?deckLit=off')).toBe(false);
    expect(readDeckLitFlag('?deckLit=onx')).toBe(false);
    expect(readDeckLitFlag('?room=deck-bases')).toBe(false);
    expect(readRestyleLook('?deckLit=on').deckLit).toBe(true);
    expect(resolveRestyleLook({ mode: 'machined' }, null).deckLit).toBe(false);
    expect(resolveRestyleLook({ mode: 'machined', deckLit: true }, null).deckLit).toBe(true);
  });

  it('rides BOOT to the worker and reaches the art ctx; off leaves the ctx untouched', () => {
    const [, on] = rendererArgsFromBoot(structuredClone({ type: 'BOOT', canvas: {} as unknown as OffscreenCanvas, width: 8, height: 8, dpr: 1, artMode: 'machined', deckLit: true } as const));
    expect(on.deckLit).toBe(true);
    const [, off] = rendererArgsFromBoot({ type: 'BOOT', canvas: {} as unknown as OffscreenCanvas, width: 8, height: 8, dpr: 1, artMode: 'machined' });
    expect(off.deckLit).toBeUndefined();
    const art: { deckLit?: boolean } = {};
    applyRestyleLook({ lineLook: null }, { art }, new Container(), { mode: 'machined' }, null);
    expect(art).toEqual({});
    applyRestyleLook({ lineLook: null }, { art }, new Container(), on, null);
    expect(art.deckLit).toBe(true);
  });
});

/** The pre-spike carriageway geometry, verbatim (the overlay must not move). */
function oldBands(mask: number): number[][] {
  const out: number[][] = [];
  const R = ROAD_ARM_LEN, W = ROAD_HALF_W;
  for (let j = 0; j < 6; j++) {
    if (!((mask >> j) & 1)) continue;
    const a = armAngle(j), ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    out.push([px * W, py * W, ux * R + px * W, uy * R + py * W, ux * R - px * W, uy * R - py * W, -px * W, -py * W]);
  }
  out.push(circle(0, 0, W, 24));
  return out;
}

const plainArt = (): ArtService => ({
  struct: (id: string, seed: number, rot = 0, accent?: number, _u = true, _r = false, _l?: unknown, style?: string, arms?: number): ArtHandle =>
    ({ state: 'pending', job: { type: 'struct', id, seed, rot, accent, ...(style ? { style } : {}), ...(arms !== undefined ? { arms } : {}) } }) as unknown as ArtHandle,
}) as unknown as ArtService;

describe('flag off: today exactly', () => {
  it('the overlay fills the same carriageway pieces for every mask', () => {
    for (let m = 1; m < 64; m++) expect(roadOverlayPlan(m).bands).toEqual(oldBands(m));
  });

  it('a road with no lit art still draws its overlay; the struct job and key carry no arms', () => {
    const sprite = new Container();
    updateSocketNubs(sprite, 'road', undefined, 0, 7);
    const plain = new GraphicsContext();
    expect(socketNubsOf(sprite)!.context.instructions.length).toBeGreaterThan(plain.instructions.length);
    const actx: ShipArtCtx = { art: plainArt(), handles: new Map(), sunAz: 0, structStyle: 'c' };
    const h = structHandleFor(actx, 'r7', 'road', 0, undefined, 7)!;
    expect(h.job.type === 'struct' && 'arms' in h.job).toBe(false);
    const job: BakeJob = { type: 'struct', id: 'road', seed: 1, style: 'c' };
    expect(bakeKey(job)).not.toContain(':A');
    expect(bakeKey({ ...job, lit: true })).not.toContain(':A');
  });
});

describe('flag on: the carriageway is baked', () => {
  it('a road whose sprite shows its lit art skips the overlay (nubs only)', () => {
    const sprite = new Container();
    const art = new Sprite();
    art.label = DECK_LIT_LABEL;
    sprite.addChild(art);
    updateSocketNubs(sprite, 'road', undefined, 0, 7);
    const ref = new Container();
    updateSocketNubs(ref, 'road', undefined, 0, 7);
    expect(socketNubsOf(sprite)!.context).not.toBe(socketNubsOf(ref)!.context);
    const overlay = new GraphicsContext();
    drawRoadOverlay(overlay, ROAD_STRAIGHT_MASK);
    expect(socketNubsOf(sprite)!.context.instructions.length).toBe(socketNubsOf(ref)!.context.instructions.length - overlay.instructions.length);
  });

  it('the arm mask joins the struct job and the bake key (lit and baked)', () => {
    const actx: ShipArtCtx = { art: plainArt(), handles: new Map(), sunAz: 0, structStyle: 'c', deckLit: true };
    const h = structHandleFor(actx, 'r7', 'road', 0, undefined, 7)!;
    expect(h.job.type === 'struct' && h.job.arms).toBe(ROAD_STRAIGHT_MASK);
    // Not a road, or no style drawer: no arms.
    expect(structHandleFor(actx, 'x', 'battery', 0, undefined, 8)!.job).not.toHaveProperty('arms');
    const a: BakeJob = { type: 'struct', id: 'road', seed: 1, style: 'c', arms: 0b010010 };
    const b: BakeJob = { ...a, arms: 0b001001 };
    expect(bakeKey(a)).toMatch(/:A\d+\.18$/);
    expect(bakeKey(a)).not.toBe(bakeKey(b));
    expect(bakeKey({ ...a, lit: true })).not.toBe(bakeKey({ ...b, lit: true }));
  });

  it('bakes on the full deck hex: arms reach the seam; the lit frame fits a 2048 page', () => {
    const f = forgeStructure('road', { ppu: DECK_LIT_PPU, arms: ROAD_STRAIGHT_MASK, box: DECK_HEX_BOX, style: 'c', seed: 1 });
    const litW = 3 * f.g.w + 2 * LIT_GUTTER;
    console.log(`deckLit road frame: slice ${f.g.w}x${f.g.h} @ ppu ${f.g.ppu}, lit frame ${litW}x${f.g.h}`);
    expect(litW).toBeLessThanOrEqual(2048);
    expect(f.g.h).toBeLessThanOrEqual(2048);
    // Straight mask = local 90° / 270°: carriageway just inside the seam (y = ±640), none off the arm.
    const at = (x: number, y: number): number => f.cov[Math.floor(y * f.g.ppu + f.g.oy) * f.g.w + Math.floor(x * f.g.ppu + f.g.ox)]!;
    expect(at(0, 640)).toBeGreaterThan(0.5);
    expect(at(0, -640)).toBeGreaterThan(0.5);
    expect(at(560, 0)).toBe(0);
  });
});

describe('mirror', () => {
  it('the lit table ignores the build mirror; the lit art child is counter-flipped', () => {
    const c = deckHexCentreInto(3, 1, { x: 0, y: 0 });
    const n = { x: c.x + 2 * DECK_HEX_INRADIUS, y: c.y }; // the hex beyond world edge 0
    const roads = (mirror: boolean): RoadPiece[] => [{ id: 1, ...c, rotDeg: 30, mirror }, { id: 2, ...n, rotDeg: 30, mirror }];
    const arms = new Map<number, number>(), lit = new Map<number, number>(), plain = new Map<number, number>();
    deriveRoadArms(roads(true), [], arms, lit);
    deriveRoadArms(roads(false), [], plain);
    expect(lit.get(1)).toBe(plain.get(1));
    expect(arms.get(1)).not.toBe(plain.get(1)); // the overlay's mask is the mirrored one
    const sprite = new Container();
    const art = new Sprite();
    art.label = DECK_LIT_LABEL;
    sprite.addChild(art);
    expect(applyStructureMirror(sprite, true)).toBe(true);
    counterFlipStructureParts(sprite, null);
    expect(sprite.scale.x * art.scale.x).toBeGreaterThan(0);
    applyStructureMirror(sprite, false);
    counterFlipStructureParts(sprite, null);
    expect(art.scale.x).toBeGreaterThan(0);
  });
});
