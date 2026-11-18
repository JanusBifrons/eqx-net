import { describe, expect, it } from 'vitest';
import {
  CLAIM_AT,
  RELEASE_AT,
  challengerOf,
  freshMultiControl,
  holderTrend,
  isMultiContested,
  stepMultiControl,
  targetShare,
  type MultiControlState,
  type OpposesFn,
  type SectorPresence,
  type SidePresence,
} from './sectorControl.js';

const P = (o: Partial<SidePresence>): SidePresence => ({ ships: 0, structures: 0, robots: 0, nexus: false, ...o });
const presence = (o: Record<string, Partial<SidePresence>>): SectorPresence =>
  new Map(Object.entries(o).map(([k, v]) => [k, P(v)]));

/** Everyone opposes everyone except the listed friendly pairs. */
const opposesExcept = (...friends: [string, string][]): OpposesFn => (a, b) =>
  a !== b && !friends.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
const ALL_HOSTILE = opposesExcept();

function run(s: MultiControlState, p: SectorPresence, op: OpposesFn, seconds: number): number {
  let flips = 0;
  for (let t = 0; t < seconds; t++) if (stepMultiControl(s, p, op, 1000).flipped) flips++;
  return flips;
}

describe('sector control for every side', () => {
  it('robots vs players: robots push up, players and their bases push back', () => {
    for (const [robots, nexus, structures, ships] of [
      [4, false, 0, 0], [6, true, 3, 2], [1, false, 6, 1], [0, true, 0, 5], [100, true, 0, 0],
    ] as const) {
      const want = Math.max(0, Math.min(100, robots * 12 + (nexus ? 80 : 0) - structures * 6 - ships * 15));
      const p = presence({ robots: { robots, nexus }, alice: { ships, structures } });
      expect(targetShare('robots', p, ALL_HOSTILE)).toBe(want);
    }
  });

  it('robots claim a nexus sector, hold it through a dip, and lose it to players + bases', () => {
    const s = freshMultiControl();
    expect(run(s, presence({ robots: { robots: 2, nexus: true } }), ALL_HOSTILE, 120)).toBe(1);
    expect(s.holder).toBe('robots');
    // Players push back a little: the share falls but stays above RELEASE_AT.
    expect(run(s, presence({ robots: { robots: 2, nexus: true }, alice: { ships: 2 } }), ALL_HOSTILE, 60)).toBe(0);
    expect(s.shares.get('robots')!).toBeGreaterThan(RELEASE_AT);
    expect(isMultiContested(s, presence({ robots: { nexus: true }, alice: { ships: 1 } }), ALL_HOSTILE)).toBe(true);
    expect(isMultiContested(s, presence({ robots: { nexus: true } }), ALL_HOSTILE)).toBe(false);
    run(s, presence({ alice: { ships: 3, structures: 4 } }), ALL_HOSTILE, 120);
    expect(s.holder).not.toBe('robots');
  });

  it('any side can claim neutral ground — not only robots', () => {
    const s = freshMultiControl();
    run(s, presence({ alice: { ships: 4, structures: 2 } }), ALL_HOSTILE, 60);
    expect(s.holder).toBe('alice');
  });

  it('a passing ship does not flip a sector instantly', () => {
    const s = freshMultiControl();
    stepMultiControl(s, presence({ alice: { ships: 6 } }), ALL_HOSTILE, 1000);
    expect(s.holder).toBeNull();
    expect(s.shares.get('alice')!).toBeLessThan(CLAIM_AT);
  });

  it('held ground with nobody there stays held', () => {
    const s = freshMultiControl('sol');
    expect(run(s, presence({}), ALL_HOSTILE, 600)).toBe(0);
    expect(s.holder).toBe('sol');
  });

  it('a seeded heartland is capturable: the attacker claims only once the holder has released', () => {
    const s = freshMultiControl('sol');
    const attack = presence({ crimson: { ships: 6, structures: 2 } });
    for (let t = 0; t < 300 && s.holder !== 'crimson'; t++) {
      const solBefore = s.shares.get('sol') ?? 0;
      stepMultiControl(s, attack, ALL_HOSTILE, 1000);
      // Never a takeover while Sol still holds above RELEASE_AT.
      if (s.holder === 'crimson') expect(s.shares.get('sol') ?? 0).toBeLessThanOrEqual(RELEASE_AT);
      expect(solBefore).toBeGreaterThan(0);
    }
    expect(s.holder).toBe('crimson');
  });

  it('hysteresis: a dip above RELEASE_AT keeps the holder', () => {
    const s = freshMultiControl('sol');
    // Sol 4 ships (60) vs crimson 2 ships (30): target 30, above RELEASE_AT.
    expect(run(s, presence({ sol: { ships: 4 }, crimson: { ships: 2 } }), ALL_HOSTILE, 120)).toBe(0);
    expect(s.holder).toBe('sol');
    expect(s.shares.get('sol')!).toBeGreaterThan(RELEASE_AT);
  });

  it('allies never weaken each other: traders in a Sol hub keep it Sol', () => {
    const op = opposesExcept(['sol', 'traders']);
    const s = freshMultiControl('sol');
    expect(run(s, presence({ traders: { ships: 5, structures: 4 } }), op, 600)).toBe(0);
    expect(s.holder).toBe('sol');
    expect(s.shares.get('sol')!).toBeGreaterThan(CLAIM_AT);
  });

  it('allies add up against a common enemy', () => {
    const op = opposesExcept(['sol', 'traders']);
    const p = presence({ sol: { ships: 2 }, traders: { ships: 2 }, crimson: { ships: 3 } });
    expect(targetShare('sol', p, op)).toBe(15); // 60 − 45
    expect(targetShare('crimson', p, op)).toBe(0);
  });

  it('challenger, trend and contested describe the fight', () => {
    const s = freshMultiControl('sol');
    const p = presence({ sol: { ships: 1 }, crimson: { ships: 3 }, drones: { robots: 1 } });
    stepMultiControl(s, p, ALL_HOSTILE, 1000);
    expect(isMultiContested(s, p, ALL_HOSTILE)).toBe(true);
    expect(holderTrend(s, p, ALL_HOSTILE)).toBe(-1);
    run(s, p, ALL_HOSTILE, 20);
    expect(challengerOf(s, ALL_HOSTILE)?.factionId).toBe('crimson');
  });

  it('a gone side decays out of the map instead of piling up', () => {
    const s = freshMultiControl();
    run(s, presence({ alice: { ships: 1 } }), ALL_HOSTILE, 10);
    run(s, presence({ bob: { ships: 4 } }), ALL_HOSTILE, 30);
    expect(s.shares.has('alice')).toBe(false);
  });
});

describe('sector lock (frozen until destroyed)', () => {
  const ROBOT_LOCK: ReadonlySet<string> = new Set(['robots']);
  const siege = presence({ robots: { nexus: true }, alice: { ships: 20, structures: 10 } });
  const runLocked = (s: MultiControlState, p: SectorPresence, seconds: number, locks: ReadonlySet<string> | null): number => {
    let flips = 0;
    for (let t = 0; t < seconds; t++) if (stepMultiControl(s, p, ALL_HOSTILE, 1000, locks).flipped) flips++;
    return flips;
  };

  it('a locked holder survives an overwhelming challenger', () => {
    const s = freshMultiControl('robots');
    expect(runLocked(s, siege, 600, ROBOT_LOCK)).toBe(0);
    expect(s.holder).toBe('robots');
  });

  it('shares, challenger, trend and contested still move while locked', () => {
    const s = freshMultiControl('robots');
    runLocked(s, siege, 120, ROBOT_LOCK);
    expect(s.shares.get('robots')!).toBeLessThan(RELEASE_AT);
    expect(s.shares.get('alice')!).toBeGreaterThan(CLAIM_AT);
    expect(challengerOf(s, ALL_HOSTILE)).toEqual({ factionId: 'alice', share: s.shares.get('alice') });
    expect(isMultiContested(s, siege, ALL_HOSTILE)).toBe(true);
    // The robots' share is pinned at 0 here (target 0), so the trend is steady;
    // part-way down it reads as losing ground.
    const mid = freshMultiControl('robots');
    runLocked(mid, siege, 5, ROBOT_LOCK);
    expect(holderTrend(mid, siege, ALL_HOSTILE)).toBe(-1);
  });

  it('once the lock is gone, the normal release happens on the next step', () => {
    const s = freshMultiControl('robots');
    runLocked(s, siege, 120, ROBOT_LOCK);
    expect(s.holder).toBe('robots');
    const after = presence({ alice: { ships: 20, structures: 10 } });
    const r = stepMultiControl(s, after, ALL_HOSTILE, 1000, null);
    expect(r).toEqual({ flipped: true, previousHolder: 'robots' });
    expect(s.holder).toBe('alice');
  });

  it('a lock the holder does not own does nothing', () => {
    const s = freshMultiControl('robots');
    const flips = runLocked(s, siege, 120, new Set(['alice']));
    expect(flips).toBe(1);
    expect(s.holder).toBe('alice');
    // …and a lock held by nobody present on neutral ground doesn't stop a claim.
    const n = freshMultiControl();
    runLocked(n, presence({ bob: { ships: 6 } }), 60, ROBOT_LOCK);
    expect(n.holder).toBe('bob');
  });

  it('no lock argument = the unlocked meter (parity)', () => {
    const a = freshMultiControl('robots');
    const b = freshMultiControl('robots');
    for (let t = 0; t < 120; t++) {
      expect(stepMultiControl(a, siege, ALL_HOSTILE, 1000)).toEqual(stepMultiControl(b, siege, ALL_HOSTILE, 1000, new Set()));
    }
    expect(a).toEqual(b);
  });
});
