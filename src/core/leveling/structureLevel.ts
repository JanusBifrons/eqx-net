/**
 * Per-structure-instance leveling — pure, zone-blind (Phase 4 WS-B4, plan:
 * effervescent-umbrella).
 *
 * A placed structure starts at level 1. The owner spends resources to UPGRADE it
 * (D14) — a paid build phase (reusing the construction-pulse machinery) that, on
 * completion, increments the structure's level and applies a per-level stat
 * grant to that kind's KEY stat:
 *
 *   - HP            — every kind (the universal grant);
 *   - turret range + damage — defence turrets;
 *   - power output  — solar / capital generators;
 *   - storage       — capital / miner buffers.
 *
 * This module is the single source of truth for:
 *   - the level cap (`STRUCTURE_LEVEL_CAP`),
 *   - the per-level multiplier (a balance knob, `STRUCTURE_LEVEL_FRAC`),
 *   - the upgrade COST for the next level (`structureUpgradeCost`),
 *   - the pure derivation `level → StructureLevelMultipliers`
 *     (`structureLevelMultipliers`),
 *   - the leveled effective stats the server reads at its catalogue read-sites
 *     (`effectiveMaxHealth` etc.).
 *
 * Zone-pure (`src/core`): no I/O, no allocation in any hot path beyond the small
 * result literal (computed on a LOW-frequency discrete event — an upgrade
 * completion / a slice rebuild off the 1 Hz pulse, never the 60 Hz tick, so
 * invariant #14's hot-loop ban does not bite). Same inputs ⇒ same outputs on any
 * caller, so the server and any future client preview agree.
 */

/**
 * The maximum structure level. A structure at the cap can't be upgraded further
 * (the Upgrade affordance hides + the server drops the request). 5 keeps the
 * economy bounded; a balance knob.
 */
export const STRUCTURE_LEVEL_CAP = 5;

/**
 * Per-level multiplier increment. Each level ABOVE 1 multiplies the kind's base
 * stat by an extra `STRUCTURE_LEVEL_FRAC` (so level L ⇒ `1 + (L-1)·FRAC`). A
 * balance knob (D14's "boosts that structure's key stat") — adjust on-device;
 * the architecture is unchanged when it moves.
 */
export const STRUCTURE_LEVEL_FRAC = 0.25;

/**
 * Upgrade-cost growth per level. The cost to reach level L is the kind's base
 * `constructionCost` scaled by `1 + (L-1)·STRUCTURE_UPGRADE_COST_FRAC` — each
 * level costs more (D14 — "cost scales with level"). A balance knob.
 */
export const STRUCTURE_UPGRADE_COST_FRAC = 1.0;

/**
 * Extra connection SLOTS granted per level above 1 (Equinox Phase-5 audit —
 * "upgrading a connector doesn't add more connection slots"). ADDITIVE, not a
 * multiplier: `maxConnections` is an integer count, so a level-L structure's cap
 * is `base + (L-1)·STRUCTURE_CONNECTIONS_PER_LEVEL`. A balance knob — a level-5
 * connector (base 6) reaches 6 + 4 = 10 slots. Level 1 ⇒ +0 (byte-identical).
 */
export const STRUCTURE_CONNECTIONS_PER_LEVEL = 1;

/** A structure's level, clamped to `[1, STRUCTURE_LEVEL_CAP]`. Defensive against
 *  a corrupt / out-of-range persisted value (always returns a valid level). */
export function clampStructureLevel(level: number | undefined): number {
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 1) return 1;
  const l = Math.floor(level);
  return l > STRUCTURE_LEVEL_CAP ? STRUCTURE_LEVEL_CAP : l;
}

/** True while a structure can still be upgraded (below the cap). */
export function canUpgradeStructure(level: number | undefined): boolean {
  return clampStructureLevel(level) < STRUCTURE_LEVEL_CAP;
}

/**
 * The resource cost to upgrade a structure with base `constructionCost` from its
 * CURRENT `level` to the next. `baseConstructionCost · (1 + level·FRAC)` — a
 * level-1 → 2 upgrade costs `base·(1 + 1·FRAC)`, level-2 → 3 costs `base·(1 +
 * 2·FRAC)`, escalating. Returns 0 at/above the cap (no upgrade possible) AND for
 * a zero-cost base kind (the pre-built Capital is `constructionCost = 0`, so its
 * upgrade is FREE in the base — but the leveling still applies its stat grant;
 * callers gate the upgrade on `canUpgradeStructure`, not on a non-zero cost).
 * The cost is rounded to an integer (minerals are whole units in the pulse).
 */
export function structureUpgradeCost(baseConstructionCost: number, level: number): number {
  if (!canUpgradeStructure(level)) return 0;
  const l = clampStructureLevel(level);
  const cost = baseConstructionCost * (1 + l * STRUCTURE_UPGRADE_COST_FRAC);
  return Math.round(Math.max(0, cost));
}

/**
 * Per-stat multipliers derived from a structure level. Each is `1 +
 * (level-1)·STRUCTURE_LEVEL_FRAC`; a level-1 structure is exactly `1` on every
 * factor (byte-identical to pre-WS-B4). All grants share the same factor (one
 * knob) — the per-kind RELEVANCE is what differs (a solar has no turret range,
 * a turret no storage), but the factor is uniform so the derivation stays a
 * single multiply.
 */
export interface StructureLevelMultipliers {
  /** Multiplies `maxHealth` (every kind — the universal grant). */
  maxHealth: number;
  /** Multiplies `weaponRange` (defence turrets). */
  weaponRange: number;
  /** Multiplies `weaponDamage` (defence turrets). */
  weaponDamage: number;
  /** Multiplies `powerOutput` (solar / capital generators). */
  powerOutput: number;
  /** Multiplies `storageCapacity` (capital bank / miner buffer). */
  storageCapacity: number;
}

/** The identity multiplier set — every factor 1 (a fresh level-1 structure). */
export const NEUTRAL_STRUCTURE_LEVEL_MULTIPLIERS: Readonly<StructureLevelMultipliers> =
  Object.freeze({
    maxHealth: 1,
    weaponRange: 1,
    weaponDamage: 1,
    powerOutput: 1,
    storageCapacity: 1,
  });

/**
 * Derive the per-stat multipliers from a structure level. Pure (one small
 * literal, low-frequency). Level ≤ 1 ⇒ every factor 1 (the neutral set).
 */
export function structureLevelMultipliers(level: number | undefined): StructureLevelMultipliers {
  const l = clampStructureLevel(level);
  const f = 1 + (l - 1) * STRUCTURE_LEVEL_FRAC;
  return {
    maxHealth: f,
    weaponRange: f,
    weaponDamage: f,
    powerOutput: f,
    storageCapacity: f,
  };
}

/**
 * The single scalar per-level factor (`1 + (level-1)·STRUCTURE_LEVEL_FRAC`).
 * Allocation-free (returns a number) — the read-site form for hot-ish paths
 * (the 100 ms turret tick) where the small `StructureLevelMultipliers` literal
 * would be wasteful. `structureLevelMultipliers` is just this factor spread over
 * the named stats; both agree by construction.
 */
export function structureLevelFactor(level: number | undefined): number {
  return 1 + (clampStructureLevel(level) - 1) * STRUCTURE_LEVEL_FRAC;
}

/** Leveled effective max-health for a structure (`baseMaxHealth · level mul`).
 *  The single helper both the subsystem (HP seed on build) and the snapshot
 *  slice (`hpPct` denominator) read so a leveled structure's bar is consistent. */
export function effectiveStructureMaxHealth(baseMaxHealth: number, level: number | undefined): number {
  return baseMaxHealth * structureLevelMultipliers(level).maxHealth;
}

/**
 * Leveled effective connection cap (`base + (level-1)·STRUCTURE_CONNECTIONS_PER_LEVEL`).
 * ADDITIVE (slots are whole). The single helper that BOTH the server GridNode
 * projection (`structureToGridNode`) and the client preview projection
 * (`mirrorToGridNode`) read, so the live grid + the placement preview agree on
 * how many links a leveled structure can hold (Equinox Phase-5 audit: upgrading a
 * connector now actually adds slots). Level ≤ 1 ⇒ the base cap, unchanged.
 */
export function effectiveStructureMaxConnections(
  baseMaxConnections: number,
  level: number | undefined,
): number {
  return baseMaxConnections + (clampStructureLevel(level) - 1) * STRUCTURE_CONNECTIONS_PER_LEVEL;
}
