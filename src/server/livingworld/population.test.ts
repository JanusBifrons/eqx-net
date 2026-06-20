import { describe, it, expect } from 'vitest';
import { GALAXY_SECTORS, getEntrySectors, isEntrySector } from '../../core/galaxy/galaxy.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';
import {
  apportion,
  computeDesiredDistribution,
  nextHopToward,
  hopDistance,
  planMigrations,
  pickRespawnSector,
  sectorEdgePose,
  squadEdgePose,
  makeSeededRng,
  liveEntrySectors,
  pickEntrySector,
  pickRoamGoal,
  enemyBotCountsBySector,
  MIN_PACK_PER_OCCUPIED,
  type WaveSquadView,
  type BotPlacement,
} from './population.js';
import { LIVING_WORLD_SQUAD_COUNT, SQUAD_SIZE } from './director/SquadPool.js';

const KEYS = GALAXY_SECTORS.map((s) => s.key);
// A FIXED 7-key list for the PURE apportionment / distribution tests, so their
// largest-remainder math stays anchored independently of the live galaxy size
// (which grew 7 → 21 in the Living Galaxy expansion). The graph-walk tests
// below use the real KEYS / real sector adjacencies.
const PKEYS = ['pk0', 'pk1', 'pk2', 'pk3', 'pk4', 'pk5', 'pk6'];
const sum = (m: ReadonlyMap<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

describe('hopDistance (galaxy-graph BFS depth)', () => {
  it('is 0 for the same sector', () => {
    expect(hopDistance('sol-prime', 'sol-prime')).toBe(0);
  });

  it('is 1 between adjacent core sectors, and symmetric', () => {
    expect(hopDistance('sol-prime', 'vega-reach')).toBe(1);
    expect(hopDistance('vega-reach', 'sol-prime')).toBe(1);
  });

  it('counts multi-hop routes through a chokepoint', () => {
    // orion-belt sits one hop beyond its chokepoint (vega-reach), so it is
    // 2 hops from the core hub.
    expect(hopDistance('sol-prime', 'orion-belt')).toBe(2);
    // Across two regions: orion-belt → vega-reach → sol-prime → cygnus-arm = 3 hops.
    const d = hopDistance('orion-belt', 'cygnus-arm');
    expect(d).toBe(3);
    expect(Number.isFinite(d)).toBe(true);
  });

  it('is Infinity for an unknown sector', () => {
    expect(hopDistance('sol-prime', 'no-such-sector')).toBe(Infinity);
    expect(hopDistance('no-such-sector', 'sol-prime')).toBe(Infinity);
  });
});

describe('apportion (largest-remainder)', () => {
  it('sums to total and splits evenly when weights are equal', () => {
    const w = new Map(PKEYS.map((k) => [k, 1] as const));
    const out = apportion(w, 25, PKEYS);
    expect(sum(out)).toBe(25);
    // 25/7 = 3 each + 4 remainder seats to the first 4 keys in order.
    expect(out.get(PKEYS[0]!)).toBe(4);
    expect(out.get(PKEYS[3]!)).toBe(4);
    expect(out.get(PKEYS[4]!)).toBe(3);
    expect(out.get(PKEYS[6]!)).toBe(3);
  });

  it('is proportional to weights', () => {
    const w = new Map<string, number>([
      [PKEYS[0]!, 1],
      [PKEYS[1]!, 3],
    ]);
    const out = apportion(w, 8, [PKEYS[0]!, PKEYS[1]!]);
    expect(out.get(PKEYS[0]!)).toBe(2);
    expect(out.get(PKEYS[1]!)).toBe(6);
    expect(sum(out)).toBe(8);
  });

  it('all-zero weights degrades to an even split', () => {
    const w = new Map(PKEYS.map((k) => [k, 0] as const));
    const out = apportion(w, 7, PKEYS);
    expect(sum(out)).toBe(7);
    for (const k of PKEYS) expect(out.get(k)).toBe(1);
  });

  it('total 0 and empty keys are no-ops', () => {
    expect(sum(apportion(new Map(), 0, PKEYS))).toBe(0);
    expect(apportion(new Map(), 10, []).size).toBe(0);
  });
});

describe('computeDesiredDistribution', () => {
  it('spreads evenly across every sector when no players are online', () => {
    const out = computeDesiredDistribution({
      sectorKeys: PKEYS,
      playerCounts: new Map(),
      budget: 25,
    });
    expect(sum(out)).toBe(25);
    // Same shape as the equal-weight apportionment.
    expect(out.get(PKEYS[0]!)).toBe(4);
    expect(out.get(PKEYS[6]!)).toBe(3);
    expect([...out.values()].every((v) => v >= 3)).toBe(true);
  });

  it('funnels the whole budget toward the only player-occupied sector', () => {
    const target = PKEYS[3]!;
    const out = computeDesiredDistribution({
      sectorKeys: PKEYS,
      playerCounts: new Map([[target, 2]]),
      budget: 25,
    });
    expect(sum(out)).toBe(25);
    expect(out.get(target)).toBe(25);
    for (const k of PKEYS) if (k !== target) expect(out.get(k)).toBe(0);
  });

  it('splits proportionally across occupied sectors with a min-pack floor', () => {
    const a = PKEYS[0]!;
    const b = PKEYS[3]!;
    const out = computeDesiredDistribution({
      sectorKeys: PKEYS,
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
    for (const k of PKEYS) if (k !== a && k !== b) expect(out.get(k)).toBe(0);
  });

  it('degrades to pure proportional when the budget cannot floor everyone', () => {
    const occ = [PKEYS[1]!, PKEYS[2]!, PKEYS[3]!];
    const out = computeDesiredDistribution({
      sectorKeys: PKEYS,
      playerCounts: new Map([
        [occ[0]!, 1],
        [occ[1]!, 1],
        [occ[2]!, 2],
      ]),
      budget: 4, // < MIN_PACK_PER_OCCUPIED * 3 = 6
    });
    expect(sum(out)).toBe(4);
    expect(out.get(occ[2]!)!).toBeGreaterThanOrEqual(out.get(occ[0]!)!);
    for (const k of PKEYS) if (!occ.includes(k)) expect(out.get(k)).toBe(0);
  });

  it('places nothing when the budget is exhausted', () => {
    const out = computeDesiredDistribution({
      sectorKeys: PKEYS,
      playerCounts: new Map([[PKEYS[0]!, 5]]),
      budget: 0,
    });
    expect(sum(out)).toBe(0);
  });

  // Living Galaxy P2: the squad pool grew 3→7 (24→56 bots) to populate the
  // 21-sector galaxy. The distribution math is size-invariant — this proves
  // the idle-galaxy even-spread actually scales to the new count over the REAL
  // galaxy (not the fixed PKEYS anchor the pure math tests use).
  it('spreads the full scaled bot budget evenly across the live 21-sector galaxy', () => {
    const budget = LIVING_WORLD_SQUAD_COUNT * SQUAD_SIZE; // 56 after P2
    const out = computeDesiredDistribution({
      sectorKeys: KEYS,
      playerCounts: new Map(), // idle galaxy — no players anywhere
      budget,
    });
    expect(sum(out)).toBe(budget);
    // Every sector gets at least the even-split floor, so no sector is starved
    // and the bigger galaxy stays uniformly alive.
    const floor = Math.floor(budget / KEYS.length);
    for (const k of KEYS) expect(out.get(k)!).toBeGreaterThanOrEqual(floor);
    // Largest-remainder ⇒ counts differ by at most one across all sectors.
    const vals = [...out.values()];
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
  });
});

describe('nextHopToward (galaxy BFS)', () => {
  it('returns the destination directly when it is a neighbour', () => {
    // vega-reach is a direct core neighbour of sol-prime.
    expect(nextHopToward('sol-prime', 'vega-reach')).toBe('vega-reach');
  });

  it('routes a multi-hop path through the chokepoint deterministically', () => {
    // sol-prime → orion-belt routes through the Verdant chokepoint (vega-reach).
    expect(nextHopToward('sol-prime', 'orion-belt')).toBe('vega-reach');
    // orion-belt → cygnus-arm (cross-region): first hop back toward the core.
    expect(nextHopToward('orion-belt', 'cygnus-arm')).toBe('vega-reach');
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
        ['vega-reach', 2],
      ]),
      maxPerTick: 5,
    });
    expect(out).toHaveLength(2);
    for (const m of out) {
      expect(m.from).toBe('sol-prime');
      expect(m.to).toBe('vega-reach'); // direct neighbour
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
        ['vega-reach', 2],
      ]),
      maxPerTick: 5,
      frozen: new Set(['b1', 'b2']), // only b3 is movable
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.botId).toBe('b3');
    expect(out[0]!.from).toBe('sol-prime');
    expect(out[0]!.to).toBe('vega-reach');
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
    const live = liveEntrySectors(['sol-prime', 'greenfall', 'ashfront']);
    // greenfall + ashfront are entry (edge) sectors; sol-prime is interior.
    expect(live).toEqual(['greenfall', 'ashfront']);
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
    const live = ['sol-prime', 'greenfall', 'ashfront'];
    const s1 = pickEntrySector(makeSeededRng(7), live);
    const s2 = pickEntrySector(makeSeededRng(7), live);
    expect(s1).toBe(s2);
    expect(['greenfall', 'ashfront']).toContain(s1);
  });

  it('uses the single-sector fallback when no edge sector is live', () => {
    expect(pickEntrySector(makeSeededRng(1), ['sol-prime'])).toBe('sol-prime');
  });
});

describe('pickRoamGoal', () => {
  it('returns a real LIVE neighbour of the source (a graph random walk)', () => {
    // sol-prime's neighbours are vega-reach, lyra-fringe, cygnus-arm.
    const goal = pickRoamGoal(makeSeededRng(3), 'sol-prime', ['sol-prime', 'vega-reach', 'cygnus-arm']);
    expect(['vega-reach', 'cygnus-arm']).toContain(goal);
    expect(goal).not.toBe('sol-prime'); // a neighbour, never self
  });

  it('never picks a sector the director does not hold (live-room intersection)', () => {
    // orion-belt's galaxy neighbours are vega-reach, thornfield, bloomgate; only
    // vega-reach is live, so the walk must go there.
    expect(pickRoamGoal(makeSeededRng(5), 'orion-belt', ['orion-belt', 'vega-reach'])).toBe('vega-reach');
  });

  it('stays put when the source has no live neighbour', () => {
    expect(pickRoamGoal(makeSeededRng(5), 'orion-belt', ['orion-belt'])).toBe('orion-belt');
  });

  it('is deterministic per seed', () => {
    const a = pickRoamGoal(makeSeededRng(8), 'sol-prime', KEYS);
    const b = pickRoamGoal(makeSeededRng(8), 'sol-prime', KEYS);
    expect(a).toBe(b);
  });

  // ── WS-E #22: roaming squads avoid active-combat sectors ──
  it('skips a neighbour flagged as active-combat (avoidCombat predicate)', () => {
    // sol-prime's live neighbours here: vega-reach, cygnus-arm. Flag vega-reach
    // as in-combat → the roamer must pick the safe cygnus-arm.
    const live = ['sol-prime', 'vega-reach', 'cygnus-arm'];
    const goal = pickRoamGoal(makeSeededRng(3), 'sol-prime', live, (k) => k === 'vega-reach');
    expect(goal).toBe('cygnus-arm');
  });

  it('holds (returns the source) when EVERY live neighbour is in combat', () => {
    const live = ['sol-prime', 'vega-reach', 'cygnus-arm'];
    // Both neighbours in combat ⇒ nowhere safe to roam ⇒ stay put.
    const goal = pickRoamGoal(makeSeededRng(3), 'sol-prime', live, () => true);
    expect(goal).toBe('sol-prime');
  });

  it('is unchanged when avoidCombat is omitted vs always-false (back-compat)', () => {
    const live = ['sol-prime', 'vega-reach', 'cygnus-arm'];
    const withUndef = pickRoamGoal(makeSeededRng(3), 'sol-prime', live);
    const withFalse = pickRoamGoal(makeSeededRng(3), 'sol-prime', live, () => false);
    expect(withUndef).toBe(withFalse);
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

describe('squadEdgePose — a squad warps in CLUSTERED (a herd from birth)', () => {
  it('clusters a squad members tightly around one shared edge anchor', () => {
    // 8 members of one squad in one sector → all near one anchor (≪ the old
    // per-bot random scatter, which could be ~the sector diameter apart).
    const poses = Array.from({ length: 8 }, (_, i) =>
      squadEdgePose('squad-0', 'greenfall', `lwbot-${i}`),
    );
    let maxGap = 0;
    for (let i = 0; i < poses.length; i++) {
      for (let j = i + 1; j < poses.length; j++) {
        maxGap = Math.max(maxGap, Math.hypot(poses[i]!.x - poses[j]!.x, poses[i]!.y - poses[j]!.y));
      }
    }
    expect(maxGap).toBeLessThan(1200); // a tight cluster, not a sector-wide scatter
  });

  it('still spawns near the edge, in bounds, heading + drifting inward', () => {
    const p = squadEdgePose('squad-3', 'orion-belt', 'lwbot-25');
    expect(Math.abs(p.x)).toBeLessThanOrEqual(SECTOR_PLAYABLE_HALF_EXTENT);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(SECTOR_PLAYABLE_HALF_EXTENT);
    expect(Math.hypot(p.x, p.y)).toBeGreaterThan(SECTOR_PLAYABLE_HALF_EXTENT * 0.8);
    expect(p.vx * -p.x + p.vy * -p.y).toBeGreaterThan(0); // drifts toward centre
  });

  it('is deterministic (no RNG) and varies the anchor by squad + sector', () => {
    expect(squadEdgePose('squad-0', 'greenfall', 'lwbot-0')).toEqual(
      squadEdgePose('squad-0', 'greenfall', 'lwbot-0'),
    );
    // Different squad OR different sector ⇒ a different anchor bearing (members
    // don't all funnel to the same edge point galaxy-wide).
    const a = squadEdgePose('squad-0', 'greenfall', 'lwbot-0');
    const b = squadEdgePose('squad-1', 'greenfall', 'lwbot-0');
    const c = squadEdgePose('squad-0', 'emerald-span', 'lwbot-0');
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(500);
    expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeGreaterThan(500);
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

describe('enemyBotCountsBySector — galaxy-map hostile classification', () => {
  const place =
    (m: Record<string, BotPlacement>) =>
    (id: string): BotPlacement | undefined =>
      m[id];

  it('counts a DISPATCHED squad (targetFactionId set) as enemies in each member sector', () => {
    const squads: WaveSquadView[] = [
      { targetFactionId: 'player-A', botIds: ['b1', 'b2', 'b3'] },
    ];
    const placements = place({
      b1: { state: 'active', sectorKey: 'sol-prime' },
      b2: { state: 'active', sectorKey: 'sol-prime' },
      b3: { state: 'active', sectorKey: 'vega-reach' }, // a straggler mid-traverse
    });
    const counts = enemyBotCountsBySector(squads, placements);
    expect(counts.get('sol-prime')).toBe(2);
    expect(counts.get('vega-reach')).toBe(1);
  });

  it('shows enemies regardless of player presence (the bug: it used to require a present player)', () => {
    // No player is present anywhere — an offline base under attack. The squad is
    // still hostile to the faction, so its members MUST count as enemies.
    const squads: WaveSquadView[] = [{ targetFactionId: 'offline-owner', botIds: ['b1'] }];
    const counts = enemyBotCountsBySector(squads, place({ b1: { state: 'active', sectorKey: 'sol-prime' } }));
    expect(counts.get('sol-prime')).toBe(1);
  });

  it('treats a ROAMING squad (targetFactionId null) as neutral — contributes nothing', () => {
    const squads: WaveSquadView[] = [{ targetFactionId: null, botIds: ['r1', 'r2'] }];
    const counts = enemyBotCountsBySector(squads, place({
      r1: { state: 'active', sectorKey: 'thornfield' },
      r2: { state: 'active', sectorKey: 'thornfield' },
    }));
    expect(counts.size).toBe(0);
  });

  it('excludes in-transit / unknown members (only live bots occupy a sector)', () => {
    const squads: WaveSquadView[] = [{ targetFactionId: 'player-A', botIds: ['b1', 'b2', 'gone'] }];
    const counts = enemyBotCountsBySector(squads, place({
      b1: { state: 'active', sectorKey: 'sol-prime' },
      b2: { state: 'in-transit', sectorKey: 'sol-prime' }, // mid-hop, between rooms
      // 'gone' has no placement at all
    }));
    expect(counts.get('sol-prime')).toBe(1);
  });

  it('is empty with no squads', () => {
    expect(enemyBotCountsBySector([], place({})).size).toBe(0);
  });
});
