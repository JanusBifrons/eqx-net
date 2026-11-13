/**
 * Fire-lane awareness (AI slice 5b): the blocked-fire nudge steps AWAY from
 * the ally in the way, and a wingman's fire lane masks headings that cross it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  AimBoard,
  addAllyLaneDanger,
  blockedNudgeSide,
  insideAllyLane,
  persistentBlockBias,
  PERSISTENT_BLOCKS,
  BLOCK_RUN_BIAS_MAX,
  AIM_STALE_TICKS,
  setFireLaneAvoidance,
} from './fireLanes.js';
import {
  angleForDir,
  addInterestToward,
  createContextMaps,
  makeContextOutput,
  resolveContext,
  CONTEXT_SLOTS,
  slotDirX,
  slotDirY,
} from '../contextSteering.js';
import { HostileDroneBehaviour } from '../HostileDroneBehaviour.js';
import type { AiEntity, AiSwarmView, AiWorldView, IAiNeighbourQuery } from '../../contracts/IAiBehaviour.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';

const DRONE = getShipKind('fighter');

interface Nb { id: string; x: number; y: number; side: string }

function query(list: Nb[]): IAiNeighbourQuery {
  return {
    count: list.length,
    queryNeighbours(x, y, r, maxK, out, excludeId) {
      const hits = list
        .map((e, i) => ({ i, d: Math.hypot(e.x - x, e.y - y), id: e.id }))
        .filter((h) => h.d <= r && h.id !== excludeId)
        .sort((a, b) => a.d - b.d || a.i - b.i);
      const n = Math.min(hits.length, maxK, out.length);
      for (let k = 0; k < n; k++) out[k] = hits[k]!.i;
      return n;
    },
    idAt: (i) => list[i]!.id,
    xAt: (i) => list[i]!.x,
    yAt: (i) => list[i]!.y,
    vxAt: () => 0,
    vyAt: () => 0,
    radiusAt: () => DRONE.radius,
    sideAt: (i) => list[i]!.side,
    isPilotAt: () => false,
  };
}

const SELF: AiEntity = { id: 'd1', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
// A robot up +y: drones engage robots on sight and hold along +y. Close
// enough to be in fire range so the nose stays on the lead.
const ROBOT: AiSwarmView = { id: 'r1', x: 0, y: 500, vx: 0, vy: 0, allegiance: 'robots' };

afterEach(() => setFireLaneAvoidance(true));

describe('blockedNudgeSide', () => {
  it('steps to the side away from the blocker', () => {
    // Target line +y; left-hand normal is -x.
    expect(blockedNudgeSide(0, 0, 0, 1, -30, 150, 0, 0)).toBe(-1); // blocker left → step right (+x)
    expect(blockedNudgeSide(0, 0, 0, 1, 30, 150, 0, 0)).toBe(1); // blocker right → step left (-x)
  });
  it('a blocker dead on the line keeps the current drift', () => {
    expect(blockedNudgeSide(0, 0, 0, 1, 0, 150, 50, 0)).toBe(-1); // drifting +x = right
    expect(blockedNudgeSide(0, 0, 0, 1, 0, 150, -50, 0)).toBe(1);
  });
});

describe('persistentBlockBias', () => {
  it('is 0 for a stray block, grows with persistent blocking, capped, and off with the seam', () => {
    expect(persistentBlockBias(1)).toBe(0);
    expect(persistentBlockBias(PERSISTENT_BLOCKS)).toBeGreaterThan(0);
    expect(persistentBlockBias(100)).toBe(BLOCK_RUN_BIAS_MAX);
    setFireLaneAvoidance(false);
    expect(persistentBlockBias(100)).toBe(0);
  });
});

describe('AimBoard', () => {
  it('reads a fresh aim, forgets a stale one, recycles slots and grows', () => {
    const b = new AimBoard();
    b.add('a');
    expect(b.read('a', 10)).toBe(false); // never aimed
    b.write('a', 5, 6, 10);
    expect(b.read('a', 10 + AIM_STALE_TICKS)).toBe(true);
    expect([b.readX, b.readY]).toEqual([5, 6]);
    expect(b.read('a', 11 + AIM_STALE_TICKS)).toBe(false);
    b.write('ghost', 1, 1, 10); // unregistered: ignored
    expect(b.read('ghost', 10)).toBe(false);
    b.remove('a');
    expect(b.read('a', 10)).toBe(false);
    for (let i = 0; i < 200; i++) b.add('e' + i);
    b.write('e199', 7, 8, 3);
    expect(b.read('e199', 3)).toBe(true);
    expect(b.readX).toBe(7);
  });
});

describe('addAllyLaneDanger', () => {
  it('a wingman firing across my path masks the crossing headings, not the parallel ones', () => {
    const m = createContextMaps();
    // Wingman at (-300, 150) firing at (+500, 150): its lane runs across +y.
    addAllyLaneDanger(m, 0, 0, -300, 150, 500, 150, 30, 300, 0.8);
    const slotOf = (dx: number, dy: number): number => {
      let best = 0; let bd = -2;
      for (let i = 0; i < CONTEXT_SLOTS; i++) {
        const d = slotDirX(i) * dx + slotDirY(i) * dy;
        if (d > bd) { bd = d; best = i; }
      }
      return best;
    };
    expect(m.danger[slotOf(0, 1)]!).toBeGreaterThan(0.3); // straight across
    expect(m.danger[slotOf(1, 0)]!).toBe(0); // parallel
    expect(m.danger[slotOf(0, -1)]!).toBe(0); // away
    // With interest straight ahead, the resolver picks a heading that does not cross.
    addInterestToward(m, 0, 1, 1, 2);
    const out = resolveContext(m, makeContextOutput());
    expect(Math.abs(out.angle - angleForDir(0, 1))).toBeGreaterThan(0.3);
  });
});

function tickWith(opts: { nbs?: Nb[]; aims?: AimBoard; block?: { x: number; y: number } }) {
  const b = new HostileDroneBehaviour(DRONE);
  if (opts.block) b.noteBlocked(100, opts.block.x, opts.block.y);
  const view: AiWorldView = {
    players: [], tick: 100, dtSec: 1 / 60, swarms: [ROBOT],
    neighbours: query(opts.nbs ?? []),
    ...(opts.aims ? { aims: opts.aims } : {}),
  };
  b.tick(SELF, view);
  return { b, steer: b.lastCombatSteer()! };
}

describe('HostileDroneBehaviour — blocked-fire nudge', () => {
  it('without a block it flies the target line', () => {
    const { steer, b } = tickWith({});
    expect(Math.abs(steer.dirX)).toBeLessThan(0.2);
    expect(b.getNudgeTicks()).toBe(0);
  });

  it('a block by an ally on my left side-steps right, and vice versa', () => {
    const left = tickWith({ block: { x: -30, y: 150 } });
    expect(left.b.getNudgeTicks()).toBe(1);
    expect(left.steer.dirX, 'steps right (+x), away from the blocker').toBeGreaterThan(0.5);
    const right = tickWith({ block: { x: 30, y: 150 } });
    expect(right.steer.dirX, 'steps left (-x)').toBeLessThan(-0.5);
  });

  it('the seam turns it off', () => {
    setFireLaneAvoidance(false);
    const { steer, b } = tickWith({ block: { x: -30, y: 150 } });
    expect(b.getNudgeTicks()).toBe(0);
    expect(Math.abs(steer.dirX)).toBeLessThan(0.2);
  });
});

describe('HostileDroneBehaviour — ally fire lanes', () => {
  it("does not head across a wingman's line of fire", () => {
    const aims = new AimBoard();
    aims.add('d2');
    // A wingman to my left firing across my approach line at the robot's flank.
    aims.write('d2', 500, 80, 100);
    const nbs = [{ id: 'd2', x: -500, y: 80, side: 'drones' }];
    const clear = tickWith({ nbs });
    expect(Math.abs(clear.steer.dirX), 'no aim on the board: straight on').toBeLessThan(0.2);
    const lane = tickWith({ nbs, aims });
    expect(Math.abs(lane.steer.angle - angleForDir(0, 1)), 'the crossing heading is masked').toBeGreaterThan(0.3);
    setFireLaneAvoidance(false);
    const off = tickWith({ nbs, aims });
    expect(Math.abs(off.steer.dirX), 'seam off: straight on').toBeLessThan(0.2);
  });
});

describe('insideAllyLane', () => {
  it('is true alongside the lane, false beside it or past its cut end', () => {
    // Lane (0,0) → (0,1000), cut at 80 % → 800.
    expect(insideAllyLane(10, 400, 0, 0, 0, 1000, 30)).toBe(true);
    expect(insideAllyLane(40, 400, 0, 0, 0, 1000, 30)).toBe(false);
    expect(insideAllyLane(0, 900, 0, 0, 0, 1000, 30)).toBe(false);
    expect(insideAllyLane(0, -10, 0, 0, 0, 1000, 30)).toBe(false);
  });
});
