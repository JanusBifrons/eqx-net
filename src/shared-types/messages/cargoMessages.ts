/**
 * Cargo access messages (plan soft-leaping-truffle v3, C1).
 *
 * A pilot flies up to a storage structure and opens its cargo. The server
 * decides whether it opens (`relationOf` → `cargoOpensFor`, range, a live ship)
 * and replies with `cargo_state`. Both panes (the structure and the pilot's
 * ship) are rebuilt from `cargo_state` replies ONLY (#16), so they always
 * agree. Every move replies with a fresh `cargo_state` carrying a
 * player-facing `message`.
 */
import { z } from 'zod';
import { GOOD_IDS, HoldSchema } from '../goods.js';

const entityId = z.number().int().nonnegative();
const uid = z.string().min(1).max(80);
const product = z.string().min(1).max(80);

/** Fly within this distance of a structure's footprint to open its cargo. */
export const CARGO_ACCESS_RANGE = 400;

/** The items to move: goods by count, blueprints by uid, packed items by
 *  product (one entry per item). Mirrors `core/cargo/hold.ts` `CargoRequest`. */
export const CargoItemsSchema = z
  .object({
    goods: z.partialRecord(z.enum(GOOD_IDS), z.number().int().positive().max(1_000_000)).optional(),
    blueprints: z.array(uid).max(64).optional(),
    packed: z.array(product).max(64).optional(),
  })
  .strict();
export type CargoItems = z.infer<typeof CargoItemsSchema>;

// Client messages carry their `type` (tradeClient's send() adds it).
/** T4b — a standing order on a player's own Freight Dock. NPC convoys fill
 *  it from real NPC stock: `import` keeps the base's network stocked up to
 *  `level` (delivered when it falls below half), `export` sells anything
 *  above `level`. Paid at the trade board's regional price. */
export const MAX_FREIGHT_ORDERS = 6;
export const FreightOrderSchema = z
  .object({
    good: z.enum(GOOD_IDS),
    mode: z.enum(['import', 'export']),
    level: z.number().int().min(1).max(100_000),
  })
  .strict();
export type FreightOrder = z.infer<typeof FreightOrderSchema>;

export const SetFreightOrdersSchema = z
  .object({ type: z.literal('set_freight_orders'), entityId, orders: z.array(FreightOrderSchema).max(MAX_FREIGHT_ORDERS) })
  .strict();
export type SetFreightOrders = z.infer<typeof SetFreightOrdersSchema>;

/** C2 — start / stop breaking into cargo that doesn't open for you. */
export const BreakInSchema = z.object({ type: z.literal('break_in'), entityId }).strict();
export const BreakInCancelSchema = z.object({ type: z.literal('break_in_cancel') }).strict();
/** C2 — server → client: an alarm (to the owner) or a result (to the actor).
 *  Accelerator only: the truth is `cargo_state` and the BREACH flag (#16). */
export const BreakInNoticeSchema = z
  .object({ type: z.literal('break_in_notice'), tone: z.enum(['good', 'danger']), message: z.string().max(200) })
  .strict();
export type BreakInNotice = z.infer<typeof BreakInNoticeSchema>;

export const CargoQuerySchema = z.object({ type: z.literal('cargo_query'), entityId }).strict();
export type CargoQuery = z.infer<typeof CargoQuerySchema>;

/** `take` = structure → your ship; `put` = your ship → structure. */
export const CargoMoveSchema = z
  .object({ type: z.literal('cargo_move'), entityId, dir: z.enum(['take', 'put']), items: CargoItemsSchema })
  .strict();
export type CargoMove = z.infer<typeof CargoMoveSchema>;

export const CargoStateSchema = z
  .object({
    type: z.literal('cargo_state'),
    entityId,
    /** Is the cargo open to this pilot right now? */
    open: z.boolean(),
    /** The structure's contents (incl. a Capital's mineral bank), when open. */
    hold: HoldSchema.nullable(),
    /** Goods-hold weight used / capacity (the bank is extra). */
    used: z.number().nonnegative(),
    capacity: z.number().nonnegative(),
    /** The pilot's ship hold and its capacity, when open. */
    ship: HoldSchema.nullable(),
    shipCapacity: z.number().nonnegative(),
    /** C2 — locked cargo you may break into: your progress (0..1, null =
     *  not started) and how long it takes. */
    breakIn: z.object({ pct: z.number().min(0).max(1).nullable(), durationMs: z.number().int().positive() }).strict().optional(),
    /** T4b — your own Freight Dock's standing orders (absent otherwise). */
    orders: z.array(FreightOrderSchema).max(MAX_FREIGHT_ORDERS).optional(),
    /** T4 — an NPC Freight Dock: a market, not free access. `hold` is the
     *  base's stock; per-unit prices: `buy` = you pay, `sell` = you get. */
    market: z
      .object({
        buy: z.partialRecord(z.enum(GOOD_IDS), z.number().nonnegative()),
        sell: z.partialRecord(z.enum(GOOD_IDS), z.number().nonnegative()),
      })
      .strict()
      .optional(),
    /** The verdict of the action this replies to, or why it's locked. */
    message: z.string().max(200).optional(),
    ok: z.boolean().optional(),
  })
  .strict();
export type CargoState = z.infer<typeof CargoStateSchema>;
