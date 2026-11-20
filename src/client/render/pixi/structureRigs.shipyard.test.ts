/**
 * Shipyard build frame (restyle job 3J, `shipyard-frame`): every rig part
 * draws from the heavyIndustry family's part art (one shared context per art
 * kind), and none is a pop-up riser (the frame stands at rest, fully shown).
 * Build sequence (job 3K, structureStyleC.shipyardBuild.ts): printed parts
 * show from lift > 0, cyan until done, scaled to the hull being built; lamps
 * light at 0.5; the clip is played from the row (state + 3L progress).
 */
import { describe, it, expect } from 'vitest';
import { StructureRigView } from './structureRigs.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { shipyardPartContext } from './structureStyleC.heavyIndustry.js';
import {
  SHIPYARD_PRINT_CYAN, shipyardCycleTicks, shipyardGantryX, shipyardHullScale, shipyardLightContext, shipyardRowClip,
} from './structureStyleC.shipyardBuild.js';
import { SHIPYARD_BUILD_CLIP, SHIPYARD_BUILD_TICKS, SHIPYARD_GANTRY_TRAVEL } from '../../../core/articulation/rigs/heavyIndustry.js';
import { PROD_STATE, encodeRecipe } from '../../../shared-types/production.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

const PRINTED = /^(hull|fit)-/;
const row = (prodState: number, prodFrac?: number, recipe = encodeRecipe('build_interceptor')) =>
  ({ prodState, recipe, prodFrac }) as unknown as StructureRenderState;

describe('shipyard build frame (StructureRigView)', () => {
  it('draws every part from the shared shipyard part art', () => {
    const rig = rigForStructureKind('shipyard')!;
    const v = new StructureRigView(rig);
    expect(v.parts.length).toBe(rig.partCount);
    for (let i = 0; i < rig.partCount; i++) {
      const ctx = shipyardPartContext(rig, i);
      expect(ctx, rig.partIds[i]).not.toBeNull();
      expect(v.parts[i]!.context, rig.partIds[i]).toBe(ctx);
    }
    // One context per art kind: all clamps share one, all lights share one.
    const at = (id: string) => shipyardPartContext(rig, rig.partIds.indexOf(id));
    expect(at('clamp-port-0')).toBe(at('clamp-stbd-3'));
    expect(at('light-0')).toBe(at('light-5'));
    expect(at('wall-port')).not.toBe(at('wall-stbd'));
  });

  it('stands fully shown at rest (no riser), with no hull printed yet and the lamps dark', () => {
    const rig = rigForStructureKind('shipyard')!;
    const v = new StructureRigView(rig);
    v.update(null, 0, 0, 0, 0);
    for (let i = 0; i < rig.partCount; i++) expect(v.parts[i]!.visible, rig.partIds[i]).toBe(!PRINTED.test(rig.partIds[i]!));
    expect(v.parts[rig.partIds.indexOf('light-5')]!.context).toBe(shipyardLightContext(false));
  });

  it('mid-print a block is cyan and faded; finished it is full; lamps light; all scaled to the hull', () => {
    const rig = rigForStructureKind('shipyard')!;
    const v = new StructureRigView(rig);
    v.setRunningFrom(row(PROD_STATE.running, undefined, encodeRecipe('build_missile_frigate')));
    const k = shipyardHullScale(encodeRecipe('build_missile_frigate'));
    // Tick 85: block hull-0 (the first, at x = +6) is mid-print.
    v.update({ clipId: SHIPYARD_BUILD_CLIP, startTick: 1000 - 85 }, 1000, 0, 0, 0);
    const h0 = v.parts[rig.partIds.indexOf('hull-0')]!;
    expect(h0.visible).toBe(true);
    expect(h0.tint).toBe(SHIPYARD_PRINT_CYAN);
    expect(h0.alpha).toBeLessThan(1);
    expect(h0.scale.x).toBeCloseTo(k, 6);
    expect(h0.x).toBeCloseTo(6 * k, 6);
    expect(v.parts[rig.partIds.indexOf('hull-7')]!.visible).toBe(false);
    // Finished: every block solid, every lamp lit.
    v.update({ clipId: SHIPYARD_BUILD_CLIP, startTick: 1000 - SHIPYARD_BUILD_TICKS }, 1000, 0, 0, 0);
    expect(h0.tint).toBe(0xffffff);
    expect(h0.alpha).toBe(1);
    for (let i = 0; i < 6; i++) expect(v.parts[rig.partIds.indexOf(`light-${i}`)]!.context).toBe(shipyardLightContext(true));
  });

  it('sizes the hull from the kind being built, the gantry keeping its end stops', () => {
    const fi = shipyardHullScale(encodeRecipe('build_interceptor'));
    const mf = shipyardHullScale(encodeRecipe('build_missile_frigate'));
    expect(fi).toBeGreaterThan(0);
    expect(mf).toBeGreaterThan(fi);
    for (const k of [fi, mf]) {
      expect(shipyardGantryX(SHIPYARD_GANTRY_TRAVEL, k)).toBeCloseTo(SHIPYARD_GANTRY_TRAVEL, 9);
      expect(shipyardGantryX(-SHIPYARD_GANTRY_TRAVEL, k)).toBeCloseTo(-SHIPYARD_GANTRY_TRAVEL, 9);
      expect(shipyardGantryX(30, k)).toBeCloseTo(30 * k, 9);
    }
  });

  it('idle yard rests; blocked yard shows done', () => {
    const memo = { start: Number.NaN, seen: Number.NaN }, out = { clipId: '', startTick: 0 };
    expect(shipyardRowClip(row(PROD_STATE.none), 100, memo, out)).toBe(false);
    expect(shipyardRowClip(undefined, 100, memo, out)).toBe(false);
    expect(shipyardRowClip(row(PROD_STATE.starved), 150, memo, out)).toBe(false);
    expect(shipyardRowClip(row(PROD_STATE.blocked, 1), 5000, memo, out)).toBe(true);
    expect(out.clipId).toBe(SHIPYARD_BUILD_CLIP);
    expect(out.startTick).toBe(5000 - SHIPYARD_BUILD_TICKS);
    expect(Number.isNaN(memo.start)).toBe(true);
    expect(shipyardRowClip(row(PROD_STATE.unpowered, 0.4), 6000, memo, out)).toBe(false);
  });

  it('clip time matches build progress on join (loop 3L)', () => {
    // A client that first sees the yard mid-build poses the clip there.
    const memo = { start: Number.NaN, seen: Number.NaN }, out = { clipId: '', startTick: 0 };
    expect(shipyardRowClip(row(PROD_STATE.running, 0.5), 1000, memo, out)).toBe(true);
    expect(out.clipId).toBe(SHIPYARD_BUILD_CLIP);
    expect(out.startTick).toBeCloseTo(1000 - SHIPYARD_BUILD_TICKS / 2, 6);
  });

  it('advances with game ticks between updates, holds at done, re-anchors on each update', () => {
    const memo = { start: Number.NaN, seen: Number.NaN }, out = { clipId: '', startTick: 0 };
    const cycle = shipyardCycleTicks(encodeRecipe('build_interceptor'));
    expect(cycle).toBeGreaterThan(0);
    shipyardRowClip(row(PROD_STATE.running, 0.5), 1000, memo, out);
    shipyardRowClip(row(PROD_STATE.running, 0.5), 1000 + cycle / 4, memo, out);
    expect(out.startTick).toBeCloseTo(1000 + cycle / 4 - 0.75 * SHIPYARD_BUILD_TICKS, 6);
    // No update for a long time: held at done, never wrapped.
    shipyardRowClip(row(PROD_STATE.running, 0.5), 1000 + cycle * 3, memo, out);
    expect(out.startTick).toBe(1000 + cycle * 3 - SHIPYARD_BUILD_TICKS);
    // The server's next value (a new hull) wins over the estimate.
    shipyardRowClip(row(PROD_STATE.running, 0.1), 9000, memo, out);
    expect(out.startTick).toBeCloseTo(9000 - 0.1 * SHIPYARD_BUILD_TICKS, 6);
    shipyardRowClip(row(PROD_STATE.running), 9500, memo, out);
    expect(out.startTick).toBe(9500); // nothing loaded yet: progress 0
  });
});
