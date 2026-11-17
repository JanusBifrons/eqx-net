/**
 * Discrete hold items (economy v2 W2, plan peppy-jumping-pinwheel): blueprint
 * instances and PACKED items. Dependency-free (types + zod only) so `goods.ts`
 * can embed them in `Hold` without an import cycle; the catalogue-aware maths
 * lives in `blueprints.ts` / `core/cargo/hold.ts`.
 *
 * Eve-style industry:
 *  - A BLUEPRINT is needed to produce anything complex. An ORIGINAL (BPO) has
 *    infinite runs; a COPY (BPC) has `runs` left. Real stats, no tiers:
 *    `material` (% fewer inputs) and `output` (output quality). "Quality" in
 *    the UI is only a derived glance score (`blueprintQuality`).
 *  - A blueprint makes ONE PACKED consumable — a packed structure or a packed
 *    hull. Placing / unpacking a packed item costs nothing but time.
 *
 * Product ids are namespaced strings: `structure:<kind>`, `hull:<shipKind>`,
 * `module:<moduleId>`, `recipe:<recipeId>` (recipes are the structures
 * agent's `recipes.ts`).
 */
import { z } from 'zod';

export type BlueprintKind = 'bpo' | 'bpc';

export interface BlueprintItem {
  /** Unique instance id (never shown). */
  uid: string;
  /** What it produces (namespaced product id). */
  product: string;
  kind: BlueprintKind;
  /** Runs left on a copy; null on an original (infinite). */
  runs: number | null;
  /** Material efficiency: % fewer inputs (0 … MATERIAL_MAX). */
  material: number;
  /** Output quality (0 … 100). */
  output: number;
  /** Research levels already applied (originals). */
  research: number;
  /** NPC-generated: cannot be removed from a processor slot (no stealing an
   *  infinite original in a break-in). */
  bound?: boolean;
}

export interface PackedItem {
  /** `structure:<kind>`, `hull:<shipKind>` or `chunk:rock` (a cut rock
   *  chunk, `ROCK_CHUNK_PRODUCT`). */
  product: string;
  /** Quality carried from the blueprint that made it (0 … 100). */
  quality: number;
  /** A one-of-a-kind item's id (a rock chunk): it is its own cargo tile and
   *  is moved by this id, never merged with others of its product. */
  uid?: string;
  /** This item's own cargo weight (a rock chunk's), over its product's. */
  weight?: number;
  /** SERVER ONLY: a rock chunk's hidden ore, what a refinery turns it into
   *  (`OreDraw.chunkYield`). Never on the wire (`wireHold`). */
  ore?: Record<string, number>;
}

/** A cut rock chunk in a hold (owner 2026-11-17: rock never becomes a pod;
 *  a chunk goes into the hold whole and only a refinery turns it into ore). */
export const ROCK_CHUNK_PRODUCT = 'chunk:rock';

export const BlueprintItemSchema = z
  .object({
    uid: z.string().min(1).max(64),
    product: z.string().min(1).max(80),
    kind: z.enum(['bpo', 'bpc']),
    runs: z.number().int().nonnegative().nullable(),
    material: z.number().min(0).max(100),
    output: z.number().min(0).max(100),
    research: z.number().int().nonnegative(),
    bound: z.boolean().optional(),
  })
  .strict();

export const PackedItemSchema = z
  .object({
    product: z.string().min(1).max(80),
    quality: z.number().min(0).max(100),
    uid: z.string().min(1).max(64).optional(),
    weight: z.number().nonnegative().optional(),
    ore: z.record(z.string().max(40), z.number().int().nonnegative()).optional(),
  })
  .strict();

let legacySeq = 0;

/**
 * A pre-W2 blueprint was a bare string id (P5's installable ship upgrades).
 * It becomes a single-run COPY of that module — so existing holds keep their
 * value and the P5 install path keeps working until W5.
 */
export function legacyBlueprintItem(id: string): BlueprintItem {
  return {
    uid: `lg-${Date.now().toString(36)}-${(legacySeq++).toString(36)}`,
    product: id.includes(':') ? id : `module:${id}`,
    kind: 'bpc',
    runs: 1,
    material: 0,
    output: 0,
    research: 0,
  };
}
