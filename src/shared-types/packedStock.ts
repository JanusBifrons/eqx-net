/**
 * Packed-structure stock for the Build menus (economy v2). A non-starter
 * structure is placed from a PACKED item, so the menus show how many you have
 * here and lock the kinds you have none of, instead of only refusing on
 * placement. Starter kinds always build from minerals.
 *
 * The counts are a request/reply view (#16): `packed_stock_query` →
 * `packed_stock`, covering the owner's storage in this sector and their ship's
 * hold (the same places the placement gate looks).
 */
import { z } from 'zod';
import { STARTER_STRUCTURE_KINDS } from './blueprints.js';
import { getStructureKind } from './structureKinds.js';

export const PackedStockQuerySchema = z.object({ type: z.literal('packed_stock_query') }).strict();

export const PackedStockSchema = z
  .object({
    type: z.literal('packed_stock'),
    /** Packed `structure:<kind>` product → how many you have here. */
    counts: z.record(z.string().max(80), z.number().int().nonnegative()),
  })
  .strict();
export type PackedStock = z.infer<typeof PackedStockSchema>;

export interface BuildEntry {
  label: string;
  /** No packed one here: the kind can't be placed yet. */
  locked: boolean;
  /** How many packed ones you have (null for starter kinds). */
  count: number | null;
}

/** A Build-menu entry for `kindId` given the stock (null ⇒ not known yet:
 *  nothing is locked, so the menu never blocks on a slow reply). */
export function buildEntry(kindId: string, counts: Readonly<Record<string, number>> | null): BuildEntry {
  const name = getStructureKind(kindId).displayName;
  if (STARTER_STRUCTURE_KINDS.includes(kindId)) return { label: name, locked: false, count: null };
  if (counts === null) return { label: name, locked: false, count: null };
  const n = counts[`structure:${kindId}`] ?? 0;
  return n > 0
    ? { label: `${name} ×${n}`, locked: false, count: n }
    : { label: `${name} · buy packed`, locked: true, count: 0 };
}
