/**
 * Cargo access messages (plan soft-leaping-truffle v3, C1).
 *
 * A pilot flies up to a storage structure and opens its cargo. The server
 * decides whether it opens (`relationOf` → `cargoOpensFor`, range, a live ship)
 * and replies with `cargo_state`. The structure pane is rebuilt from
 * `cargo_state` replies ONLY (#16); the ship pane is the own-ship snapshot
 * cargo slice. Every move replies with a fresh `cargo_state` carrying a
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

export const CargoQuerySchema = z.object({ entityId }).strict();
export type CargoQuery = z.infer<typeof CargoQuerySchema>;

/** `take` = structure → your ship; `put` = your ship → structure. */
export const CargoMoveSchema = z
  .object({ entityId, dir: z.enum(['take', 'put']), items: CargoItemsSchema })
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
    /** The verdict of the action this replies to, or why it's locked. */
    message: z.string().max(200).optional(),
    ok: z.boolean().optional(),
  })
  .strict();
export type CargoState = z.infer<typeof CargoStateSchema>;
