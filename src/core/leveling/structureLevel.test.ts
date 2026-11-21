import { describe, it, expect } from 'vitest';
import {
  structureUpgradeGoods,
  STRUCTURE_LEVEL_CAP,
  STRUCTURE_LEVEL_FRAC,
  clampStructureLevel,
  canUpgradeStructure,
  structureUpgradeCost,
  structureLevelMultipliers,
  effectiveStructureMaxHealth,
  effectiveStructureMaxConnections,
  structureLinksBoundBySockets,
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
    // Economy v2 — quality from the packed item adds up to +10 %.
    expect(effectiveStructureMaxHealth(600, 1, 100)).toBeCloseTo(660);
    expect(effectiveStructureMaxHealth(600, 1, 0)).toBe(600);
  });
  it('a level-2 structure has more HP than base', () => {
    expect(effectiveStructureMaxHealth(600, 2)).toBeGreaterThan(600);
    expect(effectiveStructureMaxHealth(600, 2)).toBeCloseTo(600 * (1 + STRUCTURE_LEVEL_FRAC));
  });
});

describe('structureLevel — effective connection cap (Equinox Phase-5 audit)', () => {
  it('a level-1 connector keeps its base slot count', () => {
    expect(effectiveStructureMaxConnections(6, 1, 'connector')).toBe(6);
    expect(effectiveStructureMaxConnections(6, undefined, 'connector')).toBe(6);
  });
  it('UPGRADING adds slots — each level grants STRUCTURE_CONNECTIONS_PER_LEVEL more, up to the sockets', () => {
    // A battery (base 1, 4 sockets) gains a slot per level until its sockets run out.
    expect(effectiveStructureMaxConnections(1, 2, 'battery')).toBe(1 + STRUCTURE_CONNECTIONS_PER_LEVEL);
    expect(effectiveStructureMaxConnections(1, 3, 'battery')).toBe(1 + 2 * STRUCTURE_CONNECTIONS_PER_LEVEL);
    // A connector already uses all 6 sockets at level 1: upgrading adds none.
    expect(effectiveStructureMaxConnections(6, 5, 'connector')).toBe(6);
    // A shield emitter is not socket-bound: its cap grows freely.
    expect(effectiveStructureMaxConnections(3, 5, 'shield_pylon')).toBe(3 + 4 * STRUCTURE_CONNECTIONS_PER_LEVEL);
  });
  it('clamps an out-of-range level (never below the base cap)', () => {
    expect(effectiveStructureMaxConnections(1, 0, 'battery')).toBe(1);
    expect(effectiveStructureMaxConnections(1, 99, 'battery')).toBe(effectiveStructureMaxConnections(1, STRUCTURE_LEVEL_CAP, 'battery'));
  });
  it('a socket-bound kind is clamped to its sockets (connectors too); shield emitters are not', () => {
    // Battery: 4 sockets, so a top-level battery holds 4 links, not 1 + 4.
    expect(effectiveStructureMaxConnections(1, STRUCTURE_LEVEL_CAP, 'battery')).toBe(4);
    expect(effectiveStructureMaxConnections(1, 1, 'battery')).toBe(1);
    // Connector: 6 sockets, one cable each (owner: no two connectors in one slot), so 6 at the top.
    expect(effectiveStructureMaxConnections(6, STRUCTURE_LEVEL_CAP, 'connector')).toBe(6);
    expect(structureLinksBoundBySockets('connector')).toBe(true);
    expect(structureLinksBoundBySockets('shield_pylon')).toBe(false);
    expect(structureLinksBoundBySockets('shield_gate')).toBe(false);
    expect(structureLinksBoundBySockets('shield_airlock')).toBe(false);
    expect(structureLinksBoundBySockets('battery')).toBe(true);
  });
});

describe('structureUpgradeGoods (P1: level 3+ upgrades cost goods)', () => {
  it('level 2 needs no goods; 3, 4 and 5 need progressively later-stage goods', () => {
    expect(structureUpgradeGoods(600, 1)).toEqual({});
    expect(Object.keys(structureUpgradeGoods(600, 2))).toEqual(['alloy']);
    expect(Object.keys(structureUpgradeGoods(600, 3)).sort()).toEqual(['alloy', 'components']);
    expect(Object.keys(structureUpgradeGoods(600, 4)).sort()).toEqual(['components', 'machinery']);
    expect(structureUpgradeGoods(600, STRUCTURE_LEVEL_CAP)).toEqual({});
  });
  it('dearer kinds need more, and zero-cost kinds still need at least one of each', () => {
    expect(structureUpgradeGoods(1500, 2).alloy!).toBeGreaterThan(structureUpgradeGoods(300, 2).alloy!);
    expect(structureUpgradeGoods(0, 4)).toEqual({ components: 1, machinery: 1 });
  });
});
