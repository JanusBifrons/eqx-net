import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hexCornerInto, type HexPoint } from '../../core/hex/hex.js';
import { DECK_HEX_SIZE } from '../../core/hex/plates.js';
import { useUIStore } from '../state/store.js';
import { placementChosen, resetPlacementChosen } from './placementChosen.js';
import { endFenceRun, newFenceRunPlan, planFenceRun, planFenceRunInto, type FenceRunWorld } from './fenceRun.js';
import { resetFenceRunHover, writePreviewHoverRun } from './fenceRunHover.js';
import { commitPlacement } from './placementCancel.js';
import type { PlacementPreview } from './structurePlacementClient.js';

// The game client: sends are observable; the mirror's preview IS the hover's
// scratch (as in the mirror passes), so the click reads the same object.
const send = vi.fn();
const notePendingPlacement = vi.fn();
const structures = new Map<number, { mirror?: boolean }>();
const swarm = new Map<number, { x: number; y: number; angle: number; shipKind: string }>();
const preview: PlacementPreview = {
  kind: 'shield_pylon', x: 0, y: 0, angle: 0, deck: true, deckOwner: 'me', deckPlates: [0, 0], run: [],
};
const mirror = { localPlayerId: 'me', ships: new Map(), structures, swarm, pendingPlacementPreview: preview };
vi.mock('../net/clientSingleton.js', () => ({
  getGameClient: () => ({ mirror, getRoom: () => ({ send }), notePendingPlacement }),
}));

/** Corner `k` of the deck's middle hex (all on plate (0, 0)). */
function corner(k: number): HexPoint {
  return hexCornerInto(0, 0, DECK_HEX_SIZE, k, { x: 0, y: 0 });
}
function click(p: HexPoint): boolean {
  placementChosen.worldX = p.x; placementChosen.worldY = p.y; placementChosen.held = false;
  return commitPlacement('shield_pylon');
}
function hoverAt(x: number, y: number, active = true): boolean {
  return writePreviewHoverRun(preview, mirror as never, active, x, y);
}
const hover = (p: HexPoint): boolean => hoverAt(p.x, p.y);

const OPEN: FenceRunWorld = { hasPost: () => false, rejection: () => null };

describe('planFenceRunInto', () => {
  it('gives the same plan as planFenceRun, reusing its arrays', () => {
    const out = newFenceRunPlan();
    const sends = out.sends;
    const cases: Array<[boolean, number, number]> = [[false, 0, 0], [true, 0, 3], [true, 1, 4], [true, 2, 2]];
    for (const [active, a, b] of cases) {
      const from = { active, x: corner(a).x, y: corner(a).y };
      const ref = planFenceRun(from, corner(b).x, corner(b).y, [0, 0], OPEN);
      planFenceRunInto(out, from, corner(b).x, corner(b).y, [0, 0], OPEN);
      expect(out).toEqual(ref);
      expect(out.sends).toBe(sends);
    }
  });

  it('reach includes the refused corner; drawn stops before it', () => {
    const m = corner(1);
    const world: FenceRunWorld = { hasPost: () => false, rejection: (x, y) => (Math.hypot(x - m.x, y - m.y) < 1 ? 'overlap-obstacle' : null) };
    const plan = planFenceRun({ active: true, x: corner(0).x, y: corner(0).y }, corner(2).x, corner(2).y, [0, 0], world);
    expect(plan.refused).toBe(true);
    expect(plan.reach.length).toBe(4); // corners 0, 1
    expect(plan.drawn.length).toBe(0);
  });
});

describe('the fence run hover preview', () => {
  beforeEach(() => {
    send.mockClear(); notePendingPlacement.mockClear();
    structures.clear(); swarm.clear();
    preview.run = []; preview.runHover = undefined; preview.runHoverMark = undefined; preview.held = false;
    preview.deckPlates = [0, 0];
    resetPlacementChosen(); resetFenceRunHover();
    useUIStore.setState({ deck: true, placementKind: 'shield_pylon', packedStock: null });
    endFenceRun();
  });

  it('nothing before the first corner click (no open run)', () => {
    hover(corner(2));
    expect(preview.runHover?.length ?? 0).toBe(0);
  });

  it('after the first click: the whole run with a mark per corner, plain numbers, `run` untouched', () => {
    click(corner(0));
    hover(corner(3));
    expect(preview.runHover!.length).toBe(8); // corners 0, 1, 2, 3
    expect(preview.runHoverMark).toEqual([0, 1, 1, 1]);
    expect(preview.runHover!.every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true);
    expect(structuredClone(preview).runHover).toEqual(preview.runHover);
    expect(preview.run).toEqual([]);
  });

  it('a click after hovering still sends every missing corner', () => {
    click(corner(0));
    send.mockClear();
    hover(corner(3));
    click(corner(3));
    expect(send.mock.calls.length).toBe(3); // corners 1, 2, 3
  });

  it('recomputes only when its key changes', () => {
    click(corner(0));
    expect(hover(corner(3))).toBe(true);
    expect(hover(corner(3))).toBe(false);
    const c = corner(3);
    expect(hoverAt(c.x + 2, c.y - 1)).toBe(false); // same corner
    expect(hover(corner(2))).toBe(true);
    expect(hover(corner(2))).toBe(false);
    structures.set(9, {});
    swarm.set(9, { x: corner(1).x, y: corner(1).y, angle: 0, shipKind: 'shield_pylon' });
    expect(hover(corner(2))).toBe(true); // a post landed
    expect(preview.runHoverMark).toEqual([0, 0, 1]);
    preview.deckPlates = [0, 0, 1, 0];
    expect(hover(corner(2))).toBe(true); // plates changed
  });

  it('clears when the ghost is not the live one', () => {
    click(corner(0));
    hover(corner(3));
    hoverAt(corner(3).x, corner(3).y, false);
    expect(preview.runHover!.length).toBe(0);
    expect(preview.runHoverMark!.length).toBe(0);
  });
});
