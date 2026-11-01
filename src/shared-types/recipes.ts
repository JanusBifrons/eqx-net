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
import { getStructureKind, type StructureKindId } from './structureKinds.js';
import { BASE_PRICES } from './economy.js';
import { getShipKind, type ShipKindId } from './shipKinds.js';

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
  // Packed structures (P2b): one per non-starter structure kind.
  'pack_laser_bolt_turret',
  'pack_missile_turret',
  'pack_shield_airlock',
  'pack_gas_collector',
  'pack_reclaimer',
  'pack_smelter',
  'pack_refinery',
  'pack_silicon_works',
  'pack_hydroponics',
  'pack_fabricator',
  'pack_munitions_works',
  'pack_freight_dock',
  'pack_deep_core_rig',
  'pack_ore_processing_complex',
  'pack_assembly_plant',
  // Living World W3 kind (appended after assembly_plant).
  'pack_research_lab',
  'pack_autocannon_turret',
  'pack_reactor',
  'pack_battery_bank',
  'pack_storage_vault',
  // Economy v2 W5b (Living World) — the Shipyard + the ships it builds.
  'pack_shipyard',
  'build_interceptor',
  'build_gunship',
  'build_heavy',
  'build_missile_frigate',
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
  'shipyard',
] as const satisfies readonly StructureKindId[];
export type ProcessorKindId = (typeof PROCESSOR_KIND_IDS)[number];

/** What a recipe makes: goods, or (once Living World's W2 lands) a PACKED
 *  structure that is placed later at no cost but time. */
export type RecipeOutput =
  | { readonly good: GoodId; readonly n: number }
  | { readonly packed: StructureKindId }
  /** A packed HULL (Living World W5: the Shipyard builds ships that are
   *  unpacked into the roster). Lands in storage as `hull:<kind>`. */
  | { readonly hull: ShipKindId };

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

function packName(kind: StructureKindId): string {
  return `Pack ${getStructureKind(kind).displayName}`;
}

function buildName(kind: ShipKindId): string {
  return `Build ${getShipKind(kind).displayName}`;
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
  // ── Packed structures (P2b; user ruling: NPC factions make them, players
  // mostly buy them). The blueprint is the structure's own (`structure:<kind>`).
  pack_laser_bolt_turret: r({
    id: 'pack_laser_bolt_turret', displayName: packName('laser_bolt_turret'),
    inputs: { alloy: 6, components: 2 }, outputs: [{ packed: 'laser_bolt_turret' }],
    cyclePulses: 12, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_missile_turret: r({
    id: 'pack_missile_turret', displayName: packName('missile_turret'),
    inputs: { alloy: 8, components: 3, electronics: 2 }, outputs: [{ packed: 'missile_turret' }],
    cyclePulses: 16, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_shield_airlock: r({
    id: 'pack_shield_airlock', displayName: packName('shield_airlock'),
    inputs: { alloy: 14, components: 4, electronics: 2 }, outputs: [{ packed: 'shield_airlock' }],
    cyclePulses: 20, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_gas_collector: r({
    id: 'pack_gas_collector', displayName: packName('gas_collector'),
    inputs: { alloy: 8, components: 2 }, outputs: [{ packed: 'gas_collector' }],
    cyclePulses: 12, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_reclaimer: r({
    id: 'pack_reclaimer', displayName: packName('reclaimer'),
    inputs: { alloy: 6, components: 1 }, outputs: [{ packed: 'reclaimer' }],
    cyclePulses: 8, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_smelter: r({
    id: 'pack_smelter', displayName: packName('smelter'),
    inputs: { alloy: 8, components: 2 }, outputs: [{ packed: 'smelter' }],
    cyclePulses: 10, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_refinery: r({
    id: 'pack_refinery', displayName: packName('refinery'),
    inputs: { alloy: 10, components: 2, polymer: 4 }, outputs: [{ packed: 'refinery' }],
    cyclePulses: 12, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_silicon_works: r({
    id: 'pack_silicon_works', displayName: packName('silicon_works'),
    inputs: { alloy: 8, components: 3, electronics: 1 }, outputs: [{ packed: 'silicon_works' }],
    cyclePulses: 14, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_hydroponics: r({
    id: 'pack_hydroponics', displayName: packName('hydroponics'),
    inputs: { alloy: 6, polymer: 6, components: 1 }, outputs: [{ packed: 'hydroponics' }],
    cyclePulses: 10, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_fabricator: r({
    id: 'pack_fabricator', displayName: packName('fabricator'),
    inputs: { alloy: 12, components: 4, electronics: 2 }, outputs: [{ packed: 'fabricator' }],
    cyclePulses: 18, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_munitions_works: r({
    id: 'pack_munitions_works', displayName: packName('munitions_works'),
    inputs: { alloy: 12, components: 3, electronics: 1 }, outputs: [{ packed: 'munitions_works' }],
    cyclePulses: 16, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_freight_dock: r({
    id: 'pack_freight_dock', displayName: packName('freight_dock'),
    inputs: { alloy: 14, components: 3 }, outputs: [{ packed: 'freight_dock' }],
    cyclePulses: 14, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_deep_core_rig: r({
    id: 'pack_deep_core_rig', displayName: packName('deep_core_rig'),
    inputs: { alloy: 40, components: 12, machinery: 4, core: 2 }, outputs: [{ packed: 'deep_core_rig' }],
    cyclePulses: 60, processors: ['assembly_plant'], blueprintRequired: true,
  }),
  pack_ore_processing_complex: r({
    id: 'pack_ore_processing_complex', displayName: packName('ore_processing_complex'),
    inputs: { alloy: 40, components: 14, machinery: 5, electronics: 4, core: 2 }, outputs: [{ packed: 'ore_processing_complex' }],
    cyclePulses: 60, processors: ['assembly_plant'], blueprintRequired: true,
  }),
  pack_research_lab: r({
    id: 'pack_research_lab', displayName: packName('research_lab'),
    inputs: { alloy: 10, components: 3, electronics: 4 }, outputs: [{ packed: 'research_lab' }],
    cyclePulses: 20, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_autocannon_turret: r({
    id: 'pack_autocannon_turret', displayName: packName('autocannon_turret'),
    inputs: { alloy: 8, components: 2 }, outputs: [{ packed: 'autocannon_turret' }],
    cyclePulses: 12, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_reactor: r({
    id: 'pack_reactor', displayName: packName('reactor'),
    inputs: { alloy: 20, components: 6, electronics: 4, machinery: 1 }, outputs: [{ packed: 'reactor' }],
    cyclePulses: 40, processors: ['assembly_plant'], blueprintRequired: true,
  }),
  pack_battery_bank: r({
    id: 'pack_battery_bank', displayName: packName('battery_bank'),
    inputs: { alloy: 20, components: 4, electronics: 6 }, outputs: [{ packed: 'battery_bank' }],
    cyclePulses: 30, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_storage_vault: r({
    id: 'pack_storage_vault', displayName: packName('storage_vault'),
    inputs: { alloy: 30, components: 4 }, outputs: [{ packed: 'storage_vault' }],
    cyclePulses: 24, processors: ['fabricator'], blueprintRequired: true,
  }),
  pack_assembly_plant: r({
    id: 'pack_assembly_plant', displayName: packName('assembly_plant'),
    inputs: { alloy: 50, components: 16, electronics: 8, machinery: 6, core: 3 }, outputs: [{ packed: 'assembly_plant' }],
    cyclePulses: 80, processors: ['assembly_plant'], blueprintRequired: true,
  }),
  // Economy v2 W5b — the Shipyard, and the packed hulls it builds (each needs
  // that ship's blueprint). Bills scale with the hull.
  pack_shipyard: r({
    id: 'pack_shipyard', displayName: packName('shipyard'),
    inputs: { alloy: 50, components: 14, electronics: 6, machinery: 6, core: 3 }, outputs: [{ packed: 'shipyard' }],
    cyclePulses: 80, processors: ['assembly_plant'], blueprintRequired: true,
  }),
  build_interceptor: r({
    id: 'build_interceptor', displayName: buildName('interceptor'),
    inputs: { alloy: 12, components: 4, electronics: 3 }, outputs: [{ hull: 'interceptor' }],
    cyclePulses: 40, processors: ['shipyard'], blueprintRequired: true,
  }),
  build_gunship: r({
    id: 'build_gunship', displayName: buildName('gunship'),
    inputs: { alloy: 18, components: 6, electronics: 3, machinery: 1 }, outputs: [{ hull: 'gunship' }],
    cyclePulses: 50, processors: ['shipyard'], blueprintRequired: true,
  }),
  build_heavy: r({
    id: 'build_heavy', displayName: buildName('heavy'),
    inputs: { alloy: 24, components: 6, machinery: 2 }, outputs: [{ hull: 'heavy' }],
    cyclePulses: 55, processors: ['shipyard'], blueprintRequired: true,
  }),
  build_missile_frigate: r({
    id: 'build_missile_frigate', displayName: buildName('missile-frigate'),
    inputs: { alloy: 40, components: 10, electronics: 6, machinery: 4, core: 2 }, outputs: [{ hull: 'missile-frigate' }],
    cyclePulses: 80, processors: ['shipyard'], blueprintRequired: true,
  }),
});

export function isRecipeId(s: string): s is RecipeId {
  return (RECIPE_IDS as readonly string[]).includes(s);
}

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

/** The pack recipe that makes a structure kind, or null for a starter kind
 *  (those build from minerals and are never packed). */
export function packRecipeFor(kind: StructureKindId): RecipeId | null {
  const id = `pack_${kind}`;
  return (RECIPE_IDS as readonly string[]).includes(id) ? (id as RecipeId) : null;
}

/** The structure a recipe packs, or null for a goods recipe. */
export function packedKindOf(recipe: RecipeId): StructureKindId | null {
  const o = RECIPES[recipe].outputs[0];
  return o !== undefined && 'packed' in o ? o.packed : null;
}

/**
 * The goods value of a packed structure's bill at `BASE_PRICES`: the basis for
 * what traders charge for it (Living World W4 adds the markup). 0 for a
 * starter kind.
 */
export function packBillValue(kind: StructureKindId): number {
  const id = packRecipeFor(kind);
  if (id === null) return 0;
  let v = 0;
  for (const [g, n] of Object.entries(RECIPES[id].inputs)) v += BASE_PRICES[g as GoodId] * (n ?? 0);
  return v;
}

/** Economy v2 W5b — the ship a recipe builds (a packed hull), or null. */
export function hullKindOf(recipe: RecipeId): ShipKindId | null {
  const o = RECIPES[recipe].outputs[0];
  return o !== undefined && 'hull' in o ? o.hull : null;
}

/** The Shipyard recipe that builds a ship kind, or null (starter hulls are
 *  free and never built). */
export function buildRecipeFor(kind: ShipKindId): RecipeId | null {
  for (const id of RECIPE_IDS) if (hullKindOf(id) === kind) return id;
  return null;
}

/** The goods value of a packed hull's bill at `BASE_PRICES` (traders price
 *  packed hulls from it, like `packBillValue`). 0 when no recipe builds it. */
export function hullBillValue(kind: ShipKindId): number {
  const id = buildRecipeFor(kind);
  if (id === null) return 0;
  let v = 0;
  for (const [g, n] of Object.entries(RECIPES[id].inputs)) v += BASE_PRICES[g as GoodId] * (n ?? 0);
  return v;
}

/** The blueprint product a recipe needs (Living World's namespaced ids). */
export function blueprintProductFor(recipe: RecipeId): string {
  const kind = packedKindOf(recipe);
  if (kind !== null) return `structure:${kind}`;
  const hull = hullKindOf(recipe);
  return hull !== null ? `hull:${hull}` : `recipe:${recipe}`;
}
