import { describe, it, expect } from 'vitest';
import {
  canAfford,
  spendEnergy,
  regenEnergyStep,
  resolveSlotEnergyCost,
  BOOST_TICK_COST,
} from './Energy.js';
import { SHIP_KINDS } from '../../shared-types/shipKinds.js';
import { getWeapon } from './WeaponCatalogue.js';

describe('Energy — canAfford', () => {
  it('a full pool can afford any cost up to its value', () => {
    expect(canAfford(100, 5)).toBe(true);
    expect(canAfford(5, 5)).toBe(true);
  });

  it('gates when the pool is short', () => {
    expect(canAfford(4, 5)).toBe(false);
    expect(canAfford(0, 1)).toBe(false);
  });

  it('zero / negative costs are always affordable (e.g. an empty pool)', () => {
    expect(canAfford(0, 0)).toBe(true);
    expect(canAfford(0, -3)).toBe(true);
  });

  it('tolerates float slop at exactly the cost (regen-rounding safety)', () => {
    expect(canAfford(5 - 1e-9, 5)).toBe(true);
  });
});

describe('Energy — spendEnergy', () => {
  it('subtracts the cost from the pool', () => {
    expect(spendEnergy(10, 3)).toBe(7);
  });

  it('never drives the pool negative (clamps at 0)', () => {
    expect(spendEnergy(2, 5)).toBe(0);
    expect(spendEnergy(0, 5)).toBe(0);
  });

  it('zero / negative cost is a no-op', () => {
    expect(spendEnergy(10, 0)).toBe(10);
    expect(spendEnergy(10, -4)).toBe(10);
  });

  it('the gate + spend compose: a gated short pool never overspends', () => {
    let pool = 4;
    const cost = 5;
    if (canAfford(pool, cost)) pool = spendEnergy(pool, cost);
    // Gate rejected, pool untouched.
    expect(pool).toBe(4);
  });
});

describe('Energy — regenEnergyStep', () => {
  it('adds the regen rate each tick', () => {
    expect(regenEnergyStep(10, 100, 0.5)).toBeCloseTo(10.5, 9);
  });

  it('caps at energyMax (never overfills)', () => {
    expect(regenEnergyStep(99.8, 100, 0.5)).toBe(100);
    expect(regenEnergyStep(100, 100, 0.5)).toBe(100);
  });

  it('an empty pool refills toward full over many ticks', () => {
    let pool = 0;
    for (let i = 0; i < 1000; i++) pool = regenEnergyStep(pool, 120, 0.2);
    expect(pool).toBe(120);
  });

  it('regen has no post-spend delay (fires every tick — caller never gates it)', () => {
    // Distinct from shield: there is no delay parameter. Spend then regen on
    // the very next tick.
    let pool = spendEnergy(50, 5); // 45
    pool = regenEnergyStep(pool, 100, 0.25); // 45.25 immediately
    expect(pool).toBeCloseTo(45.25, 9);
  });
});

describe('Energy — BOOST_TICK_COST', () => {
  it('is positive and sized for a multi-second drain on a small pool', () => {
    expect(BOOST_TICK_COST).toBeGreaterThan(0);
    // A 120-pool should survive at least ~1.5 s of continuous boost.
    expect(120 / (BOOST_TICK_COST * 60)).toBeGreaterThanOrEqual(1.5);
  });
});

describe('Energy — resolveSlotEnergyCost', () => {
  it('single-bolt ships pay the bolt weapon cost (2)', () => {
    const bolt = getWeapon('laser').energyCost;
    for (const id of ['scout', 'fighter', 'heavy'] as const) {
      expect(resolveSlotEnergyCost(SHIP_KINDS[id])).toBe(bolt);
    }
  });

  it('drains ONCE per slot, not per mount: interceptor twin beams = one beam cost', () => {
    const beam = getWeapon('hitscan').energyCost;
    // Two wing mounts, but the slot cost is the MAX (= one beam), not 2×.
    expect(SHIP_KINDS.interceptor.mounts).toHaveLength(2);
    expect(resolveSlotEnergyCost(SHIP_KINDS.interceptor)).toBe(beam);
  });

  it('frigate twin missile racks = one missile cost (60)', () => {
    const missile = getWeapon('heat-seeker').energyCost;
    expect(resolveSlotEnergyCost(SHIP_KINDS['missile-frigate'])).toBe(missile);
  });

  it('honours a per-slot energyCost override (gunship two-barrel slot = 3)', () => {
    // Gunship bolts cost 2 each, but the slot overrides to 3 to reflect the
    // fore-and-aft volume.
    expect(resolveSlotEnergyCost(SHIP_KINDS.gunship)).toBe(3);
    expect(getWeapon('laser').energyCost).toBe(2);
  });
});
