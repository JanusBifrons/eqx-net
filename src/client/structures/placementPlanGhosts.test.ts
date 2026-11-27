/**
 * Plan then Build (C2): the planned buildings reach the render preview (the
 * ghosts and the live ghost's verdict read them there), and a Place ON a
 * planned building removes that one from the plan instead of adding one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mirror = {
  localPlayerId: 'p1',
  ships: new Map([['p1', { x: 0, y: 0, angle: 0 }]]),
  structures: new Map<number, unknown>(),
  swarm: new Map<number, unknown>(),
  pendingPlacementPreview: null,
};
vi.mock('../net/clientSingleton.js', () => ({
  getGameClient: () => ({ mirror, getRoom: () => ({ send: () => {} }), notePendingPlacement: () => {} }),
}));

import { useUIStore } from '../state/store.js';
import { structureKindToIndex } from '../../shared-types/structureKinds.js';
import { getPlacementOnPlanned, placementChosen, resetPlacementChosen, writePlacementChosen } from './placementChosen.js';
import { cancelPlacement, commitPlacement } from './placementCancel.js';
import {
  addPlannedPlacement, clearPlacementPlan, getPlacementPlanCount, isPlannedPlacementRefused, markPlannedRefused, planTapHitIndex,
  plannedPlacementAt, plannedPlacements, PREVIEW_PLAN_MIRROR, PREVIEW_PLAN_REFUSED, PREVIEW_PLAN_STRIDE, removePlannedPlacement,
  writePreviewPlan,
} from './placementPlan.js';
import { resolvePlacementPreviewStatus, setPlacementMirror, setPlacementRotationDeg, type PlacementPreview } from './structurePlacementClient.js';
import { setPlacementHeld } from './placementChosen.js';

function place(kind: 'solar' | 'battery', x: number, y: number): boolean {
  resetPlacementChosen();
  placementChosen.worldX = x;
  placementChosen.worldY = y;
  return commitPlacement(kind);
}

beforeEach(() => {
  cancelPlacement();
  clearPlacementPlan();
  setPlacementRotationDeg(0);
  setPlacementMirror(false);
  useUIStore.setState({ buildMode: true, placementKind: 'solar', deck: false, packedStock: null, currentSectorKey: null, freeBuilds: false });
});

describe('planned buildings reach the render preview', () => {
  it('writePreviewPlan: stride 5 (x, y, rot, kind index, mirror | refused flags), reused array', () => {
    addPlannedPlacement('solar', 100, 0, 0, false, false);
    addPlannedPlacement('battery', 600, 50, 90, true, false);
    markPlannedRefused(1);
    const out: { plan?: number[] } = {};
    writePreviewPlan(out);
    expect(out.plan).toEqual([
      100, 0, 0, structureKindToIndex('solar'), 0,
      600, 50, 90, structureKindToIndex('battery'), PREVIEW_PLAN_MIRROR | PREVIEW_PLAN_REFUSED,
    ]);
    expect(out.plan!.length).toBe(2 * PREVIEW_PLAN_STRIDE);
    const arr = out.plan;
    clearPlacementPlan();
    writePreviewPlan(out);
    expect(out.plan).toBe(arr);
    expect(out.plan).toEqual([]);
  });

  it('the live placement preview (the mirror\'s pendingPlacementPreview) carries the plan, structured-cloneable', () => {
    addPlannedPlacement('solar', 100, 0, 0, false, false);
    addPlannedPlacement('battery', 600, 0, 0, false, false);
    const out = { kind: 'solar', x: 0, y: 0, angle: 0 } as PlacementPreview;
    const status = resolvePlacementPreviewStatus('solar', { x: 0, y: 0, angle: 0 }, null, 0, 0, true, out);
    expect(status).toBe('active');
    expect(out.plan!.length).toBe(2 * PREVIEW_PLAN_STRIDE);
    expect(structuredClone(out).plan).toEqual(out.plan);
  });
});

describe('a Place on a planned building removes it', () => {
  it('planTapHitIndex: inside the footprint box hits, outside misses; the last planned wins', () => {
    const items = [
      { kind: 'solar' as const, x: 0, y: 0, rot: 0, mirror: false },
      { kind: 'solar' as const, x: 10, y: 0, rot: 0, mirror: false },
    ];
    expect(planTapHitIndex(items, 2, 0)).toBe(1);
    expect(planTapHitIndex(items, 1e5, 0)).toBe(-1);
    expect(planTapHitIndex(items, null, null)).toBe(-1);
    expect(planTapHitIndex([items[0]!], 2, 0)).toBe(0);
  });

  it('removePlannedPlacement shifts later items and their refused flags; the freed record is reused cleanly', () => {
    addPlannedPlacement('solar', 100, 0, 0, false, false);
    addPlannedPlacement('battery', 600, 0, 0, false, false);
    addPlannedPlacement('solar', 1100, 0, 0, false, false);
    markPlannedRefused(2);
    expect(removePlannedPlacement(0)).toBe(true);
    expect(getPlacementPlanCount()).toBe(2);
    expect(plannedPlacementAt(0)).toMatchObject({ kind: 'battery', x: 600 });
    expect(plannedPlacementAt(1)).toMatchObject({ kind: 'solar', x: 1100 });
    expect(isPlannedPlacementRefused(1)).toBe(true);
    expect(isPlannedPlacementRefused(0)).toBe(false);
    addPlannedPlacement('battery', 2000, 0, 0, false, false);
    expect(plannedPlacements().map((p) => p.x)).toEqual([600, 1100, 2000]);
    expect(isPlannedPlacementRefused(2)).toBe(false);
    expect(removePlannedPlacement(5)).toBe(false);
  });

  it('Place on a planned ghost removes that one instead of adding (placing goes on)', () => {
    expect(place('solar', 100, 0)).toBe(true);
    expect(place('solar', 2000, 0)).toBe(true);
    expect(getPlacementPlanCount()).toBe(2);
    expect(place('solar', 100, 0)).toBe(true);
    expect(plannedPlacements().map((p) => p.x)).toEqual([2000]);
    expect(useUIStore.getState().placementKind).toBe('solar');
  });

  /** One preview frame with the ghost at (x, y): the held flag as the mirror pass sets it. */
  function frameAt(x: number, y: number): PlacementPreview {
    const out = { kind: 'solar', x: 0, y: 0, angle: 0 } as PlacementPreview;
    resolvePlacementPreviewStatus('solar', { x: 0, y: 0, angle: 0 }, null, 0, 0, true, out, x, y);
    placementChosen.worldX = x;
    placementChosen.worldY = y;
    setPlacementHeld(out.held === true);
    return out;
  }

  it('right after a Place the ghost is HELD on the new planned building: a second Place (double-click) does nothing', () => {
    resetPlacementChosen();
    frameAt(100, 0);
    expect(commitPlacement('solar')).toBe(true);
    expect(getPlacementPlanCount()).toBe(1);
    const out = frameAt(100, 0);
    expect(out.held).toBe(true); // dim, no verdict: never red on its own new building
    expect(commitPlacement('solar')).toBe(false);
    expect(getPlacementPlanCount()).toBe(1);
  });

  it('moved away and back onto the planned building, a Place removes it', () => {
    resetPlacementChosen();
    frameAt(100, 0);
    expect(commitPlacement('solar')).toBe(true);
    expect(frameAt(3000, 0).held).toBe(false);
    expect(frameAt(100, 0).held).toBe(false); // the hold ended when the ghost left
    expect(commitPlacement('solar')).toBe(true);
    expect(getPlacementPlanCount()).toBe(0);
  });

  it('the Place button stays enabled on a planned building (onPlanned), off it does not', () => {
    addPlannedPlacement('solar', 100, 0, 0, false, false);
    const fb = { placementChosenWorldX: 100, placementChosenWorldY: 0, placementStuck: true, placementPreviewRejection: 'overlap-structure' as const };
    writePlacementChosen(fb);
    expect(getPlacementOnPlanned()).toBe(true);
    writePlacementChosen({ ...fb, placementChosenWorldX: 5000 });
    expect(getPlacementOnPlanned()).toBe(false);
  });
});
