import { describe, it, expect } from 'vitest';
import { GALAXY_SECTORS, getEntrySectors, isEntrySector } from '../../core/galaxy/galaxy.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';
import {
  apportion,
  computeDesiredDistribution,
  nextHopToward,
  planMigrations,
  pickRespawnSector,
  sectorEdgePose,
  makeSeededRng,
  liveEntrySectors,
  pickEntrySector,
  pickRoamGoal,
  MIN_PACK_PER_OCCUPIED,
} from './population.js';

const KEYS = GALAXY_SECTORS.map((s) => s.key);
// Canonical order asserted so the largest-remainder tie-break math below
// stays anchored if the galaxy is ever reordered.
const sum = (m: ReadonlyMap<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

describe('apportion (largest-remainder)', () => {
  it('sums to total and splits evenly when weights are equal', () => {
    const w = new Map(KEYS.map((k) => [k, 1] as const));
    const out = apportion(w, 25, KEYS);
    expect(sum(out)).toBe(25);
    // 25/7 = 3 each + 4 remainder seats to the first 4 keys in order.
    expect(out.get(KEYS[0]!)).toBe(4);
    expect(out.get(KEYS[3]!)).toBe(4);
    expect(out.get(KEYS[4]!)).toBe(3);
    expect(out.get(KEYS[6]!)).toBe(3);
  });

  it('is proportional to weights', () => {
    const w = new Map<string, number>([
      [KEYS[0]!, 1],
      [KEYS[1]!, 3],
    ]);
    const out = apportion(w, 8, [KEYS[0]!, KEYS[1]!]);
    expect(out.get(KEYS[0]!)).toBe(2);
    expect(out.get(KEYS[1]!)).toBe(6);
    expect(sum(out)).toBe(8);
  });

  it('all-zero weights degrades to an even split', () => {
    const w = new Map(KEYS.map((k) => [k, 0] as const));
    const out = apportion(w, 7, KEYS);
    expect(sum(out)).toBe(7);
    for (const k of KEYS) expect(out.get(k)).toBe(1);
  });

  it('total 0 and empty keys are no-ops', () => {
    expect(sum(apportion(new Map(), 0, KEYS))).toBe(0);
    expect(apportion(new Map(), 10, []).size).toBe(0);
  });
});

describe('computeDesiredDistribution', () => {
  it('spreads evenly across every sector when no players are online', () => {
    const out = computeDesiredDistribution({
      sectorKeys: KEYS,
      playerCounts: new Map(),
      budget: 25,
    });
    expect(sum(out)).toBe(25);
    // Same shape as the equal-weight apportionment.
    expect(out.get(KEYS[0]!)).toBe(4);
    expect(out.get(KEYS[6]!)).toBe(3);
    expect([...out.values()].every((v) => v >= 3)).toBe(true);
  });

  it('funnels the whole budget toward the only player-occupied sector', () => {
    const target = KEYS[3]!;
    const out = computeDesiredDistribution({
      sectorKeys: KEYS,
      playerCounts: new Map([[target, 2]]),
      budget: 25,
    });
    expect(sum(out)).toBe(25);
    expect(out.get(target)).toBe(25);
    for (const k of KEYS) if (k !== target) expect(out.get(k)).toBe(0);
  });

  it('splits proportionally across occupied sectors with a min-pack floor', () => {
    const a = KEYS[0]!;
    const b = KEYS[3]!;
    const out = computeDesiredDistribution({
      sectorKeys: KEYS,
      playerCounts: new Map([
        [a, 1],
        [b, 3],
      ]),
      budget: 25,
    });
    expect(sum(out)).toBe(25);
    expect(out.get(a)!).toBeGreaterThanOrEqual(MIN_PACK_PER_OCCUPIED);
    expect(out.get(b)!).toBeGreaterThanOrEqual(MIN_PACK_PER_OCCUPIED);
    // 3× player weight ⇒ the busier sector gets the larger pack.
    expect(out.get(b)!).toBeGreaterThan(out.get(a)!);
    for (const k of KEYS) if (k !== a && k !== b) expect(out.get(k)).toBe(0);
  });

  it('degrades to pure proportional when the budget cannot floor everyone', () => {
    const occ = [KEYS[1]!, KEYS[2]!, KEYS[3]!];
    const out = computeDesiredDistribution({
      sectorKeys: KEYS,
      playerCounts: new Map([
        [occ[0]!, 1],
        [occ[1]!, 1],
        [occ[2]!, 2],
      ]),
      budget: 4, // < MIN_PACK_PER_OCCUPIED * 3 = 6
    });
    expect(sum(out)).toBe(4);
    expect(out.get(occ[2]!)!).toBeGreaterThanOrEqual(out.get(occ[0]!)!);
    for (const k of KEYS) if (!occ.includes(k)) expect(out.get(k)).toBe(0);
  });

  it('places nothing when the budget is exhausted', () => {
    const out = computeDesiredDistribution({
      sectorKeys: KEYS,
      playerCounts: new Map([[KEYS[0]!, 5]]),
      budget: 0,
    });
    expect(sum(out)).toBe(0);
  });
});

describe('nextHopToward (galaxy BFS)', () => {
  it('returns the destination directly when it is a neighbour', () => {
    // sol-prime is the hub: every outer is a direct neighbour.
    expect(nextHopToward('sol-prime', 'orion-belt')).toBe('orion-belt');
  });

  it('routes a 2-hop path through the hub deterministically', () => {
    // orion-belt → cygnus-arm is 2 hops; the hub is the first step.
    expect(nextHopToward('orion-belt', 'cygnus-arm')).toBe('sol-prime');
  });

  it('returns null for same-sector or unknown keys', () => {
    expect(nextHopToward('sol-prime', 'sol-prime')).toBeNull();
    expect(nextHopToward('sol-prime', 'nowhere')).toBeNull();
    expect(nextHopToward('nowhere', 'sol-prime')).toBeNull();
  });
});

describe('planMigrations', () => {
  it('moves surplus bots one hop toward the deficit sector', () => {
    const out = planMigrations({
      sectorKeys: KEYS,
      current: new Map([['sol-prime', ['b1', 'b2', 'b3']]]),
      desired: new Map([
        ['sol-prime', 1],
        ['orion-belt', 2],
      ]),
      maxPerTick: 5,
    });
    expect(out).toHaveLength(2);
    for (const m of out) {
      expect(m.from).toBe('sol-prime');
      expect(m.to).toBe('orion-belt'); // direct neighbour
    }
    expect(new Set(out.map((m) => m.botId)).size).toBe(2);
  });

  it('routes via the first hop when the deficit sector is 2 hops away', () => {
    const out = planMigrations({
      sectorKeys: KEYS,
      current: new Map([['cygnus-arm', ['c1', 'c2']]]),
      desired: new Map([
        ['cygnus-arm', 0],
        ['orion-belt', 2],
      ]),
      maxPerTick: 5,
    });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]!.from).toBe('cygnus-arm');
    expect(out[0]!.to).toBe('sol-prime'); // first hop toward orion-belt
  });

  it('respects maxPerTick', () => {
    const out = planMigrations({
      sectorKeys: KEYS,
      current: new Map([['sol-prime', ['b1', 'b2', 'b3']]]),
      desired: new Map([
        ['sol-prime', 0],
        ['orion-belt', 3],
      ]),
      maxPerTick: 1,
    });
    expect(out).toHaveLength(1);
  });

  it('counts frozen (arrival-cooldown) bots toward occupancy but never moves them', () => {
    const out = planMigrations({
      sectorKeys: KEYS,
      current: new Map([['sol-prime', ['b1', 'b2', 'b3']]]),
      desired: new Map([
        ['sol-prime', 1],
        ['orion-belt', 2],
      ]),
      maxPerTick: 5,
      frozen: new Set(['b1', 'b2']), // only b3 is movable
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.botId).toBe('b3');
    expect(out[0]!.from).toBe('sol-prime');
    expect(out[0]!.to).toBe('orion-belt');
  });

  it('does nothing when supply already matches demand (hysteresis)', () => {
    const out = planMigrations({
      sectorKeys: KEYS,
      current: new Map([
        ['sol-prime', ['a']],
        ['orion-belt', ['b', 'c']],
      ]),
      desired: new Map([
        ['sol-prime', 1],
        ['orion-belt', 2],
      ]),
      maxPerTick: 5,
    });
    expect(out).toHaveLength(0);
  });
});

describe('pickRespawnSector', () => {
  it('always returns a real sector and is deterministic per seed', () => {
    const s1 = pickRespawnSector(makeSeededRng(42), KEYS);
    const s2 = pickRespawnSector(makeSeededRng(42), KEYS);
    expect(KEYS).toContain(s1);
    expect(s1).toBe(s2);
  });
});

describe('liveEntrySectors', () => {
  const ENTRY = getEntrySectors().map((s) => s.key);

  it('returns the galaxy entry sectors present in the live set, in live order', () => {
    const live = liveEntrySectors(KEYS);
    // For the full galaxy the live entry set is exactly the global edge ring.
    expect([...live].sort()).toEqual([...ENTRY].sort());
    expect(live).not.toContain('sol-prime'); // the centre is interior
  });

  it('intersects with the live rooms (a director subset) — drops absent edges', () => {
    const live = liveEntrySectors(['sol-prime', 'orion-belt', 'vega-reach']);
    // orion-belt + vega-reach are edge sectors; sol-prime is interior.
    expect(live).toEqual(['orion-belt', 'vega-reach']);
  });

  it('FALLS BACK to all live sectors when none of the edge ring is live', () => {
    // A single-interior-sector test harness has no legal edge ingress — the
    // fallback keeps the respawn loop from deadlocking.
    expect(liveEntrySectors(['sol-prime'])).toEqual(['sol-prime']);
  });
});

describe('pickEntrySector', () => {
  it('always returns a galaxy entry sector for the full galaxy', () => {
    const s = pickEntrySector(makeSeededRng(42), KEYS);
    expect(isEntrySector(s)).toBe(true);
    expect(s).not.toBe('sol-prime');
  });

  it('is deterministic per seed and restricted to the live entry set', () => {
    const live = ['sol-prime', 'orion-belt', 'vega-reach'];
    const s1 = pickEntrySector(makeSeededRng(7), live);
    const s2 = pickEntrySector(makeSeededRng(7), live);
    expect(s1).toBe(s2);
    expect(['orion-belt', 'vega-reach']).toContain(s1);
  });

  it('uses the single-sector fallback when no edge sector is live', () => {
    expect(pickEntrySector(makeSeededRng(1), ['sol-prime'])).toBe('sol-prime');
  });
});

describe('pickRoamGoal', () => {
  it('returns a real LIVE neighbour of the source (a graph random walk)', () => {
    // sol-prime neighbours every outer; restrict the live set to two of them.
    const goal = pickRoamGoal(makeSeededRng(3), 'sol-prime', ['sol-prime', 'orion-belt', 'vega-reach']);
    expect(['orion-belt', 'vega-reach']).toContain(goal);
    expect(goal).not.toBe('sol-prime'); // a neighbour, never self
  });

  it('never picks a sector the director does not hold (live-room intersection)', () => {
    // orion-belt's galaxy neighbours are sol-prime, vega-reach, lyra-fringe; only
    // sol-prime is live, so the walk must go there.
    expect(pickRoamGoal(makeSeededRng(5), 'orion-belt', ['orion-belt', 'sol-prime'])).toBe('sol-prime');
  });

  it('stays put when the source has no live neighbour', () => {
    expect(pickRoamGoal(makeSeededRng(5), 'orion-belt', ['orion-belt'])).toBe('orion-belt');
  });

  it('is deterministic per seed', () => {
    const a = pickRoamGoal(makeSeededRng(8), 'sol-prime', KEYS);
    const b = pickRoamGoal(makeSeededRng(8), 'sol-prime', KEYS);
    expect(a).toBe(b);
  });
});

describe('sectorEdgePose', () => {
  it('spawns near the edge, in bounds, heading + drifting inward', () => {
    const p = sectorEdgePose(makeSeededRng(7));
    expect(Math.abs(p.x)).toBeLessThanOrEqual(SECTOR_PLAYABLE_HALF_EXTENT);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(SECTOR_PLAYABLE_HALF_EXTENT);
    const r = Math.hypot(p.x, p.y);
    expect(r).toBeGreaterThan(SECTOR_PLAYABLE_HALF_EXTENT * 0.8);
    // Velocity points toward the centre: dot(v, -pos) > 0.
    expect(p.vx * -p.x + p.vy * -p.y).toBeGreaterThan(0);
    // Nose (-sin a, cos a) aligns with the inward unit vector.
    const inLen = Math.hypot(p.x, p.y);
    const nx = -Math.sin(p.angle);
    const ny = Math.cos(p.angle);
    expect(nx).toBeCloseTo(-p.x / inLen, 5);
    expect(ny).toBeCloseTo(-p.y / inLen, 5);
  });

  it('is deterministic per seed', () => {
    expect(sectorEdgePose(makeSeededRng(99))).toEqual(sectorEdgePose(makeSeededRng(99)));
  });
});

describe('makeSeededRng', () => {
  it('is reproducible and stays in [0, 1)', () => {
    const a = makeSeededRng(123);
    const b = makeSeededRng(123);
    for (let i = 0; i < 50; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
