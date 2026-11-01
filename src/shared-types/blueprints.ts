/**
 * Blueprints (economy v2 W2, plan peppy-jumping-pinwheel) — Eve-style industry.
 *
 * You need a BLUEPRINT to produce anything complex. A blueprint is an item in a
 * hold (`BlueprintItem`, `items.ts`): an ORIGINAL (BPO, infinite runs) or a
 * COPY (BPC, `runs` left), with real stats — `material` (% fewer inputs) and
 * `output` (output quality). There are no tiers: `blueprintQuality` is only a
 * glance score derived from those stats.
 *
 * A blueprint makes ONE PACKED consumable (a packed structure or hull — placing
 * or unpacking it costs only time) or runs a production recipe. Starter
 * structures + starter hulls never need one, so new players don't meet
 * blueprints until mid-game. The production pass (the structures agent's
 * processors) calls `applyBlueprint` — pure, shared, so the off-screen economy
 * runs the same maths (#15).
 *
 * MODULES (the P5 installable ship upgrades) keep their catalogue here; until
 * W5 makes them manufactured items, a module blueprint installs onto a ship
 * (a `fitted:<shipInstanceId>` hold).
 */
import { z } from 'zod';
import type { GoodId } from './goods.js';
import type { BlueprintItem } from './items.js';
import { STRUCTURE_KINDS_LIST, getStructureKind, isStructureKindId } from './structureKinds.js';
import { PLAYABLE_SHIP_KINDS_LIST, getShipKind, isPlayableShipKindId } from './shipKinds.js';
import { RECIPES, RECIPE_IDS, type RecipeId } from './recipes.js';

function isRecipeId(id: string): id is RecipeId {
  return (RECIPE_IDS as readonly string[]).includes(id);
}

// ── Modules (P5 ship upgrades; manufactured items from W5) ──────────────────

export const BLUEPRINT_IDS = ['bp-missile-rack', 'bp-cargo-expander', 'bp-reinforced-hull'] as const;
/** A MODULE id (the P5 names are kept so persisted rows stay valid). */
export type BlueprintId = (typeof BLUEPRINT_IDS)[number];

export type BlueprintEffect =
  | { kind: 'weapon'; weaponId: 'heat-seeker' }
  | { kind: 'cargo'; mul: number }
  | { kind: 'hull'; mul: number };

export interface BlueprintDef {
  id: BlueprintId;
  displayName: string;
  description: string;
  effect: BlueprintEffect;
}

export const BLUEPRINTS: Readonly<Record<BlueprintId, BlueprintDef>> = {
  'bp-missile-rack': {
    id: 'bp-missile-rack',
    displayName: 'Missile Rack',
    description: 'Lets a spare hardpoint carry heat-seeking missiles.',
    effect: { kind: 'weapon', weaponId: 'heat-seeker' },
  },
  'bp-cargo-expander': {
    id: 'bp-cargo-expander',
    displayName: 'Cargo Expander',
    description: '+50% cargo capacity.',
    effect: { kind: 'cargo', mul: 1.5 },
  },
  'bp-reinforced-hull': {
    id: 'bp-reinforced-hull',
    displayName: 'Reinforced Hull',
    description: '+25% maximum hull.',
    effect: { kind: 'hull', mul: 1.25 },
  },
};

export function isBlueprintId(v: unknown): v is BlueprintId {
  return typeof v === 'string' && (BLUEPRINT_IDS as readonly string[]).includes(v);
}

/** The display name for a module id (unknown ids read as a generic label). */
export function blueprintName(id: string): string {
  return isBlueprintId(id) ? BLUEPRINTS[id].displayName : 'Blueprint';
}

/** The fitted-modules hold for a ship instance. */
export function fittedUid(shipInstanceId: string): string {
  return `fitted:${shipInstanceId}`;
}

/** Weapons that need a module before `activate_mount` will bind them. */
const WEAPON_GATES: Readonly<Record<string, BlueprintId>> = { 'heat-seeker': 'bp-missile-rack' };

/** True when `weaponId` may be fitted to a latent mount given the ship's fitted modules. */
export function weaponUnlocked(weaponId: string, fitted: readonly string[]): boolean {
  const need = WEAPON_GATES[weaponId];
  return need === undefined || fitted.includes(need);
}

/** The module a gated weapon needs (null when it's free). */
export function weaponGate(weaponId: string): BlueprintId | null {
  return WEAPON_GATES[weaponId] ?? null;
}

/** Cargo-capacity multiplier from fitted modules. */
export function fittedCargoMul(fitted: readonly string[]): number {
  let m = 1;
  for (const id of fitted) {
    if (isBlueprintId(id)) {
      const e = BLUEPRINTS[id].effect;
      if (e.kind === 'cargo') m *= e.mul;
    }
  }
  return m;
}

/** Max-hull multiplier from fitted modules. */
export function fittedHullMul(fitted: readonly string[]): number {
  let m = 1;
  for (const id of fitted) {
    if (isBlueprintId(id)) {
      const e = BLUEPRINTS[id].effect;
      if (e.kind === 'hull') m *= e.mul;
    }
  }
  return m;
}

// ── Products ────────────────────────────────────────────────────────────────

/** Structures anyone can build from minerals — no blueprint, no packed item
 *  (agreed with the structures agent; shield_gate so a fenced base can open). */
export const STARTER_STRUCTURE_KINDS: readonly string[] = [
  'capital', 'connector', 'solar', 'battery', 'miner', 'cargo_bay', 'turret', 'shield_pylon', 'shield_gate',
];
/** Hulls anyone can fly without building one. */
export const STARTER_HULL_KINDS: readonly string[] = ['scout', 'fighter'];

export function moduleProduct(id: string): string {
  return `module:${id}`;
}

/** Split a namespaced product id. */
export function parseProduct(product: string): { ns: 'structure' | 'hull' | 'module' | 'recipe' | 'unknown'; id: string } {
  const i = product.indexOf(':');
  if (i <= 0) return { ns: 'unknown', id: product };
  const ns = product.slice(0, i);
  const id = product.slice(i + 1);
  return ns === 'structure' || ns === 'hull' || ns === 'module' || ns === 'recipe' ? { ns, id } : { ns: 'unknown', id };
}

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A product's player-facing name ("Smelter", "Gunship", "Missile Rack"). */
export function productName(product: string): string {
  const { ns, id } = parseProduct(product);
  if (ns === 'module') return blueprintName(id);
  if (ns === 'structure' && isStructureKindId(id)) return getStructureKind(id).displayName;
  if (ns === 'hull' && isPlayableShipKindId(id)) return getShipKind(id).displayName;
  if (ns === 'recipe' && isRecipeId(id)) return RECIPES[id].displayName;
  return titleCase(id);
}

/** Every blueprint product: recipes flagged `blueprintRequired`, non-starter
 *  structures + hulls, and the modules. Allocates — call at control cadence. */
export function blueprintProducts(): string[] {
  const out: string[] = [];
  for (const id of RECIPE_IDS) if (RECIPES[id].blueprintRequired) out.push(`recipe:${id}`);
  for (const k of STRUCTURE_KINDS_LIST) if (!STARTER_STRUCTURE_KINDS.includes(k.id)) out.push(`structure:${k.id}`);
  for (const k of PLAYABLE_SHIP_KINDS_LIST) {
    if (!STARTER_HULL_KINDS.includes(k.id) && !k.engineeringOnly) out.push(`hull:${k.id}`);
  }
  for (const id of BLUEPRINT_IDS) out.push(moduleProduct(id));
  return out;
}

// ── Stats ───────────────────────────────────────────────────────────────────

/** Best material efficiency: % fewer inputs. With `OUTPUT_YIELD_MAX` this caps
 *  the best blueprint's value gain at 1.12 / 0.90 ≈ 1.24× — so a recipe worth
 *  ≤ 1.6× its inputs stays under ~2× (agreed balance cap: production must not
 *  print money). */
export const MATERIAL_MAX = 10;
/** Output quality 100 ⇒ +12 % expected output (extra-unit chance). */
export const OUTPUT_YIELD_MAX = 0.12;
/** A copy's runs at which the glance score counts it "full". */
export const BPC_RUNS_REF = 10;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * The glance score (0–100) the UI shows as stars. It is ONLY a summary of the
 * real stats — never an input to anything.
 */
export function blueprintQuality(bp: Pick<BlueprintItem, 'kind' | 'runs' | 'material' | 'output'>): number {
  const m = clamp(bp.material, 0, MATERIAL_MAX) / MATERIAL_MAX;
  const o = clamp(bp.output, 0, 100) / 100;
  const r = bp.kind === 'bpo' ? 1 : clamp((bp.runs ?? 0) / BPC_RUNS_REF, 0, 1);
  return Math.round((0.45 * m + 0.45 * o + 0.1 * r) * 100);
}

/** The minimal recipe shape `applyBlueprint` needs. A `recipes.ts` `RecipeDef`
 *  satisfies it directly; `outputs` is passed through untouched, whatever its
 *  shape (`RecipeOutput[]` there). */
export interface RecipeLike<O = unknown> {
  readonly inputs: Readonly<Partial<Record<GoodId, number>>>;
  readonly outputs: O;
  readonly cyclePulses: number;
}

export interface AppliedRecipe<O = unknown> {
  /** Inputs after material efficiency (every non-zero input stays ≥ 1). */
  inputs: Partial<Record<GoodId, number>>;
  /** Outputs per cycle, the recipe's own value (never mutate it — quality
   *  adds the yield bonus below). */
  outputs: O;
  cyclePulses: number;
  /** Chance (0 … OUTPUT_YIELD_MAX) of one EXTRA unit of each output per cycle;
   *  the processor rolls it with its own seeded counter (deterministic). */
  yieldBonus: number;
  /** Quality stamped onto a discrete product (packed item / hull / module). */
  quality: number;
}

/** Apply a blueprint's stats to a recipe. Pure + allocation per call (the
 *  processor caches it per loaded blueprint, not per pulse). */
export function applyBlueprint<O>(recipe: RecipeLike<O>, bp: Pick<BlueprintItem, 'material' | 'output'>): AppliedRecipe<O> {
  const keep = 1 - clamp(bp.material, 0, MATERIAL_MAX) / 100;
  const inputs: Partial<Record<GoodId, number>> = {};
  for (const [g, n] of Object.entries(recipe.inputs) as Array<[GoodId, number]>) {
    if (n > 0) inputs[g] = Math.max(1, Math.round(n * keep));
  }
  const q = clamp(bp.output, 0, 100);
  return {
    inputs,
    outputs: recipe.outputs,
    cyclePulses: recipe.cyclePulses,
    yieldBonus: (q / 100) * OUTPUT_YIELD_MAX,
    quality: Math.round(q),
  };
}

/** Spend one run. A copy at 0 runs is used up (the caller removes it).
 *  Returns false when it had no run left. Mutates. */
export function spendBlueprintRun(bp: BlueprintItem): boolean {
  if (bp.kind === 'bpo') return true;
  if ((bp.runs ?? 0) <= 0) return false;
  bp.runs = (bp.runs ?? 0) - 1;
  return true;
}

export function isBlueprintUsedUp(bp: BlueprintItem): boolean {
  return bp.kind === 'bpc' && (bp.runs ?? 0) <= 0;
}

// ── Drops ───────────────────────────────────────────────────────────────────

/** Drop chances. */
export const ELITE_BLUEPRINT_CHANCE = 0.4;
export const INCURSION_BLUEPRINT_CHANCE = 0.5;
/** A dropped blueprint is an ORIGINAL this rarely (else a copy). */
export const ORIGINAL_DROP_CHANCE = 0.05;

/** A fresh blueprint instance uid from `rng` (never shown). */
export function uidFrom(rng: () => number): string {
  return `bp-${Math.floor(rng() * 0x7fffffff).toString(36)}${Math.floor(rng() * 0x7fffffff).toString(36)}`;
}

/** A fresh blueprint for `product` with modest rolled stats (`rng` ∈ [0, 1)). */
export function makeBlueprint(product: string, kind: 'bpo' | 'bpc', rng: () => number): BlueprintItem {
  return {
    uid: uidFrom(rng),
    product,
    kind,
    runs: kind === 'bpo' ? null : 1 + Math.floor(rng() * 10),
    material: Math.floor(rng() * 4),
    output: Math.floor(rng() * 40),
    research: 0,
  };
}

/**
 * Roll a blueprint drop with probability `chance`: a random product (any
 * non-starter structure, hull or module), usually a COPY, rarely an ORIGINAL.
 */
export function rollBlueprint(rng: () => number, chance: number): BlueprintItem | null {
  if (rng() >= chance) return null;
  const products = blueprintProducts();
  const product = products[Math.floor(rng() * products.length)]!;
  const kind = rng() < ORIGINAL_DROP_CHANCE ? 'bpo' : 'bpc';
  return makeBlueprint(product, kind, rng);
}

// ── Messages (P5 module install; W3 adds the Research Lab jobs) ──────────────

/** Client → server: install a MODULE blueprint from my storage at
 *  `networkEntityId` onto my ACTIVE ship (which must be near that storage). */
export const InstallBlueprintSchema = z
  .object({
    type: z.literal('install_blueprint'),
    networkEntityId: z.number().int().nonnegative(),
    blueprintId: z.enum(BLUEPRINT_IDS),
  })
  .strict();
export type InstallBlueprint = z.infer<typeof InstallBlueprintSchema>;

/** Server → client: the install verdict (accelerator; truth = the snapshot). */
export const BlueprintResultSchema = z
  .object({
    type: z.literal('blueprint_result'),
    ok: z.boolean(),
    message: z.string().max(200),
  })
  .strict();
export type BlueprintResult = z.infer<typeof BlueprintResultSchema>;
