import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hexCornerInto, type HexPoint } from '../../core/hex/hex.js';
import { DECK_HEX_INRADIUS } from '../../core/hex/deckCorners.js';
import { DECK_HEX_SIZE } from '../../core/hex/plates.js';
import { useUIStore } from '../state/store.js';
import { placementChosen, resetPlacementChosen } from './placementChosen.js';
import { endFenceRun, fenceRunAnchor, newFenceRunPlan, planGateRunInto, type FenceRunWorld } from './fenceRun.js';
import { commitPlacement } from './placementCancel.js';
import { pendingAfterSend } from './pendingPlacementRun.js';
import { isHeldOnSent, type PendingPlacement } from './structurePlacementClient.js';
import { snapPlacementToDeck } from '../../core/structures/deckPlacement.js';

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

  // Owner retest 2026-11-27 (build.ndjson): a second tap on a seam whose gate
  // had just landed showed a red ghost, yet Place still sent the gate and the
  // server refused it ("place_structure rejected", shield_gate, twice).
  it('a seam that already has its gate: Place sends nothing (the ghost is red)', () => {
    const a = corner(0), b = corner(1), m = mid(1);
    const g = snapPlacementToDeck('shield_gate', m.x, m.y, { x: 0, y: 0, q: 0, r: 0, rhombus: -1, rot: -1, slot: 'hex' });
    swarm.set(1, { x: a.x, y: a.y, angle: 0, shipKind: 'shield_pylon' }); structures.set(1, {});
    swarm.set(2, { x: b.x, y: b.y, angle: 0, shipKind: 'shield_pylon' }); structures.set(2, {});
    swarm.set(3, { x: g.x, y: g.y, angle: (g.rot * Math.PI) / 180, shipKind: 'shield_gate' }); structures.set(3, {});
    useUIStore.setState({ placementKind: 'shield_gate' });
    expect(place('shield_gate', m)).toBe(false);
    expect(send).not.toHaveBeenCalled();
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

// Owner phone playtest 2026-11-27: after a gate went down, the ghost stayed on
// that seam and at once read red ("Too close to another structure") over its
// own gate. The live ghost sits at the renderer's SNAPPED seam point; the sent
// gate (and its posts) must be recorded at that same point so the "just sent"
// hold (`isHeldOnSent`: dim, no verdict, Place refused) covers it, as it does
// for any other kind.
describe('fence run: the ghost is held on the spot just sent', () => {
  const SNAP = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, rot: -1, slot: 'hex' as const };
  beforeEach(() => {
    send.mockClear();
    notePendingPlacement.mockClear();
    structures.clear();
    swarm.clear();
    resetPlacementChosen();
    endFenceRun();
  });

  /** The pending record the client would hold after the sends. */
  function pendingFromSends(): PendingPlacement | null {
    let p: PendingPlacement | null = null;
    for (const c of notePendingPlacement.mock.calls) {
      p = pendingAfterSend(p, c[0], c[1], c[2], c[3], c[4], 1000, 0, c[5] ?? null);
    }
    return p;
  }

  it('a gate: the ghost at its snapped seam point is held after Place', () => {
    useUIStore.setState({ deck: true, placementKind: 'shield_gate', packedStock: null });
    const g = snapPlacementToDeck('shield_gate', mid(1).x, mid(1).y, SNAP);
    const gx = g.x, gy = g.y;
    expect(place('shield_gate', { x: gx, y: gy })).toBe(true);
    expect(isHeldOnSent('shield_gate', pendingFromSends(), gx, gy)).toBe(true);
  });

  it('a post: the ghost at its snapped corner is held after Place', () => {
    useUIStore.setState({ deck: true, placementKind: 'shield_pylon', packedStock: null });
    const c = snapPlacementToDeck('shield_pylon', corner(1).x, corner(1).y, SNAP);
    const cx = c.x, cy = c.y;
    expect(place('shield_pylon', { x: cx, y: cy })).toBe(true);
    expect(isHeldOnSent('shield_pylon', pendingFromSends(), cx, cy)).toBe(true);
  });
});
