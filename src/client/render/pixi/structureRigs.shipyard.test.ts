/**
 * Shipyard build frame (restyle job 3J, `shipyard-frame`): every rig part
 * draws from the heavyIndustry family's part art (one shared context per art
 * kind), and none is a pop-up riser (the frame stands at rest, fully shown).
 * Build sequence (job 3K, structureStyleC.shipyardBuild.ts): printed parts
 * show from lift > 0, cyan until done, scaled to the hull being built; lamps
 * light at 0.5; the clip is played from the row (state + 3L progress).
 * Bays (loop 3R): the hull prints at its bay's keel down the slip, the gantry
 * over it; the slip is marked into bays; queued builds outline the next bays.
 */
import { describe, it, expect } from 'vitest';
import { StructureRigView } from './structureRigs.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { shipyardPartContext } from './structureStyleC.heavyIndustry.js';
import {
  SHIPYARD_BAY_MARK_XS, shipyardCycleTicks, shipyardKeelContext, shipyardPrintContext, shipyardGantryX, shipyardHullScale,
  shipyardLightContext, shipyardRowClip,
} from './structureStyleC.shipyardBuild.js';
import {
  SHIPYARD_BAY_COUNT, SHIPYARD_BAY_LEN, SHIPYARD_BUILD_CLIP, SHIPYARD_BUILD_TICKS, SHIPYARD_GANTRY_TRAVEL, SHIPYARD_HULL_HALF_L,
  SHIPYARD_SLIP_X0, SHIPYARD_SLIP_X1, shipyardBayKeel,
} from '../../../core/articulation/rigs/heavyIndustry.js';
import { PROD_STATE, encodeRecipe } from '../../../shared-types/production.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

const PRINTED = /^(hull|fit)-/;
const row = (prodState: number, prodFrac?: number, recipe = encodeRecipe('build_interceptor'), prodBay?: number, prodQueued?: number) =>
  ({ prodState, recipe, prodFrac, prodBay, prodQueued }) as unknown as StructureRenderState;

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

  it('mid-print a block shows its cyan print art, faded; finished it is full; lamps light; all scaled to the hull', () => {
    const rig = rigForStructureKind('shipyard')!;
    const v = new StructureRigView(rig);
    v.setRunningFrom(row(PROD_STATE.running, undefined, encodeRecipe('build_missile_frigate')));
    const k = shipyardHullScale(encodeRecipe('build_missile_frigate'));
    // Tick 85: block hull-0 (the first, at x = +6) is mid-print.
    v.update({ clipId: SHIPYARD_BUILD_CLIP, startTick: 1000 - 85 }, 1000, 0, 0, 0);
    const h0 = v.parts[rig.partIds.indexOf('hull-0')]!;
    expect(h0.visible).toBe(true);
    expect(h0.context).toBe(shipyardPrintContext('hull-0', true));
    expect(h0.context).not.toBe(shipyardPrintContext('hull-0'));
    expect(h0.alpha).toBeLessThan(1);
    expect(h0.scale.x).toBeCloseTo(k, 6);
    expect(h0.x).toBeCloseTo(shipyardBayKeel(0).x + 6 * k, 6); // bay 0 (3R)
    expect(v.parts[rig.partIds.indexOf('hull-7')]!.visible).toBe(false);
    // Finished: every block solid, every lamp lit.
    v.update({ clipId: SHIPYARD_BUILD_CLIP, startTick: 1000 - SHIPYARD_BUILD_TICKS }, 1000, 0, 0, 0);
    expect(h0.context).toBe(shipyardPrintContext('hull-0'));
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

describe('shipyard bays down the slip (loop 3R)', () => {
  const rig = rigForStructureKind('shipyard')!;
  const part = (v: StructureRigView, id: string) => v.parts[rig.partIds.indexOf(id)]!;
  const fr = encodeRecipe('build_missile_frigate');

  it('prints the hull at its bay keel, nose to the bow, the gantry over that bay', () => {
    const v = new StructureRigView(rig);
    const k = shipyardHullScale(fr), bx = shipyardBayKeel(2).x;
    v.setRunningFrom(row(PROD_STATE.running, undefined, fr, 2));
    v.update({ clipId: SHIPYARD_BUILD_CLIP, startTick: 1000 - 85 }, 1000, 0, 0, 0);
    // hull-0 sits at clip x = +6 (toward the bow) from the bay's keel.
    expect(part(v, 'hull-0').x).toBeCloseTo(bx + 6 * k, 6);
    // Over the hull the gantry tracks the bay; past it, the same end stops.
    expect(shipyardGantryX(30, k, bx)).toBeCloseTo(bx + 30 * k, 9);
    expect(shipyardGantryX(-SHIPYARD_GANTRY_TRAVEL, k, bx)).toBeCloseTo(-SHIPYARD_GANTRY_TRAVEL, 9);
    expect(shipyardGantryX(SHIPYARD_GANTRY_TRAVEL, k, bx)).toBeCloseTo(SHIPYARD_GANTRY_TRAVEL, 9);
    const g = part(v, 'gantry').x;
    expect(Math.abs(g - bx)).toBeLessThanOrEqual(SHIPYARD_HULL_HALF_L * k + 1e-6);
    // Bay 0 (no prodBay on the row) is the bow bay.
    const v0 = new StructureRigView(rig);
    v0.setRunningFrom(row(PROD_STATE.running, undefined, fr));
    v0.update({ clipId: SHIPYARD_BUILD_CLIP, startTick: 1000 - 85 }, 1000, 0, 0, 0);
    expect(part(v0, 'hull-0').x).toBeCloseTo(shipyardBayKeel(0).x + 6 * k, 6);
    expect(shipyardBayKeel(0).x).toBeGreaterThan(shipyardBayKeel(1).x);
  });

  it('marks the slip into its bays: one mark between each pair, each bay between two marks or the slip ends', () => {
    expect(SHIPYARD_BAY_MARK_XS.length).toBe(SHIPYARD_BAY_COUNT - 1);
    for (let i = 0; i < SHIPYARD_BAY_MARK_XS.length; i++) {
      expect(SHIPYARD_BAY_MARK_XS[i]).toBeCloseTo((shipyardBayKeel(i).x + shipyardBayKeel(i + 1).x) / 2, 9);
    }
    const edges = [SHIPYARD_SLIP_X1, ...SHIPYARD_BAY_MARK_XS, SHIPYARD_SLIP_X0];
    for (let b = 0; b < SHIPYARD_BAY_COUNT; b++) {
      expect(edges[b]! - edges[b + 1]!).toBeCloseTo(SHIPYARD_BAY_LEN, 9);
      expect(shipyardBayKeel(b).x).toBeCloseTo((edges[b]! + edges[b + 1]!) / 2, 9);
    }
  });

  it('only the current bay draws a hull; queued builds outline the next bays (none queued: none drawn)', () => {
    const v = new StructureRigView(rig);
    v.setRunningFrom(row(PROD_STATE.running, 0.5, fr, 1));
    v.update({ clipId: SHIPYARD_BUILD_CLIP, startTick: 0 }, SHIPYARD_BUILD_TICKS, 0, 0, 0);
    const keel = part(v, 'keel');
    expect(keel.context).toBe(shipyardKeelContext());
    // One build in the yard: its parts are the only hull drawn, all at bay 1.
    const k = shipyardHullScale(fr), bx = shipyardBayKeel(1).x;
    for (let i = 0; i < rig.partCount; i++) {
      const id = rig.partIds[i]!;
      if (!PRINTED.test(id)) continue;
      expect(Math.abs(v.parts[i]!.x - bx), id).toBeLessThanOrEqual(SHIPYARD_HULL_HALF_L * k + 1e-6);
    }
    // Two queued: faint outlines in bays 2 and 3, from the keel part's art.
    v.setRunningFrom(row(PROD_STATE.running, 0.5, fr, 1, 2));
    v.update({ clipId: SHIPYARD_BUILD_CLIP, startTick: 0 }, SHIPYARD_BUILD_TICKS, 0, 0, 0);
    const q = keel.context;
    expect(q).not.toBe(shipyardKeelContext());
    const b = q.bounds;
    expect(b.minX).toBeLessThan(shipyardBayKeel(3).x);
    expect(b.maxX).toBeGreaterThan(shipyardBayKeel(2).x);
    expect(b.maxX).toBeLessThan(shipyardBayKeel(1).x - SHIPYARD_HULL_HALF_L * k);
    // Same row again: the same shared art (built once, not per frame).
    v.update({ clipId: SHIPYARD_BUILD_CLIP, startTick: 0 }, SHIPYARD_BUILD_TICKS, 0, 0, 0);
    expect(keel.context).toBe(q);
    // Queue drained: the outlines go.
    v.setRunningFrom(row(PROD_STATE.running, 0.5, fr, 1, 0));
    v.update({ clipId: SHIPYARD_BUILD_CLIP, startTick: 0 }, SHIPYARD_BUILD_TICKS, 0, 0, 0);
    expect(keel.context).toBe(shipyardKeelContext());
  });
});
