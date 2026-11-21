/**
 * Production status on the wire (plan soft-leaping-truffle v3, P2b). A
 * processor's room-state row carries three bytes, each sent only when not 0:
 *  - `recipe`: the selected recipe as `recipeIndex + 1` (0 = the kind's default);
 *  - `prodState`: one of `PROD_STATE` below;
 *  - `prodMissing`: when starved, the missing good as `goodIndex + 1`.
 * Both sides read these constants (#15). Append-only.
 */
import { GOOD_DEFS, GOOD_IDS, type GoodId } from './goods.js';
import { PROCESSOR_KIND_IDS, RECIPES, RECIPE_IDS, blueprintProductFor, recipesFor, type ProcessorKindId, type RecipeId } from './recipes.js';

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

/** Recipe queue (building panels B2): the most entries one processor queues,
 *  counting the head it is running now. */
export const MAX_RECIPE_QUEUE = 8;

/** Build count on the wire: 0 = no count (repeat forever), else outputs left + 1
 *  (so 1 = done, nothing left). */
export function encodeProdCount(left: number | undefined): number {
  return left === undefined ? 0 : Math.max(0, Math.min(MAX_BUILD_COUNT, left)) + 1;
}

export function decodeProdCount(v: number | undefined): number | undefined {
  return v ? v - 1 : undefined;
}

/**
 * Recipe queue on the wire (building panels B4): two uint32 row fields,
 * `prodQ0` and `prodQ1`, carry the entries after the head as `encodeRecipe`
 * bytes, low byte first (0 = empty, so a short queue ends at the first 0).
 * `prodQ0` holds entries 0..3, `prodQ1` entries 4..6 in its low three bytes;
 * its top byte is free (the queue never exceeds MAX_RECIPE_QUEUE - 1 = 7), so
 * bit 31 carries the repeat flag. Both 0 = no queue, repeat off.
 */
export const PROD_QUEUE_WIRE_SLOTS = 7;
const PROD_Q_REPEAT = 0x80000000;

/** Pack entries `from..from+n-1` of `queue` into one uint32 (byte per entry). */
function packQueueWord(queue: readonly RecipeId[] | undefined, from: number, n: number): number {
  let w = 0;
  let mul = 1;
  const len = queue === undefined ? 0 : Math.min(queue.length, PROD_QUEUE_WIRE_SLOTS);
  for (let i = from; i < from + n && i < len; i++) {
    w += encodeRecipe(queue![i]) * mul;
    mul *= 256;
  }
  return w;
}

/** `prodQ0`: the first four queued entries. */
export function encodeProdQ0(queue: readonly RecipeId[] | undefined): number {
  return packQueueWord(queue, 0, 4);
}

/** `prodQ1`: queued entries 4..6, the slot blueprint (`encodeBpProduct`,
 *  building panels B7) in bits 24..30, and the repeat flag in bit 31. */
export function encodeProdQ1(queue: readonly RecipeId[] | undefined, repeat: boolean | undefined, bpProduct = 0): number {
  const bp = bpProduct > 0 && bpProduct <= BP_PRODUCT_MAX ? bpProduct * BP_PRODUCT_MUL : 0;
  return packQueueWord(queue, 4, 3) + bp + (repeat === true ? PROD_Q_REPEAT : 0);
}

/** True when `prodQ1` carries queue entries (not just the B7 slot byte or the
 *  repeat flag). */
export function prodQ1HasQueue(q1: number | undefined): boolean {
  return (q1 ?? 0) % BP_PRODUCT_MUL !== 0;
}

export function decodeProdQueueRepeat(q1: number | undefined): boolean {
  return (q1 ?? 0) >= PROD_Q_REPEAT;
}

/** Decode `prodQ0` / `prodQ1` into `out` IN PLACE (cleared first; the caller
 *  reuses one array per row, #14). Stops at the first empty byte; an unknown
 *  recipe byte (newer server) ends the list too. */
export function decodeProdQueue(q0: number | undefined, q1: number | undefined, out: RecipeId[]): RecipeId[] {
  out.length = 0;
  let w = q0 ?? 0;
  for (let i = 0; i < 4; i++) {
    const r = decodeRecipe(w % 256);
    if (r === undefined) return out;
    out.push(r);
    w = Math.floor(w / 256);
  }
  w = (q1 ?? 0) % PROD_Q_REPEAT;
  for (let i = 0; i < 3; i++) {
    const r = decodeRecipe(w % 256);
    if (r === undefined) return out;
    out.push(r);
    w = Math.floor(w / 256);
  }
  return out;
}

/**
 * Building panels B7 — which blueprints a processor can reach, on its row.
 * Both values index the kind's OWN recipe list (`kindRecipes`: `recipesFor`
 * in catalogue order; the catalogue is append-only, so a position never moves):
 *  - `bpProduct`: the slot blueprint's product as position + 1, in bits
 *    24..30 of `prodQ1` (0 = no blueprint, or one for nothing this kind makes);
 *  - `bpAvail` (uint32): bit i set = network storage holds a usable blueprint
 *    for the kind's recipe i. Every kind runs at most BP_AVAIL_MAX_RECIPES
 *    recipes (locked by production.bpAvailWire.test.ts).
 * A recipe is buildable when its blueprint is in the slot OR in storage (the
 * queue swaps it in, `swapBlueprintFor`). Both sides use these helpers (#15).
 */
export const BP_AVAIL_MAX_RECIPES = 32;
const BP_PRODUCT_MUL = 0x1000000; // bit 24
const BP_PRODUCT_MAX = 127; // seven bits (24..30)

const KIND_RECIPES = new Map<ProcessorKindId, readonly RecipeId[]>();
/** product -> bits of the kind's recipes a blueprint for it serves. */
const KIND_PRODUCT_BITS = new Map<ProcessorKindId, ReadonlyMap<string, number>>();

/** A processor kind's recipe list, cached (no allocation after the first call). */
export function kindRecipes(kind: ProcessorKindId): readonly RecipeId[] {
  let l = KIND_RECIPES.get(kind);
  if (l === undefined) {
    l = Object.freeze(recipesFor(kind));
    KIND_RECIPES.set(kind, l);
  }
  return l;
}

function productBits(kind: ProcessorKindId): ReadonlyMap<string, number> {
  let m = KIND_PRODUCT_BITS.get(kind);
  if (m === undefined) {
    const map = new Map<string, number>();
    const list = kindRecipes(kind);
    for (let i = 0; i < list.length && i < BP_AVAIL_MAX_RECIPES; i++) {
      const p = blueprintProductFor(list[i]!);
      map.set(p, ((map.get(p) ?? 0) | (1 << i)) >>> 0);
    }
    KIND_PRODUCT_BITS.set(kind, map);
    m = map;
  }
  return m;
}

/** Bits (kind recipe positions) a blueprint for `product` serves; 0 = none. */
export function blueprintRecipeBits(kind: ProcessorKindId, product: string): number {
  return productBits(kind).get(product) ?? 0;
}

/** Does any recipe this kind runs need a blueprint? (Only those kinds carry `bpAvail`.) */
export function kindNeedsBlueprints(kind: ProcessorKindId): boolean {
  const list = kindRecipes(kind);
  for (let i = 0; i < list.length; i++) if (RECIPES[list[i]!].blueprintRequired) return true;
  return false;
}

/** The `bpProduct` value (0..127) for a slot blueprint's product. */
export function encodeBpProduct(kind: ProcessorKindId, product: string | undefined): number {
  if (product === undefined) return 0;
  const bits = blueprintRecipeBits(kind, product);
  if (bits === 0) return 0;
  const pos = 31 - Math.clz32(bits & -bits); // lowest set bit
  return pos + 1 <= BP_PRODUCT_MAX ? pos + 1 : 0;
}

/** The recipe the slot blueprint is for, from `prodQ1`; null = none. */
export function decodeBpProduct(kind: ProcessorKindId, q1: number | undefined): RecipeId | null {
  const v = Math.floor(((q1 ?? 0) % PROD_Q_REPEAT) / BP_PRODUCT_MUL);
  return v > 0 ? kindRecipes(kind)[v - 1] ?? null : null;
}

/** Decode `bpAvail` into `out` IN PLACE (cleared first; one array per row, #14). */
export function decodeBpAvail(kind: ProcessorKindId, mask: number | undefined, out: RecipeId[]): RecipeId[] {
  out.length = 0;
  const m = mask ?? 0;
  if (m === 0) return out;
  const list = kindRecipes(kind);
  for (let i = 0; i < list.length && i < BP_AVAIL_MAX_RECIPES; i++) if (((m >>> i) & 1) !== 0) out.push(list[i]!);
  return out;
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
