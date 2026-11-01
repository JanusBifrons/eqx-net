/**
 * Production status on the wire (plan soft-leaping-truffle v3, P2b). A
 * processor's room-state row carries three bytes, each sent only when not 0:
 *  - `recipe`: the selected recipe as `recipeIndex + 1` (0 = the kind's default);
 *  - `prodState`: one of `PROD_STATE` below;
 *  - `prodMissing`: when starved, the missing good as `goodIndex + 1`.
 * Both sides read these constants (#15). Append-only.
 */
import { GOOD_DEFS, GOOD_IDS, type GoodId } from './goods.js';
import { PROCESSOR_KIND_IDS, RECIPES, RECIPE_IDS, recipesFor, type ProcessorKindId, type RecipeId } from './recipes.js';

export const PROD_STATE = {
  /** Not a processor, or not built yet. */
  none: 0,
  /** Making something. */
  running: 1,
  /** Waiting for an input the network doesn't have (`prodMissing` says which). */
  starved: 2,
  /** Finished, but the network's storage has no room for the output. */
  blocked: 3,
  /** The grid has no power for it. */
  unpowered: 4,
  /** The recipe needs a blueprint and none is loaded. */
  needsBlueprint: 5,
} as const;
export type ProdState = (typeof PROD_STATE)[keyof typeof PROD_STATE];

/** Short player-facing labels (no raw ids). */
export const PROD_STATE_LABELS: Readonly<Record<ProdState, string>> = Object.freeze({
  0: '',
  1: 'Running',
  2: 'Waiting for input',
  3: 'Storage full',
  4: 'No power',
  5: 'Needs a blueprint',
});

export function isProcessorKind(kind: string): kind is ProcessorKindId {
  return (PROCESSOR_KIND_IDS as readonly string[]).includes(kind);
}

/** The recipe a processor runs when its owner hasn't picked one. */
export function defaultRecipeFor(kind: ProcessorKindId): RecipeId {
  return recipesFor(kind)[0]!;
}

/** Wire byte for a selected recipe (0 = default). */
export function encodeRecipe(recipe: RecipeId | undefined): number {
  return recipe === undefined ? 0 : RECIPE_IDS.indexOf(recipe) + 1;
}

export function decodeRecipe(v: number | undefined): RecipeId | undefined {
  return v ? RECIPE_IDS[v - 1] : undefined;
}

/** The recipe a processor of `kind` is running, given its wire byte. */
export function effectiveRecipe(kind: ProcessorKindId, wire: number | undefined): RecipeId {
  const r = decodeRecipe(wire);
  return r !== undefined && RECIPES[r].processors.includes(kind) ? r : defaultRecipeFor(kind);
}

export function encodeGood(g: GoodId | undefined): number {
  return g === undefined ? 0 : GOOD_IDS.indexOf(g) + 1;
}

export function decodeGood(v: number | undefined): GoodId | undefined {
  return v ? GOOD_IDS[v - 1] : undefined;
}

/** Slot blueprint runs on the wire: 0 = no blueprint, BP_RUNS_ORIGINAL = an
 *  original (never runs out), otherwise the copy's runs left. */
export const BP_RUNS_ORIGINAL = 65535;

export function encodeBpRuns(bp: { kind: 'bpo' | 'bpc'; runs: number | null } | undefined): number {
  if (bp === undefined) return 0;
  return bp.kind === 'bpo' ? BP_RUNS_ORIGINAL : Math.max(1, Math.min(65534, bp.runs ?? 0));
}

/** "Waiting for Minerals" style status line for the inspector. */
export function prodStatusLine(state: ProdState, missing: GoodId | undefined): string {
  if (state === PROD_STATE.starved && missing !== undefined) return `Waiting for ${GOOD_DEFS[missing].displayName}`;
  return PROD_STATE_LABELS[state];
}

/** The next recipe in a processor's cycle (owner's recipe button). */
export function nextRecipe(kind: ProcessorKindId, current: RecipeId): RecipeId {
  const list = recipesFor(kind);
  return list[(list.indexOf(current) + 1) % list.length]!;
}
