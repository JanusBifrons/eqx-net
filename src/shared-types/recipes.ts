/**
 * Production recipes (plan soft-leaping-truffle v3, phase P1) — the data
 * behind the production chain. Pure; the processor pass that runs them lands
 * in P2 (`StructureGridSubsystem`).
 *
 * The chain: raw goods (stage 0) are dug or scavenged, refined (1), made into
 * components (2), then assembled into end products (3). Robot Cores are an
 * exotic loot-only input. See docs/architecture/production-chains.md.
 *
 * **Append-only.** `RECIPE_IDS` order is the `recipe` byte on a structure's
 * room-state row, so a recipe is appended, never reordered or removed (the same
 * contract as invariant #11).
 *
 * **Balance is locked by `recipes.test.ts`, not by this file:** every recipe
 * returns 1.2–1.6× the value of its inputs at `BASE_PRICES`, and value per unit
 * of weight rises by stage.
 */
import type { GoodId } from './goods.js';
import type { StructureKindId } from './structureKinds.js';

export const RECIPE_IDS = [
  'smelt_alloy',
  'reclaim_salvage',
  'refine_ice_fuel',
  'refine_gas',
  'make_silicon',
  'grow_provisions',
  'fab_components',
  'fab_electronics',
  'make_munitions',
  'assemble_machinery',
  'assemble_consumer_goods',
  'opc_alloy',
  'opc_silicon',
] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];

/** Structure kinds that run recipes (catalogue kinds since P2a; locked by
 *  recipes.test.ts). */
export const PROCESSOR_KIND_IDS = [
  'reclaimer',
  'smelter',
  'refinery',
  'silicon_works',
  'hydroponics',
  'fabricator',
  'munitions_works',
  'assembly_plant',
  'ore_processing_complex',
] as const satisfies readonly StructureKindId[];
export type ProcessorKindId = (typeof PROCESSOR_KIND_IDS)[number];

/** What a recipe makes: goods, or (once Living World's W2 lands) a PACKED
 *  structure that is placed later at no cost but time. */
export type RecipeOutput =
  | { readonly good: GoodId; readonly n: number }
  | { readonly packed: StructureKindId };

export interface RecipeDef {
  readonly id: RecipeId;
  readonly displayName: string;
  /** Goods consumed per cycle. */
  readonly inputs: Readonly<Partial<Record<GoodId, number>>>;
  /** What one cycle makes. */
  readonly outputs: readonly RecipeOutput[];
  /** Grid pulses (1 Hz) per cycle at blueprint efficiency 100 %. */
  readonly cyclePulses: number;
  /** Structure kinds that can run it. */
  readonly processors: readonly ProcessorKindId[];
  /** A blueprint must be loaded in the processor to run it (Living World owns
   *  the blueprint model; \`applyBlueprint\` scales inputs, outputs and time).
   *  Extraction and simple refining are free; components and up need one. */
  readonly blueprintRequired: boolean;
}

function r(def: RecipeDef): RecipeDef {
  return def;
}

export const RECIPES: Readonly<Record<RecipeId, RecipeDef>> = Object.freeze({
  smelt_alloy: r({
    id: 'smelt_alloy', displayName: 'Smelt alloy',
    inputs: { minerals: 10 }, outputs: [{ good: 'alloy', n: 1 }],
    cyclePulses: 6, processors: ['smelter'], blueprintRequired: false,
  }),
  reclaim_salvage: r({
    id: 'reclaim_salvage', displayName: 'Reclaim salvage',
    inputs: { salvage: 5 }, outputs: [{ good: 'minerals', n: 6 }, { good: 'alloy', n: 1 }],
    cyclePulses: 4, processors: ['reclaimer'], blueprintRequired: false,
  }),
  refine_ice_fuel: r({
    id: 'refine_ice_fuel', displayName: 'Refine ice into fuel',
    inputs: { ice: 2 }, outputs: [{ good: 'fuel', n: 1 }],
    cyclePulses: 5, processors: ['refinery'], blueprintRequired: false,
  }),
  refine_gas: r({
    id: 'refine_gas', displayName: 'Crack gas',
    inputs: { gas: 4 }, outputs: [{ good: 'fuel', n: 1 }, { good: 'polymer', n: 1 }],
    cyclePulses: 6, processors: ['refinery'], blueprintRequired: false,
  }),
  make_silicon: r({
    id: 'make_silicon', displayName: 'Grow silicon',
    inputs: { crystal: 1, minerals: 2 }, outputs: [{ good: 'silicon', n: 1 }],
    cyclePulses: 8, processors: ['silicon_works'], blueprintRequired: false,
  }),
  grow_provisions: r({
    id: 'grow_provisions', displayName: 'Grow provisions',
    inputs: { ice: 2 }, outputs: [{ good: 'provisions', n: 1 }],
    cyclePulses: 6, processors: ['hydroponics'], blueprintRequired: false,
  }),
  fab_components: r({
    id: 'fab_components', displayName: 'Fabricate components',
    inputs: { alloy: 2, polymer: 1 }, outputs: [{ good: 'components', n: 1 }],
    cyclePulses: 10, processors: ['fabricator'], blueprintRequired: true,
  }),
  fab_electronics: r({
    id: 'fab_electronics', displayName: 'Fabricate electronics',
    inputs: { silicon: 2, alloy: 1 }, outputs: [{ good: 'electronics', n: 1 }],
    cyclePulses: 12, processors: ['fabricator'], blueprintRequired: true,
  }),
  make_munitions: r({
    id: 'make_munitions', displayName: 'Make munitions',
    inputs: { alloy: 1, fuel: 2 }, outputs: [{ good: 'munitions', n: 1 }],
    cyclePulses: 8, processors: ['munitions_works'], blueprintRequired: true,
  }),
  assemble_machinery: r({
    id: 'assemble_machinery', displayName: 'Assemble machinery',
    inputs: { components: 2, electronics: 1 }, outputs: [{ good: 'machinery', n: 1 }],
    cyclePulses: 20, processors: ['assembly_plant'], blueprintRequired: true,
  }),
  assemble_consumer_goods: r({
    id: 'assemble_consumer_goods', displayName: 'Assemble consumer goods',
    inputs: { electronics: 1, polymer: 2 }, outputs: [{ good: 'consumer_goods', n: 1 }],
    cyclePulses: 16, processors: ['assembly_plant'], blueprintRequired: true,
  }),
  // The Ore Processing Complex: the consolidated refinery. Better yields and a
  // faster cycle than the standard units it replaces.
  opc_alloy: r({
    id: 'opc_alloy', displayName: 'Smelt alloy (bulk)',
    inputs: { minerals: 8 }, outputs: [{ good: 'alloy', n: 1 }],
    cyclePulses: 4, processors: ['ore_processing_complex'], blueprintRequired: false,
  }),
  opc_silicon: r({
    id: 'opc_silicon', displayName: 'Grow silicon (bulk)',
    inputs: { crystal: 4, minerals: 6 }, outputs: [{ good: 'silicon', n: 4 }],
    cyclePulses: 16, processors: ['ore_processing_complex'], blueprintRequired: false,
  }),
});

export function recipeIndex(id: RecipeId): number {
  return RECIPE_IDS.indexOf(id);
}

export function recipeFromIndex(i: number): RecipeId | null {
  return RECIPE_IDS[i] ?? null;
}

/** Recipes a processor kind can run, in catalogue order. */
export function recipesFor(kind: ProcessorKindId): RecipeId[] {
  return RECIPE_IDS.filter((id) => RECIPES[id].processors.includes(kind));
}

/**
 * Where each good comes from OUTSIDE recipes (extraction or loot), and what
 * consumes it OUTSIDE recipes. Together with `RECIPES` this proves no good is
 * an orphan (`recipes.test.ts`); the named sources and sinks land in P2–D3.
 */
export const GOOD_SOURCES: Readonly<Partial<Record<GoodId, readonly string[]>>> = Object.freeze({
  minerals: ['miner: rock and crystal-veined asteroids', 'deep core rig'],
  salvage: ['loot', 'wrecks'],
  ice: ['miner: ice asteroids'],
  gas: ['gas collector (nebula sectors)'],
  crystal: ['miner: crystal-veined asteroids', 'deep core rig'],
  core: ['robot loot'],
});

export const GOOD_SINKS: Readonly<Partial<Record<GoodId, readonly string[]>>> = Object.freeze({
  fuel: ['reactor (burns it for power)'],
  provisions: ['colonies and cities'],
  consumer_goods: ['colonies and cities'],
  munitions: ['missile turrets, autocannons and mine layers (ammo)'],
  alloy: ['structure upgrades to level 3+'],
  components: ['structure upgrades to level 4+', 'packed structures'],
  electronics: ['packed structures'],
  machinery: ['structure upgrades to level 5', 'packed huge structures'],
  core: ['packed huge structures'],
  minerals: ['construction of starter structures'],
});
