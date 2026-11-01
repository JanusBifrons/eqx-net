/**
 * Loot tables (plan peppy-jumping-pinwheel P1a-1) — what a destroyed NPC drops.
 * Kept OUT of the ship catalogue so balance tuning never bumps
 * `SHIP_KIND_CATALOGUE_VERSION`. Pure; the roll takes an injected RNG so rooms
 * (and tests) are deterministic.
 */
import type { Hold, GoodId } from './goods.js';
import { getShipKind } from './shipKinds.js';

export interface LootEntry {
  readonly good: GoodId;
  /** Probability 0..1 that this entry drops at all. */
  readonly chance: number;
  readonly min: number;
  readonly max: number;
}

export interface LootTable {
  readonly credits: readonly [number, number];
  readonly entries: readonly LootEntry[];
}

/** Explicit per-kind tables. A kind not listed falls back to `defaultTable`. */
const TABLES: Readonly<Record<string, LootTable>> = {
  'robot-square': {
    credits: [8, 20],
    entries: [
      { good: 'salvage', chance: 1, min: 4, max: 10 },
      { good: 'alloy', chance: 0.35, min: 1, max: 2 },
    ],
  },
  // P2 — a hauler drops NOTHING from a table: its cargo hold (the deal goods)
  // spills instead, so killing one never mints value.
  'trader-hauler': { credits: [0, 0], entries: [] },
  // P1b — robot tiers drop progressively better loot (the reason to hunt them).
  'robot-circle': {
    credits: [20, 45],
    entries: [
      { good: 'salvage', chance: 1, min: 8, max: 18 },
      { good: 'alloy', chance: 0.6, min: 1, max: 3 },
      { good: 'core', chance: 0.08, min: 1, max: 1 },
    ],
  },
  'robot-hexagon': {
    credits: [45, 90],
    entries: [
      { good: 'salvage', chance: 1, min: 15, max: 30 },
      { good: 'alloy', chance: 1, min: 2, max: 5 },
      { good: 'core', chance: 0.3, min: 1, max: 1 },
    ],
  },
};

/** Fallback: scale with the victim's toughness (like XP). */
function defaultTable(maxHealth: number): LootTable {
  const scale = Math.max(1, Math.round(maxHealth / 50));
  return {
    credits: [2 * scale, 6 * scale],
    entries: [
      { good: 'salvage', chance: 1, min: scale, max: 3 * scale },
      { good: 'alloy', chance: 0.1, min: 1, max: 1 },
    ],
  };
}

export function lootTableFor(kindId: string | null | undefined): LootTable {
  const t = kindId != null ? TABLES[kindId] : undefined;
  return t ?? defaultTable(getShipKind(kindId).maxHealth);
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Roll a table into a fresh hold. `rng` ∈ [0, 1). */
export function rollLoot(kindId: string | null | undefined, rng: () => number): Hold {
  const t = lootTableFor(kindId);
  const out: Hold = { goods: {}, credits: randInt(rng, t.credits[0], t.credits[1]), blueprints: [] };
  for (const e of t.entries) {
    if (rng() >= e.chance) continue;
    const n = randInt(rng, e.min, e.max);
    if (n > 0) out.goods[e.good] = (out.goods[e.good] ?? 0) + n;
  }
  return out;
}
