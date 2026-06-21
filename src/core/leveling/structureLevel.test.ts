import { describe, it, expect } from 'vitest';
import {
  STRUCTURE_LEVEL_CAP,
  STRUCTURE_LEVEL_FRAC,
  clampStructureLevel,
  canUpgradeStructure,
  structureUpgradeCost,
  structureLevelMultipliers,
  effectiveStructureMaxHealth,
  effectiveStructureMaxConnections,
  STRUCTURE_CONNECTIONS_PER_LEVEL,
  NEUTRAL_STRUCTURE_LEVEL_MULTIPLIERS,
} from './structureLevel.js';

/**
 * Phase 4 WS-B4 — pure structure-leveling locks: the level clamp, the
 * upgrade-cost curve, the cap gate, and the level → multipliers derivation (the
 * SHARED computation the server reads at every catalogue read-site so a leveled
 * structure's stats are consistent).
 */

describe('structureLevel — clamp', () => {
  it('a fresh structure clamps to level 1', () => {
    expect(clampStructureLevel(undefined)).toBe(1);
    expect(clampStructureLevel(1)).toBe(1);
  });
  it('clamps sub-1 / non-finite / fractional to a valid level', () => {
    expect(clampStructureLevel(0)).toBe(1);
    expect(clampStructureLevel(-3)).toBe(1);
    expect(clampStructureLevel(Number.NaN)).toBe(1);
    expect(clampStructureLevel(2.9)).toBe(2);
  });
  it('clamps above the cap to the cap', () => {
    expect(clampStructureLevel(STRUCTURE_LEVEL_CAP + 5)).toBe(STRUCTURE_LEVEL_CAP);
  });
});

describe('structureLevel — upgrade gate', () => {
  it('a below-cap structure can be upgraded', () => {
    expect(canUpgradeStructure(1)).toBe(true);
    expect(canUpgradeStructure(STRUCTURE_LEVEL_CAP - 1)).toBe(true);
  });
  it('a capped structure cannot be upgraded', () => {
    expect(canUpgradeStructure(STRUCTURE_LEVEL_CAP)).toBe(false);
    expect(canUpgradeStructure(STRUCTURE_LEVEL_CAP + 1)).toBe(false);
  });
});

describe('structureLevel — upgrade cost', () => {
  it('escalates with level', () => {
    const base = 300;
    const c1 = structureUpgradeCost(base, 1); // level 1 → 2
    const c2 = structureUpgradeCost(base, 2); // level 2 → 3
    expect(c1).toBeGreaterThan(0);
    expect(c2).toBeGreaterThan(c1);
  });
  it('is 0 at/above the cap (no upgrade possible)', () => {
    expect(structureUpgradeCost(300, STRUCTURE_LEVEL_CAP)).toBe(0);
  });
  it('is an integer', () => {
    expect(Number.isInteger(structureUpgradeCost(333, 1))).toBe(true);
  });
});

describe('structureLevel — multipliers', () => {
  it('level 1 is the neutral set (every factor 1)', () => {
    expect(structureLevelMultipliers(1)).toEqual(NEUTRAL_STRUCTURE_LEVEL_MULTIPLIERS);
    expect(structureLevelMultipliers(undefined)).toEqual(NEUTRAL_STRUCTURE_LEVEL_MULTIPLIERS);
  });
  it('level 2 adds one increment to every stat', () => {
    const m = structureLevelMultipliers(2);
    const expected = 1 + STRUCTURE_LEVEL_FRAC;
    expect(m.maxHealth).toBeCloseTo(expected);
    expect(m.weaponRange).toBeCloseTo(expected);
    expect(m.weaponDamage).toBeCloseTo(expected);
    expect(m.powerOutput).toBeCloseTo(expected);
    expect(m.storageCapacity).toBeCloseTo(expected);
  });
  it('scales monotonically up to the cap', () => {
    expect(structureLevelMultipliers(3).maxHealth).toBeGreaterThan(
      structureLevelMultipliers(2).maxHealth,
    );
  });
});

describe('structureLevel — effective max health', () => {
  it('a level-1 structure keeps its base HP', () => {
    expect(effectiveStructureMaxHealth(600, 1)).toBe(600);
  });
  it('a level-2 structure has more HP than base', () => {
    expect(effectiveStructureMaxHealth(600, 2)).toBeGreaterThan(600);
    expect(effectiveStructureMaxHealth(600, 2)).toBeCloseTo(600 * (1 + STRUCTURE_LEVEL_FRAC));
  });
});

describe('structureLevel — effective connection cap (Equinox Phase-5 audit)', () => {
  it('a level-1 connector keeps its base slot count', () => {
    expect(effectiveStructureMaxConnections(6, 1)).toBe(6);
    expect(effectiveStructureMaxConnections(6, undefined)).toBe(6);
  });
  it('UPGRADING adds slots — each level grants STRUCTURE_CONNECTIONS_PER_LEVEL more', () => {
    // The whole point of the bug fix: an upgraded connector can hold MORE links.
    expect(effectiveStructureMaxConnections(6, 2)).toBe(6 + STRUCTURE_CONNECTIONS_PER_LEVEL);
    expect(effectiveStructureMaxConnections(6, 3)).toBe(6 + 2 * STRUCTURE_CONNECTIONS_PER_LEVEL);
    // A maxed connector (cap 5) reaches base + 4 grants.
    expect(effectiveStructureMaxConnections(6, 5)).toBe(6 + 4 * STRUCTURE_CONNECTIONS_PER_LEVEL);
    expect(effectiveStructureMaxConnections(6, 5)).toBeGreaterThan(6);
  });
  it('clamps an out-of-range level (never below the base cap)', () => {
    expect(effectiveStructureMaxConnections(6, 0)).toBe(6);
    expect(effectiveStructureMaxConnections(6, 99)).toBe(effectiveStructureMaxConnections(6, STRUCTURE_LEVEL_CAP));
  });
});
