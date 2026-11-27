import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hexCornerInto, type HexPoint } from '../../core/hex/hex.js';
import { DECK_HEX_INRADIUS } from '../../core/hex/deckCorners.js';
import { DECK_HEX_SIZE } from '../../core/hex/plates.js';
import { useUIStore } from '../state/store.js';
import { placementChosen, resetPlacementChosen } from './placementChosen.js';
import { endFenceRun, fenceRunAnchor, newFenceRunPlan, planGateRunInto, type FenceRunWorld } from './fenceRun.js';
import { commitPlacement } from './placementCancel.js';
import { pendingAfterSend } from './pendingPlacementRun.js';

// Edge feel P3: a gate in the fence run. Same client fixture as fenceRun.test.ts.
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

const OPEN: FenceRunWorld = { hasPost: () => false, rejection: () => null };
const pairs = (a: readonly number[]): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let n = 0; n + 1 < a.length; n += 2) out.push([a[n]!, a[n + 1]!]);
  return out;
};
function expectAt(p: readonly [number, number] | undefined, q: HexPoint): void {
  expect(p![0]).toBeCloseTo(q.x, 6);
  expect(p![1]).toBeCloseTo(q.y, 6);
}

function place(kind: 'shield_pylon' | 'shield_gate', p: HexPoint): boolean {
  placementChosen.worldX = p.x;
  placementChosen.worldY = p.y;
  placementChosen.held = false;
  return commitPlacement(kind);
}

describe('gate in a fence run: the plan', () => {
  it('a fresh gate fills both seam ends, then the gate at the midpoint; the run goes on from the far end', () => {
    const m = mid(1); // seam corner(0)–corner(1)
    const plan = planGateRunInto(newFenceRunPlan(), { active: false, x: 0, y: 0 }, m.x + 3, m.y - 2, [0, 0], OPEN);
    const sends = pairs(plan.sends);
    expect(sends.length).toBe(2);
    const ends = [corner(0), corner(1)];
    for (const e of ends) expect(sends.some(([x, y]) => Math.hypot(x - e.x, y - e.y) < 1e-6)).toBe(true);
    expect(plan.gate).toBe(true);
    expect(plan.gateX).toBeCloseTo(m.x, 6);
    expect(plan.gateY).toBeCloseTo(m.y, 6);
    expect(plan.anchorX).toBe(sends[1]![0]);
    expect(plan.anchorY).toBe(sends[1]![1]);
  });

  it('from an open run: posts along the path to the NEARER seam end, then the far end, then the gate', () => {
    const a = corner(4);
    const plan = planGateRunInto(newFenceRunPlan(), { active: true, x: a.x, y: a.y }, mid(1).x, mid(1).y, [0, 0], OPEN);
    const sends = pairs(plan.sends);
    expect(sends.length).toBe(3); // 5, 0 (the near end), then 1 (the far end)
    expectAt(sends[0], corner(5));
    expectAt(sends[1], corner(0));
    expectAt(sends[2], corner(1));
    expect(plan.gate).toBe(true);
    expect(plan.anchorX).toBeCloseTo(corner(1).x, 6);
    expect(plan.anchorY).toBeCloseTo(corner(1).y, 6);
  });

  it('existing posts at both ends: just the gate', () => {
    const has = (x: number, y: number): boolean => [corner(0), corner(1)].some((c) => Math.hypot(c.x - x, c.y - y) < 1);
    const plan = planGateRunInto(newFenceRunPlan(), { active: false, x: 0, y: 0 }, mid(1).x, mid(1).y, [0, 0], { hasPost: has, rejection: () => null });
    expect(plan.sends.length).toBe(0);
    expect(plan.gate).toBe(true);
  });

  it('a refused seam end stops the plan there: no gate', () => {
    const far = corner(1);
    const world: FenceRunWorld = { hasPost: () => false, rejection: (x, y) => (Math.hypot(x - far.x, y - far.y) < 1 ? 'overlap' : null) };
    const plan = planGateRunInto(newFenceRunPlan(), { active: true, x: corner(0).x, y: corner(0).y }, mid(1).x, mid(1).y, [0, 0], world);
    expect(plan.refused).toBe(true);
    expect(plan.gate).toBe(false);
  });
});

describe('gate in a fence run: Place sends', () => {
  beforeEach(() => {
    send.mockClear();
    notePendingPlacement.mockClear();
    structures.clear();
    swarm.clear();
    resetPlacementChosen();
    useUIStore.setState({ deck: true, placementKind: 'shield_pylon', packedStock: null });
    endFenceRun();
  });

  it('the Gate toggle keeps the run open; another pick still ends it', () => {
    place('shield_pylon', corner(4));
    useUIStore.setState({ placementKind: 'shield_gate' });
    expect(fenceRunAnchor().active).toBe(true);
    useUIStore.setState({ placementKind: 'shield_pylon' });
    expect(fenceRunAnchor().active).toBe(true);
    useUIStore.setState({ placementKind: 'solar' });
    expect(fenceRunAnchor().active).toBe(false);
  });

  it('a gate click sends the posts as shield_pylon, then one shield_gate last', () => {
    place('shield_pylon', corner(4));
    send.mockClear();
    useUIStore.setState({ placementKind: 'shield_gate' });
    expect(place('shield_gate', mid(1))).toBe(true);
    const kinds = send.mock.calls.map((c) => c[1].kind as string);
    expect(kinds).toEqual(['shield_pylon', 'shield_pylon', 'shield_pylon', 'shield_gate']);
    const g = send.mock.calls[3]![1];
    expect(g.x).toBeCloseTo(mid(1).x, 6);
    expect(g.y).toBeCloseTo(mid(1).y, 6);
    expect(fenceRunAnchor().x).toBeCloseTo(corner(1).x, 6);
    // Back to posts: the run continues from the gate's far end.
    useUIStore.setState({ placementKind: 'shield_pylon' });
    send.mockClear();
    place('shield_pylon', corner(2));
    expect(send.mock.calls.length).toBe(1);
    expect(send.mock.calls[0]![1].x).toBeCloseTo(corner(2).x, 6);
  });

  it('the pending record counts the posts and the gate as one run', () => {
    const a = corner(0), b = corner(1), m = mid(1);
    let p = pendingAfterSend(null, 'shield_pylon', a.x, a.y, 0, false, 1000, 10, [a.x, a.y, NaN, NaN, b.x, b.y]);
    p = pendingAfterSend(p, 'shield_pylon', b.x, b.y, 0, false, 1001, 10, []);
    p = pendingAfterSend(p, 'shield_gate', m.x, m.y, 0, false, 1002, 10, []);
    expect(p.sent).toBe(3);
    expect(p.kind).toBe('shield_gate');
    expect(p.run!.length).toBe(6);
  });
});
