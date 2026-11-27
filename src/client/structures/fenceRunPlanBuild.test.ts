import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hexCornerInto, type HexPoint } from '../../core/hex/hex.js';
import { DECK_HEX_INRADIUS } from '../../core/hex/deckCorners.js';
import { DECK_HEX_SIZE } from '../../core/hex/plates.js';
import { useUIStore } from '../state/store.js';
import { placementChosen, resetPlacementChosen } from './placementChosen.js';
import { endFenceRun, fenceRunAnchor } from './fenceRun.js';
import { buildPlacementPlan, cancelPlacement, commitPlacement, onPlaceStructuresPlaced } from './placementCancel.js';
import {
  addPlannedPlacement, clearPlacementPlan, getPlacementPlanCount, isPlannedPlacementRefused, plannedPlacements,
} from './placementPlan.js';
import { isHeldOnPlanned } from './structurePlacementClient.js';

// Plan then Build C3 (owner: "place multiple and then click go"): a fence run
// on a deck room PLANS its posts (and gate) like every other Place; Build
// sends them with the rest of the plan as one `place_structures`.
const send = vi.fn();
const notePendingPlacement = vi.fn();
const structures = new Map<number, { mirror?: boolean }>();
const swarm = new Map<number, { x: number; y: number; angle: number; shipKind: string }>();
const mirror = {
  localPlayerId: 'me', ships: new Map(), structures, swarm,
  pendingPlacementPreview: { kind: 'shield_pylon', x: 0, y: 0, angle: 0, deck: true, deckOwner: 'me', deckPlates: [0, 0], run: [] as number[] },
};
vi.mock('../net/clientSingleton.js', () => ({
  getGameClient: () => ({ mirror, getRoom: () => ({ send }), notePendingPlacement }),
}));

/** Corner `k` of the deck's middle hex (all on plate (0, 0)). */
const corner = (k: number): HexPoint => hexCornerInto(0, 0, DECK_HEX_SIZE, k, { x: 0, y: 0 });
/** Midpoint of the middle hex's edge `i` (between corners i − 1 and i). */
const mid = (i: number): HexPoint => ({ x: DECK_HEX_INRADIUS * Math.cos((i * Math.PI) / 3), y: DECK_HEX_INRADIUS * Math.sin((i * Math.PI) / 3) });

function click(kind: 'shield_pylon' | 'shield_gate', p: HexPoint): boolean {
  placementChosen.worldX = p.x;
  placementChosen.worldY = p.y;
  placementChosen.held = false;
  return commitPlacement(kind);
}

const placeStructureSends = (): number => send.mock.calls.filter((c) => c[0] === 'place_structure').length;

beforeEach(() => {
  send.mockClear();
  notePendingPlacement.mockClear();
  structures.clear();
  swarm.clear();
  resetPlacementChosen();
  cancelPlacement();
  clearPlacementPlan();
  useUIStore.setState({ deck: true, buildMode: true, placementKind: 'shield_pylon', packedStock: null, freeBuilds: true });
  endFenceRun();
});

describe('fence run: Place plans the posts (Plan then Build C3)', () => {
  it('a run of three clicks plans every post and sends nothing', () => {
    expect(click('shield_pylon', corner(0))).toBe(true);
    expect(click('shield_pylon', corner(2))).toBe(true);
    expect(click('shield_pylon', corner(4))).toBe(true);
    expect(send).not.toHaveBeenCalled();
    const items = plannedPlacements();
    expect(items.length).toBe(5); // corners 0..4
    for (let k = 0; k < 5; k++) {
      expect(items[k]!.kind).toBe('shield_pylon');
      expect(items[k]!.x).toBeCloseTo(corner(k).x, 6);
      expect(items[k]!.y).toBeCloseTo(corner(k).y, 6);
    }
    expect(fenceRunAnchor().x).toBeCloseTo(corner(4).x, 6);
  });

  it('a planned post counts as a post: continuing the run does not plan it twice', () => {
    click('shield_pylon', corner(0));
    click('shield_pylon', corner(2));
    endFenceRun();
    click('shield_pylon', corner(1)); // ON a planned post: removes it (the plan tap rule)
    expect(getPlacementPlanCount()).toBe(2);
    click('shield_pylon', corner(0)); // ON a planned post again
    expect(getPlacementPlanCount()).toBe(1);
  });

  it('a gate on a seam whose near end is already planned plans only the far end and the gate', () => {
    click('shield_pylon', corner(0));
    click('shield_pylon', corner(2)); // plans 0, 1, 2; the run is at 2
    useUIStore.setState({ placementKind: 'shield_gate' });
    expect(click('shield_gate', mid(3))).toBe(true); // seam corner(2)–corner(3)
    const kinds = plannedPlacements().map((p) => p.kind);
    expect(kinds).toEqual(['shield_pylon', 'shield_pylon', 'shield_pylon', 'shield_pylon', 'shield_gate']);
    expect(plannedPlacements()[3]!.x).toBeCloseTo(corner(3).x, 6);
    expect(send).not.toHaveBeenCalled();
  });

  it('the ghost is held on the post just planned', () => {
    click('shield_pylon', corner(0));
    expect(isHeldOnPlanned('shield_pylon', placementChosen.worldX, placementChosen.worldY)).toBe(true);
  });

  it('a gate click plans its seam posts, then the gate last; nothing is sent', () => {
    useUIStore.setState({ placementKind: 'shield_gate' });
    expect(click('shield_gate', mid(1))).toBe(true);
    expect(send).not.toHaveBeenCalled();
    const kinds = plannedPlacements().map((p) => p.kind);
    expect(kinds).toEqual(['shield_pylon', 'shield_pylon', 'shield_gate']);
    const g = plannedPlacements()[2]!;
    expect(g.x).toBeCloseTo(mid(1).x, 6);
    expect(g.y).toBeCloseTo(mid(1).y, 6);
  });

  it('Build sends the run with the rest of the plan as ONE place_structures', () => {
    click('shield_pylon', corner(0));
    click('shield_pylon', corner(2));
    expect(buildPlacementPlan()).toBe(true);
    expect(placeStructureSends()).toBe(0);
    const batches = send.mock.calls.filter((c) => c[0] === 'place_structures');
    expect(batches.length).toBe(1);
    const msg = batches[0]![1] as { batchId: number; items: Array<{ kind: string }> };
    expect(msg.items.length).toBe(3);
    expect(msg.items.every((i) => i.kind === 'shield_pylon')).toBe(true);
    onPlaceStructuresPlaced(msg.batchId);
    expect(getPlacementPlanCount()).toBe(0);
  });
});

describe('fence run: planned posts clash-check against the plan', () => {
  it('a post clashing with a planned building is refused by the batch check at Build', () => {
    click('shield_pylon', corner(0));
    click('shield_pylon', corner(2)); // plans 0, 1, 2
    // A building planned on top of post 1 (raw pose, off the run's rules).
    const c = corner(1);
    expect(addPlannedPlacement('connector', c.x + 6, c.y, 0, false, false)).toBe(true);
    expect(buildPlacementPlan()).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(isPlannedPlacementRefused(3)).toBe(true);
  });

  it('the run stops before a corner a planned building blocks (it is never planned)', () => {
    const c = corner(1);
    expect(addPlannedPlacement('connector', c.x + 6, c.y, 0, false, false)).toBe(true);
    click('shield_pylon', corner(0));
    click('shield_pylon', corner(2)); // path 0 → 1 → 2: 1 is blocked by the planned connector
    const posts = plannedPlacements().filter((p) => p.kind === 'shield_pylon');
    expect(posts.length).toBe(1);
    expect(posts[0]!.x).toBeCloseTo(corner(0).x, 6);
    expect(send).not.toHaveBeenCalled();
  });
});
