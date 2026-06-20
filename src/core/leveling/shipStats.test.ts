import { describe, it, expect } from 'vitest';
import {
  STAT_IDS,
  STAT_POINT_FRAC,
  pointBudget,
  spentPoints,
  isAllocValid,
  deriveStatMultipliers,
  NEUTRAL_STAT_MULTIPLIERS,
} from './shipStats.js';

/**
 * Phase 4 WS-B2 — pure stat-pool curve locks: the point budget per level, the
 * "can't exceed budget" validation gate, and the alloc → multipliers derivation
 * (the SHARED computation that feeds both the physics seam and the server-side
 * damage/shield/energy calcs).
 */

describe('shipStats — point budget', () => {
  it('a fresh ship (level 1) has 0 points', () => {
    expect(pointBudget(1)).toBe(0);
  });

  it('grants one point per level above 1', () => {
    expect(pointBudget(2)).toBe(1);
    expect(pointBudget(5)).toBe(4);
    expect(pointBudget(10)).toBe(9);
  });

  it('is defensive against sub-1 / fractional levels', () => {
    expect(pointBudget(0)).toBe(0);
    expect(pointBudget(-3)).toBe(0);
    expect(pointBudget(3.9)).toBe(2);
  });
});

describe('shipStats — spentPoints', () => {
  it('sums spent points across the pool', () => {
    expect(spentPoints({ hull: 2, topSpeed: 3 })).toBe(5);
  });

  it('treats empty / undefined as 0', () => {
    expect(spentPoints({})).toBe(0);
  });

  it('ignores negative / non-finite entries (cannot under-count the spend)', () => {
    expect(spentPoints({ hull: -5, energy: Number.NaN, damage: 4 } as never)).toBe(4);
  });
});

describe('shipStats — isAllocValid (budget cannot be exceeded)', () => {
  it('accepts a spend within budget', () => {
    expect(isAllocValid({ hull: 2, topSpeed: 2 }, 5)).toBe(true); // 4 ≤ 4
  });

  it('accepts a spend exactly equal to the budget', () => {
    expect(isAllocValid({ damage: 4 }, 5)).toBe(true); // 4 ≤ 4
  });

  it('REJECTS a spend over budget (the server gate)', () => {
    expect(isAllocValid({ hull: 3, topSpeed: 3 }, 5)).toBe(false); // 6 > 4
  });

  it('rejects an unknown stat id', () => {
    expect(isAllocValid({ wings: 1 } as never, 5)).toBe(false);
  });

  it('rejects negative / fractional / non-finite points', () => {
    expect(isAllocValid({ hull: -1 } as never, 5)).toBe(false);
    expect(isAllocValid({ hull: 1.5 } as never, 5)).toBe(false);
    expect(isAllocValid({ hull: Number.POSITIVE_INFINITY } as never, 5)).toBe(false);
  });

  it('accepts an empty allocation at any level', () => {
    expect(isAllocValid({}, 1)).toBe(true);
    expect(isAllocValid({}, 10)).toBe(true);
  });
});

describe('shipStats — deriveStatMultipliers', () => {
  it('an empty / undefined allocation is the neutral (all-1) set', () => {
    expect(deriveStatMultipliers({})).toEqual(NEUTRAL_STAT_MULTIPLIERS);
    expect(deriveStatMultipliers(undefined)).toEqual(NEUTRAL_STAT_MULTIPLIERS);
  });

  it('each point adds STAT_POINT_FRAC to the corresponding factor', () => {
    const m = deriveStatMultipliers({ topSpeed: 5, turnRate: 2, hull: 1 });
    expect(m.topSpeed).toBeCloseTo(1 + 5 * STAT_POINT_FRAC, 9);
    expect(m.turnRate).toBeCloseTo(1 + 2 * STAT_POINT_FRAC, 9);
    expect(m.maxHull).toBeCloseTo(1 + 1 * STAT_POINT_FRAC, 9);
    // Untouched stats stay neutral.
    expect(m.energy).toBe(1);
    expect(m.damage).toBe(1);
    expect(m.shield).toBe(1);
  });

  it('maps every stat id to its multiplier field', () => {
    const m = deriveStatMultipliers({
      hull: 1, energy: 1, damage: 1, topSpeed: 1, turnRate: 1, shield: 1,
    });
    for (const f of [m.maxHull, m.energy, m.damage, m.topSpeed, m.turnRate, m.shield]) {
      expect(f).toBeCloseTo(1 + STAT_POINT_FRAC, 9);
    }
  });

  it('STAT_IDS is the documented append-only pool order', () => {
    expect(STAT_IDS).toEqual(['hull', 'energy', 'damage', 'topSpeed', 'turnRate', 'shield']);
  });
});
