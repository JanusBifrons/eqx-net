import { describe, expect, it } from 'vitest';
import {
  CLAIM_AT,
  RELEASE_AT,
  challengerOf,
  freshControl,
  freshMultiControl,
  holderTrend,
  isMultiContested,
  stepControl,
  stepMultiControl,
  targetPressure,
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
  it('parity: robots vs players hits the same target as the robot meter', () => {
    for (const [robots, nexus, structures, ships] of [
      [4, false, 0, 0], [6, true, 3, 2], [1, false, 6, 1], [0, true, 0, 5], [100, true, 0, 0],
    ] as const) {
      const old = targetPressure({ robots, nexus, playerStructures: structures, players: ships });
      const p = presence({ robots: { robots, nexus }, alice: { ships, structures } });
      expect(targetShare('robots', p, ALL_HOSTILE)).toBe(Math.max(0, old));
    }
  });

  it('parity: robots claim and release on the same ticks as the robot meter', () => {
    const old = freshControl();
    const neo = freshMultiControl();
    const phases: [number, Parameters<typeof stepControl>[1]][] = [
      [120, { robots: 2, nexus: true, playerStructures: 0, players: 0 }],
      [60, { robots: 2, nexus: true, playerStructures: 0, players: 2 }],
      [120, { robots: 0, nexus: false, playerStructures: 4, players: 3 }],
    ];
    for (const [secs, i] of phases) {
      const p = presence({ robots: { robots: i.robots, nexus: i.nexus }, alice: { ships: i.players, structures: i.playerStructures } });
      for (let t = 0; t < secs; t++) {
        const a = stepControl(old, i, 1000);
        const b = stepMultiControl(neo, p, ALL_HOSTILE, 1000).flipped;
        // Robot gain/loss matches the old meter while its pressure is ≥ 0.
        if (old.pressure >= 0) expect(b && neo.holder !== 'alice').toBe(a);
        if (old.pressure >= 0) expect(neo.shares.get('robots') ?? 0).toBeCloseTo(old.pressure, 6);
      }
    }
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
