import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hexCornerInto, type HexPoint } from '../../core/hex/hex.js';
import { DECK_HEX_SIZE } from '../../core/hex/plates.js';
import { useUIStore } from '../state/store.js';
import { placementChosen, resetPlacementChosen } from './placementChosen.js';
import { endFenceRun, fenceRunAnchor, planFenceRun, type FenceRunWorld } from './fenceRun.js';
import { cancelPlacement, commitPlacement } from './placementCancel.js';
import { pendingAfterSend } from './pendingPlacementRun.js';
import { clearPlacementPlan, getPlacementPlanCount } from './placementPlan.js';
import { resolvePlacementPreviewStatus, type PlacementPreview } from './structurePlacementClient.js';

// The game client: place_structure sends are observable; the mirror holds the
// local deck (plate (0, 0)) and any posts a test puts on it.
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

/** Corner `k` of the deck's middle hex (all of its corners are on plate (0, 0)). */
function corner(k: number): HexPoint {
  return hexCornerInto(0, 0, DECK_HEX_SIZE, k, { x: 0, y: 0 });
}

function sentPoints(): Array<[number, number]> {
  return send.mock.calls.map((c) => [c[1].x as number, c[1].y as number]);
}

function addPost(id: number, p: HexPoint): void {
  structures.set(id, {});
  swarm.set(id, { x: p.x, y: p.y, angle: 0, shipKind: 'shield_pylon' });
}

function click(p: HexPoint): boolean {
  placementChosen.worldX = p.x;
  placementChosen.worldY = p.y;
  placementChosen.held = false;
  return commitPlacement('shield_pylon');
}

const OPEN: FenceRunWorld = { hasPost: () => false, rejection: () => null };

describe('fence run: the plan for one click', () => {
  it('a fresh run places just the clicked corner', () => {
    const c = corner(0);
    const plan = planFenceRun({ active: false, x: 0, y: 0 }, c.x + 5, c.y - 3, [0, 0], OPEN);
    expect(plan.sends.length).toBe(2);
    expect(plan.sends[0]).toBeCloseTo(c.x);
    expect(plan.sends[1]).toBeCloseTo(c.y);
    expect(plan.anchorOk).toBe(true);
  });

  it('fills every corner along the shortest edge path, skipping the run\'s own corner', () => {
    const a = corner(0), m = corner(1), b = corner(2);
    const plan = planFenceRun({ active: true, x: a.x, y: a.y }, b.x, b.y, [0, 0], OPEN);
    expect(plan.sends.length).toBe(4);
    expect(plan.sends[0]).toBeCloseTo(m.x); expect(plan.sends[1]).toBeCloseTo(m.y);
    expect(plan.sends[2]).toBeCloseTo(b.x); expect(plan.sends[3]).toBeCloseTo(b.y);
    expect(plan.drawn.length).toBe(6); // a, m, b
  });

  it('skips corners that already have a post', () => {
    const a = corner(0), m = corner(1), b = corner(2);
    const world: FenceRunWorld = { hasPost: (x, y) => Math.hypot(x - m.x, y - m.y) < 1, rejection: () => null };
    const plan = planFenceRun({ active: true, x: a.x, y: a.y }, b.x, b.y, [0, 0], world);
    expect(plan.sends.length).toBe(2);
    expect(plan.sends[0]).toBeCloseTo(b.x);
  });

  it('a refused corner is sent (the server says why) and ends the run there', () => {
    const a = corner(0), m = corner(1), b = corner(2);
    const world: FenceRunWorld = { hasPost: () => false, rejection: (x, y) => (Math.hypot(x - m.x, y - m.y) < 1 ? 'overlap-obstacle' : null) };
    const plan = planFenceRun({ active: true, x: a.x, y: a.y }, b.x, b.y, [0, 0], world);
    expect(plan.sends.length).toBe(2); // m only, never b
    expect(plan.sends[0]).toBeCloseTo(m.x);
    expect(plan.anchorOk).toBe(false);
  });
});

describe('fence run: Place on a deck sends one place_structure per missing corner', () => {
  beforeEach(() => {
    send.mockClear();
    notePendingPlacement.mockClear();
    structures.clear();
    swarm.clear();
    resetPlacementChosen();
    useUIStore.setState({ deck: true, placementKind: 'shield_pylon', packedStock: null });
    endFenceRun();
  });

  it('three clicks two edges apart each: posts on every corner between, at exact corners', () => {
    click(corner(0));
    click(corner(2));
    click(corner(4));
    const pts = sentPoints();
    expect(pts.length).toBe(5); // 0, 1, 2, 3, 4
    for (let k = 0; k < 5; k++) {
      expect(pts[k]![0]).toBeCloseTo(corner(k).x, 6);
      expect(pts[k]![1]).toBeCloseTo(corner(k).y, 6);
    }
    expect(send.mock.calls[0]![1]).toMatchObject({ type: 'place_structure', kind: 'shield_pylon' });
  });

  it('reuses existing posts (an existing post starts the run; 3 clicks = 2 edges)', () => {
    addPost(1, corner(0));
    addPost(2, corner(1));
    click(corner(0)); // existing: nothing sent, run starts here
    expect(send).not.toHaveBeenCalled();
    expect(fenceRunAnchor().active).toBe(true);
    click(corner(2)); // 1 already has a post
    expect(sentPoints().length).toBe(1);
    expect(sentPoints()[0]![0]).toBeCloseTo(corner(2).x);
  });

  it('the first send of a click carries the run corners for the pending ghost', () => {
    click(corner(0));
    click(corner(2));
    const runs = notePendingPlacement.mock.calls.map((c) => c[5] as number[]);
    expect(runs[1]!.length).toBe(6); // corners 0, 1, 2 on the click's first send
    expect(runs[2]!.length).toBe(0); // the click's second send adds none
  });

  it('Cancel or another pick ends the run', () => {
    click(corner(0));
    expect(fenceRunAnchor().active).toBe(true);
    useUIStore.setState({ placementKind: 'solar' });
    expect(fenceRunAnchor().active).toBe(false);
    useUIStore.setState({ placementKind: 'shield_pylon' });
    click(corner(0));
    expect(fenceRunAnchor().active).toBe(true);
    cancelPlacement();
    expect(fenceRunAnchor().active).toBe(false);
  });

  it('off a deck room a post is a plain place (no run): planned, not sent', () => {
    useUIStore.setState({ deck: false });
    clearPlacementPlan();
    click(corner(0));
    click(corner(2));
    expect(sentPoints().length).toBe(0);
    expect(getPlacementPlanCount()).toBe(2);
    clearPlacementPlan();
    expect(fenceRunAnchor().active).toBe(false);
  });
});

describe('fence run: the pending preview holds the run', () => {
  it('collects a run\'s sends into one record and shows its corners until all landed', () => {
    const a = corner(0), m = corner(1), b = corner(2);
    let p = pendingAfterSend(null, 'shield_pylon', m.x, m.y, 0, false, 1000, 10, [a.x, a.y, m.x, m.y, b.x, b.y]);
    p = pendingAfterSend(p, 'shield_pylon', b.x, b.y, 0, false, 1001, 10, []);
    expect(p.sent).toBe(2);
    expect(p.run!.length).toBe(6);
    const out: PlacementPreview = { kind: 'shield_pylon', x: 0, y: 0, angle: 0 };
    // Still placing (live ghost): the run shows beside it.
    expect(resolvePlacementPreviewStatus('shield_pylon', { x: 0, y: 0, angle: 0 }, p, 1100, 11, true, out)).toBe('active');
    expect(out.run).toEqual([a.x, a.y, m.x, m.y, b.x, b.y]);
    // Both posts landed: the run ghost goes.
    resolvePlacementPreviewStatus('shield_pylon', { x: 0, y: 0, angle: 0 }, p, 1100, 12, true, out);
    expect(out.run!.length).toBe(0);
    // Placement ended: the pending ghost keeps the run until it resolves.
    expect(resolvePlacementPreviewStatus(null, null, p, 1100, 11, true, out)).toBe('pending');
    expect(out.run!.length).toBe(6);
    expect(resolvePlacementPreviewStatus(null, null, p, 1100, 12, true, out)).toBe('cleared');
  });

  it('a second click\'s path joins after a break; a plain place starts fresh', () => {
    const a = corner(0), b = corner(1), c = corner(2);
    let p = pendingAfterSend(null, 'shield_pylon', b.x, b.y, 0, false, 0, 5, [a.x, a.y, b.x, b.y]);
    p = pendingAfterSend(p, 'shield_pylon', c.x, c.y, 0, false, 10, 5, [b.x, b.y, c.x, c.y]);
    expect(p.run!.length).toBe(10);
    expect(Number.isNaN(p.run![4])).toBe(true);
    const plain = pendingAfterSend(p, 'solar', 0, 0, 0, false, 20, 5, null);
    expect(plain.run).toBeUndefined();
    expect(plain.sent).toBeUndefined();
  });
});
