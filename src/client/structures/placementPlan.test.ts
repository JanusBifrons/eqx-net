/**
 * Plan then Build (owner 2026-11-27): Place plans, Build sends the whole plan
 * as ONE `place_structures` (all or nothing). ✕ and leaving build mode drop
 * the plan; a refusal keeps it and marks the refused items; the batch
 * landing (the structures count grew by the batch) clears it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Smelter stands in as a crate-stocked kind (only the Capital needs a crate
// today, and it places once), as in packedStockPlacement.test.ts.
vi.mock('../../shared-types/blueprints.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../shared-types/blueprints.js')>();
  return { ...real, needsPackedCrate: (k: string) => k === 'capital' || k === 'smelter' };
});

const sent: Array<{ type: string; msg: unknown }> = [];
const mirror = {
  localPlayerId: 'p1',
  ships: new Map([['p1', { x: 0, y: 0, angle: 0 }]]),
  structures: new Map<number, unknown>(),
  swarm: new Map<number, unknown>(),
  pendingPlacementPreview: null,
};
vi.mock('../net/clientSingleton.js', () => ({
  getGameClient: () => ({
    mirror,
    getRoom: () => ({ send: (type: string, msg: unknown) => { sent.push({ type, msg: structuredClone(msg) }); } }),
    notePendingPlacement: () => {},
  }),
}));

import { useUIStore } from '../state/store.js';
import { PlaceStructuresSchema } from '../../shared-types/messages.js';
import { placementChosen, resetPlacementChosen } from './placementChosen.js';
import {
  buildPlacementPlan, cancelPlacement, commitPlacement, onPlaceStructuresRefused, stepPlacementPlan,
} from './placementCancel.js';
import {
  addPlannedPlacement, clearPlacementPlan, getPlacementPlanCount, isPlannedPlacementRefused, plannedPlacementAt, subscribePlacementPlan,
} from './placementPlan.js';
import { setPlacementMirror, setPlacementRotationDeg } from './structurePlacementClient.js';
import { snapPlacementToDeck } from '../../core/structures/deckPlacement.js';

/** Tap Place with the ghost at (x, y). */
function place(kind: 'solar' | 'battery' | 'smelter', x: number, y: number): boolean {
  resetPlacementChosen();
  placementChosen.worldX = x;
  placementChosen.worldY = y;
  return commitPlacement(kind);
}

beforeEach(() => {
  sent.length = 0;
  cancelPlacement();
  clearPlacementPlan();
  mirror.structures.clear();
  setPlacementRotationDeg(0);
  setPlacementMirror(false);
  useUIStore.setState({
    buildMode: true, placementKind: 'solar', deck: false, packedStock: null, currentSectorKey: null, freeBuilds: false,
  });
});

describe('plan then Build', () => {
  it('Place adds to the plan and sends nothing', () => {
    expect(place('solar', 100, 0)).toBe(true);
    expect(place('battery', 4000, 0)).toBe(true);
    expect(sent).toEqual([]);
    expect(getPlacementPlanCount()).toBe(2);
    expect(plannedPlacementAt(0)).toEqual({ kind: 'solar', x: 100, y: 0, rot: 0, mirror: false });
    expect(plannedPlacementAt(1)).toMatchObject({ kind: 'battery', x: 4000, y: 0 });
    expect(useUIStore.getState().placementKind).toBe('solar'); // placing goes on
  });

  it('Build sends ONE place_structures with every item in order, passing the server schema', () => {
    place('solar', 100, 0);
    place('battery', 4000, 0);
    place('solar', 7000, 0);
    expect(buildPlacementPlan()).toBe(true);
    expect(sent.map((s) => s.type)).toEqual(['place_structures']);
    const parsed = PlaceStructuresSchema.safeParse(sent[0]!.msg);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.items.map((i) => [i.kind, i.x])).toEqual([['solar', 100], ['battery', 4000], ['solar', 7000]]);
    // In flight: no second send, no new plan items.
    expect(buildPlacementPlan()).toBe(false);
    expect(place('solar', 10000, 0)).toBe(false);
    expect(sent.length).toBe(1);
  });

  it('✕ (Stop placing) clears the plan, as does leaving build mode', () => {
    place('solar', 100, 0);
    cancelPlacement();
    expect(getPlacementPlanCount()).toBe(0);
    useUIStore.setState({ placementKind: 'solar' });
    place('solar', 100, 0);
    expect(getPlacementPlanCount()).toBe(1);
    useUIStore.setState({ buildMode: false });
    expect(getPlacementPlanCount()).toBe(0);
  });

  it('a refused reply keeps the plan and marks the refused indices', () => {
    place('solar', 100, 0);
    place('battery', 4000, 0);
    place('solar', 7000, 0);
    buildPlacementPlan();
    onPlaceStructuresRefused([{ index: 0 }, { index: 2 }]);
    expect(getPlacementPlanCount()).toBe(3);
    expect([0, 1, 2].map(isPlannedPlacementRefused)).toEqual([true, false, true]);
    // Build may be pressed again (the flags reset for the fresh verdict).
    expect(buildPlacementPlan()).toBe(true);
    expect(sent.length).toBe(2);
    expect(isPlannedPlacementRefused(0)).toBe(false);
  });

  it('the batch landing (structures grew by the batch) clears the plan; a timeout keeps it', () => {
    place('solar', 100, 0);
    place('battery', 4000, 0);
    buildPlacementPlan(); // baseline 0 structures
    stepPlacementPlan(0, 1000);
    stepPlacementPlan(1, 1016);
    expect(getPlacementPlanCount()).toBe(2);
    stepPlacementPlan(2, 1032);
    expect(getPlacementPlanCount()).toBe(0);
    // Timeout: the plan stays, Build may be pressed again.
    place('solar', 100, 0);
    buildPlacementPlan();
    stepPlacementPlan(0, 5000);
    stepPlacementPlan(0, 9000);
    expect(getPlacementPlanCount()).toBe(1);
    expect(buildPlacementPlan()).toBe(true);
  });

  it('the shared batch check marks a clashing plan red before any send (#15)', () => {
    place('solar', 100, 0);
    place('battery', 105, 0); // overlaps the planned solar
    expect(buildPlacementPlan()).toBe(false);
    expect(sent).toEqual([]);
    expect(isPlannedPlacementRefused(0)).toBe(false);
    expect(isPlannedPlacementRefused(1)).toBe(true);
  });

  it('the crate cap counts planned buildings of the kind', () => {
    useUIStore.setState({ placementKind: 'smelter', currentSectorKey: 'sol', packedStock: { 'structure:smelter': 2 } });
    expect(place('smelter', 100, 0)).toBe(true);
    expect(useUIStore.getState().placementKind).toBe('smelter'); // one crate left unplanned
    expect(place('smelter', 6000, 0)).toBe(true);
    expect(useUIStore.getState().placementKind).toBe(null); // the last crate is planned
    expect(getPlacementPlanCount()).toBe(2);
  });
});

describe('placementPlan storage', () => {
  it('refuses the same pose twice and notifies count changes only', () => {
    const heard = vi.fn();
    const off = subscribePlacementPlan(heard);
    expect(addPlannedPlacement('solar', 10, 20, 0, false, false)).toBe(true);
    expect(addPlannedPlacement('solar', 10, 20, 0, false, false)).toBe(false);
    clearPlacementPlan();
    clearPlacementPlan();
    expect(heard).toHaveBeenCalledTimes(2);
    off();
  });

  it('stores the pose the server places at: the deck snap on a deck room', () => {
    expect(addPlannedPlacement('solar', 13.7, -41.2, 0, false, true)).toBe(true);
    const s = snapPlacementToDeck('solar', 13.7, -41.2, { x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 }, 0);
    expect(plannedPlacementAt(0)).toEqual({ kind: 'solar', x: s.x, y: s.y, rot: s.rot, mirror: false });
  });
});
