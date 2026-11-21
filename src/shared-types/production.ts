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
  /** Built the number of outputs the owner asked for (`prodCount` hit 0). */
  done: 6,
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
  6: 'Done',
});

export function isProcessorKind(kind: string): kind is ProcessorKindId {
  return (PROCESSOR_KIND_IDS as readonly string[]).includes(kind);
}

/**
 * A kind whose default is not its first recipe in catalogue order (the
 * catalogue is append-only wire format, so its order can't be the choice).
 * Owner: a new refinery starts on rock chunks; ice and gas are one Change away.
 */
const DEFAULT_RECIPE: Readonly<Partial<Record<ProcessorKindId, RecipeId>>> = Object.freeze({
  refinery: 'refine_rock_chunk',
});

/** The recipe a processor runs when its owner hasn't picked one. */
export function defaultRecipeFor(kind: ProcessorKindId): RecipeId {
  return DEFAULT_RECIPE[kind] ?? recipesFor(kind)[0]!;
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

/**
 * Loop 3L — `prodFrac`: how far the loaded cycle is, as one byte (0 = none
 * loaded / just started, PROD_FRAC_MAX = done). Rides the processor row so a
 * late joiner sees the Shipyard mid-build at the right point (#16). Both
 * sides use these two helpers (#15).
 */
export const PROD_FRAC_MAX = 255;

/** The `prodFrac` byte for a 0..1 cycle fraction (clamped; NaN reads 0). */
export function encodeProdFrac(fraction: number): number {
  return fraction > 0 ? Math.min(PROD_FRAC_MAX, Math.round(fraction * PROD_FRAC_MAX)) : 0;
}

/** The 0..1 cycle fraction a `prodFrac` byte carries. */
export function decodeProdFrac(v: number | undefined): number {
  return v !== undefined && v > 0 ? Math.min(1, v / PROD_FRAC_MAX) : 0;
}

/**
 * Loop 3R — `prodBay`: which slipway bay a Shipyard's current build sits in
 * (low 3 bits, 0 = the bow bay; `shipyardBayKeel` in
 * core/articulation/rigs/heavyIndustry.ts) and how many more builds are
 * queued behind it (bits 3..5, capped at PROD_QUEUE_MAX), so a client can draw
 * queued outlines in the next bays. Rides the row (#16); 0 = bay 0, none queued.
 */
export const PROD_QUEUE_MAX = 4;

export function encodeProdBay(bay: number, queued: number): number {
  const q = queued > 0 ? Math.min(PROD_QUEUE_MAX, Math.floor(queued)) : 0;
  return (Math.max(0, Math.floor(bay)) & 7) | (q << 3);
}

/** Decode a `prodBay` byte into `out` (reused by the caller, #14). */
export function decodeProdBay(v: number | undefined, out: { bay: number; queued: number }): { bay: number; queued: number } {
  const b = v ?? 0;
  out.bay = b & 7;
  out.queued = (b >> 3) & 7;
  return out;
}

/** Slot blueprint runs on the wire: 0 = no blueprint, BP_RUNS_ORIGINAL = an
 *  original (never runs out), otherwise the copy's runs left. A copy whose
 *  last run is building stays in the server's slot (so handing the cycle back
 *  can refund it) but is sent as 0: to the player the slot is free. */
export const BP_RUNS_ORIGINAL = 65535;

export function encodeBpRuns(bp: { kind: 'bpo' | 'bpc'; runs: number | null } | undefined): number {
  if (bp === undefined) return 0;
  if (bp.kind === 'bpo') return BP_RUNS_ORIGINAL;
  const runs = bp.runs ?? 0;
  return runs <= 0 ? 0 : Math.min(65534, runs);
}

/** Build count (job 2E): the most outputs one `set_recipe` count asks for. */
export const MAX_BUILD_COUNT = 99;

/** Build count on the wire: 0 = no count (repeat forever), else outputs left + 1
 *  (so 1 = done, nothing left). */
export function encodeProdCount(left: number | undefined): number {
  return left === undefined ? 0 : Math.max(0, Math.min(MAX_BUILD_COUNT, left)) + 1;
}

export function decodeProdCount(v: number | undefined): number | undefined {
  return v ? v - 1 : undefined;
}

/** "Waiting for Minerals" style status line for the inspector. */
export function prodStatusLine(state: ProdState, missing: GoodId | undefined, recipe?: RecipeId): string {
  if (state === PROD_STATE.starved && recipe !== undefined && RECIPES[recipe].chunkInput !== undefined) return 'Waiting for a rock chunk';
  if (state === PROD_STATE.starved && missing !== undefined) return `Waiting for ${GOOD_DEFS[missing].displayName}`;
  return PROD_STATE_LABELS[state];
}

/** The next recipe in a processor's cycle (owner's recipe button). */
export function nextRecipe(kind: ProcessorKindId, current: RecipeId): RecipeId {
  const list = recipesFor(kind);
  return list[(list.indexOf(current) + 1) % list.length]!;
}
