import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hexCornerInto, type HexPoint } from '../../core/hex/hex.js';
import { DECK_HEX_SIZE } from '../../core/hex/plates.js';
import { useUIStore } from '../state/store.js';
import { placementChosen, resetPlacementChosen } from './placementChosen.js';
import { endFenceRun, fenceRunRocks, mirrorFenceWorld, newFenceRunPlan, planFenceRunInto } from './fenceRun.js';
import { commitPlacement } from './placementCancel.js';
import { clearPlacementPlan, getPlacementPlanCount, plannedPlacements } from './placementPlan.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';

// P1 follow-up: the click plan checks the swarm's rocks, as the hover's red
// does, so a run stops at a rock instead of planning past it (the server
// refused that corner and built the posts beyond: a gap).
const send = vi.fn();
const notePendingPlacement = vi.fn();
const structures = new Map<number, { mirror?: boolean }>();
const swarm = new Map<number, Record<string, unknown>>();
const mirror = {
  localPlayerId: 'me', ships: new Map(), structures, swarm,
  pendingPlacementPreview: { kind: 'shield_pylon', x: 0, y: 0, angle: 0, deck: true, deckOwner: 'me', deckPlates: [0, 0], run: [] as number[] },
};
vi.mock('../net/clientSingleton.js', () => ({
  getGameClient: () => ({ mirror, getRoom: () => ({ send }), notePendingPlacement }),
}));

const corner = (k: number): HexPoint => hexCornerInto(0, 0, DECK_HEX_SIZE, k, { x: 0, y: 0 });
/** An ordinary asteroid on the swarm wire (no shape seed: its box). */
function rockAt(p: HexPoint): void {
  swarm.set(900, { kind: 0, x: p.x, y: p.y, angle: 0, radius: 40 });
}
function place(p: HexPoint): boolean {
  placementChosen.worldX = p.x;
  placementChosen.worldY = p.y;
  placementChosen.held = false;
  return commitPlacement('shield_pylon');
}

describe('fence run: rocks in the plan', () => {
  beforeEach(() => {
    send.mockClear();
    notePendingPlacement.mockClear();
    structures.clear();
    swarm.clear();
    resetPlacementChosen();
    clearPlacementPlan();
    useUIStore.setState({ deck: true, placementKind: 'shield_pylon', packedStock: null });
    endFenceRun();
  });

  it('a rock on a corner refuses the plan there', () => {
    rockAt(corner(5));
    const m = mirror as unknown as RenderMirror;
    const plan = planFenceRunInto(newFenceRunPlan(), { active: true, x: corner(4).x, y: corner(4).y }, corner(0).x, corner(0).y, [0, 0], mirrorFenceWorld(m, fenceRunRocks(m)));
    expect(plan.refused).toBe(true);
  });

  it('Place stops the run at the rock: neither it nor anything past it is planned', () => {
    place(corner(4));
    rockAt(corner(5));
    place(corner(0));
    expect(getPlacementPlanCount()).toBe(1); // corner 4 only
    for (const p of plannedPlacements()) {
      expect(Math.hypot(p.x - corner(0).x, p.y - corner(0).y)).toBeGreaterThan(1);
      expect(Math.hypot(p.x - corner(5).x, p.y - corner(5).y)).toBeGreaterThan(1);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('no rocks: the same run plans both posts', () => {
    place(corner(4));
    place(corner(0));
    expect(getPlacementPlanCount()).toBe(3); // 4, then 5 and 0
    expect(send).not.toHaveBeenCalled();
  });
});
