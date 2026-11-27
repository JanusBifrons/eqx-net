/**
 * Plan then Build, after the server's `place_structures_placed`: the planned
 * ghosts stay drawn until the buildings are in the mirror and renderable (the
 * sent/pending rule, `pendingPlacementResolved`), so nothing flickers out
 * between the reply and the snapshot that carries them. The ghost held on the
 * last planned spot stays held after Build, like after a normal sent Place,
 * so it never reads red "too close" on its own new building.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { placementChosen, resetPlacementChosen } from './placementChosen.js';
import { buildPlacementPlan, cancelPlacement, commitPlacement, onPlaceStructuresPlaced, stepPlacementPlan } from './placementCancel.js';
import { clearPlacementPlan, getPlacementPlanCount, writePreviewPlan, PREVIEW_PLAN_STRIDE } from './placementPlan.js';
import { isHeldOnPlanned, PENDING_PLACEMENT_TIMEOUT_MS, setPlacementMirror, setPlacementRotationDeg } from './structurePlacementClient.js';

function place(kind: 'solar' | 'battery', x: number, y: number): boolean {
  resetPlacementChosen();
  placementChosen.worldX = x;
  placementChosen.worldY = y;
  return commitPlacement(kind);
}
const lastBatchId = (): number => (sent[sent.length - 1]!.msg as { batchId: number }).batchId;
const drawnPlanned = (): number => { const out: { plan?: number[] } = {}; writePreviewPlan(out); return (out.plan?.length ?? 0) / PREVIEW_PLAN_STRIDE; };
/** A structure arrives in the snapshot; `renderable` = its swarm entry too. */
function land(id: number, renderable = true): void {
  mirror.structures.set(id, {});
  if (renderable) mirror.swarm.set(id, {});
}

beforeEach(() => {
  sent.length = 0;
  cancelPlacement();
  clearPlacementPlan();
  mirror.structures.clear();
  mirror.swarm.clear();
  setPlacementRotationDeg(0);
  setPlacementMirror(false);
  useUIStore.setState({
    buildMode: true, placementKind: 'solar', deck: false, packedStock: null, currentSectorKey: null, freeBuilds: false,
  });
});

describe('planned ghosts after Build lands', () => {
  it('stay drawn after the placed reply until every building is in the mirror and renderable', () => {
    land(1); // an older building already there
    place('solar', 100, 0);
    place('battery', 600, 0);
    expect(buildPlacementPlan()).toBe(true);
    onPlaceStructuresPlaced(lastBatchId());
    stepPlacementPlan(1000);
    expect(drawnPlanned()).toBe(2); // the reply came before the snapshot
    land(2);
    stepPlacementPlan(1100);
    expect(drawnPlanned()).toBe(2); // one of two in
    land(3, false);
    stepPlacementPlan(1200);
    expect(drawnPlanned()).toBe(2); // in the mirror, not drawn yet
    mirror.swarm.set(3, {});
    stepPlacementPlan(1300);
    expect(getPlacementPlanCount()).toBe(0);
  });

  it('drops at once when the snapshot came first', () => {
    place('solar', 100, 0);
    buildPlacementPlan();
    land(1);
    onPlaceStructuresPlaced(lastBatchId());
    expect(getPlacementPlanCount()).toBe(0);
  });

  it('drops on the timeout when the buildings never show', () => {
    place('solar', 100, 0);
    buildPlacementPlan();
    onPlaceStructuresPlaced(lastBatchId());
    stepPlacementPlan(1000);
    expect(getPlacementPlanCount()).toBe(1);
    stepPlacementPlan(1000 + PENDING_PLACEMENT_TIMEOUT_MS);
    expect(getPlacementPlanCount()).toBe(0);
  });

  it('nothing new is planned while the sent plan is landing', () => {
    place('solar', 100, 0);
    buildPlacementPlan();
    onPlaceStructuresPlaced(lastBatchId());
    expect(place('battery', 600, 0)).toBe(false);
  });
});

describe('the ghost held on the last planned spot after Build', () => {
  it('stays held (not red) on its own new building, until it moves', () => {
    expect(place('solar', 100, 0)).toBe(true);
    expect(isHeldOnPlanned('solar', 100, 0)).toBe(true);
    buildPlacementPlan();
    onPlaceStructuresPlaced(lastBatchId());
    land(1);
    stepPlacementPlan(1000);
    expect(getPlacementPlanCount()).toBe(0);
    expect(isHeldOnPlanned('solar', 100, 0)).toBe(true);
    expect(isHeldOnPlanned('solar', 140, 0)).toBe(false); // moved: the hold ends for good
    expect(isHeldOnPlanned('solar', 100, 0)).toBe(false);
  });
});
