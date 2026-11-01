/**
 * Blueprint market (economy v2 W6, plan peppy-jumping-pinwheel): traders sell
 * blueprints (mostly copies, sometimes an original) and buy yours. Pure value
 * maths shared by the server (prices) and the client (labels); the server
 * applies the trader-standing factor on top.
 *
 * A blueprint is worth what it saves you: the product's goods bill × a
 * fraction per run, more for good stats. An ORIGINAL counts as
 * `BPO_RUNS_EQUIV` runs (it never runs out).
 */
import { z } from 'zod';
import { BASE_PRICES } from './economy.js';
import type { GoodId } from './goods.js';
import { MATERIAL_MAX, parseProduct } from './blueprints.js';
import type { BlueprintItem } from './items.js';
import { RECIPES, hullBillValue, isRecipeId, packBillValue } from './recipes.js';
import { isPlayableShipKindId } from './shipKinds.js';
import { isStructureKindId } from './structureKinds.js';

/** A module's "bill" (modules aren't manufactured yet). */
export const MODULE_BILL = 150;
/** One run of a copy is worth this fraction of one product's bill. */
export const BPC_RUN_FRAC = 0.3;
/** An original is worth this many runs. */
export const BPO_RUNS_EQUIV = 40;
/** Best stats add up to this much value (+50 %). */
export const STAT_VALUE_BONUS = 0.5;
/** Traders sell at value × this, and buy at value × `TRADER_BP_BUY_FRAC`. */
export const TRADER_BP_MARKUP = 1.25;
export const TRADER_BP_BUY_FRAC = 0.5;

/** The goods value of ONE unit of a blueprint's product (0 ⇒ unknown). */
export function productBill(product: string): number {
  const { ns, id } = parseProduct(product);
  if (ns === 'structure' && isStructureKindId(id)) return packBillValue(id);
  if (ns === 'hull' && isPlayableShipKindId(id)) return hullBillValue(id);
  if (ns === 'module') return MODULE_BILL;
  if (ns === 'recipe' && isRecipeId(id)) {
    let v = 0;
    for (const [g, n] of Object.entries(RECIPES[id].inputs)) v += BASE_PRICES[g as GoodId] * (n ?? 0);
    return v;
  }
  return 0;
}

/** A blueprint's base value in credits (before the trader's cut / standing). */
export function blueprintValue(bp: Pick<BlueprintItem, 'product' | 'kind' | 'runs' | 'material' | 'output'>): number {
  const bill = productBill(bp.product);
  if (bill <= 0) return 0;
  const stats = (Math.min(MATERIAL_MAX, bp.material) / MATERIAL_MAX + Math.min(100, bp.output) / 100) / 2;
  const runs = bp.kind === 'bpo' ? BPO_RUNS_EQUIV : Math.max(0, bp.runs ?? 0);
  return Math.round(bill * BPC_RUN_FRAC * runs * (1 + STAT_VALUE_BONUS * stats));
}

// ── Messages (strict; every client message carries its `type`) ─────────────

const entityId = z.number().int().nonnegative();
const id = z.string().min(1).max(80);

export const BpMarketQuerySchema = z.object({ type: z.literal('bp_market_query'), networkEntityId: entityId }).strict();
export const BpBuySchema = z.object({ type: z.literal('bp_buy'), networkEntityId: entityId, offerId: id }).strict();
export const BpSellSchema = z.object({ type: z.literal('bp_sell'), networkEntityId: entityId, uid: id }).strict();

/** A blueprint as the market lists it (names, never ids — the uid / offerId
 *  travel only so the client can say which one it means). */
export const BpListingSchema = z
  .object({
    id,
    name: z.string().max(80),
    kind: z.enum(['bpo', 'bpc']),
    runs: z.number().int().nonnegative().nullable(),
    material: z.number().nonnegative(),
    output: z.number().nonnegative(),
    quality: z.number().nonnegative(),
    price: z.number().int().nonnegative(),
  })
  .strict();
export type BpListing = z.infer<typeof BpListingSchema>;

export const BpMarketStateSchema = z
  .object({
    type: z.literal('bp_market_state'),
    networkEntityId: entityId,
    /** Traders' blueprints for sale (`id` = offerId, `price` = what you pay). */
    offers: z.array(BpListingSchema).max(20),
    /** Blueprints in this base (`id` = uid, `price` = what traders pay). */
    mine: z.array(BpListingSchema).max(200),
    ok: z.boolean().optional(),
    message: z.string().max(200).optional(),
  })
  .strict();
export type BpMarketState = z.infer<typeof BpMarketStateSchema>;
