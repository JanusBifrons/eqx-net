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
import { STARTER_STRUCTURE_KINDS, needsPackedCrate } from './blueprints.js';
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
 *  nothing is locked, so the menu never blocks on a slow reply).
 *  `inSector` false = a room with no sector (engineering / test sandbox: no
 *  hold), where the server places a Capital without a crate. */
export function buildEntry(kindId: string, counts: Readonly<Record<string, number>> | null, inSector = true): BuildEntry {
  const name = getStructureKind(kindId).displayName;
  const crate = needsPackedCrate(kindId) && inSector;
  if (!crate && STARTER_STRUCTURE_KINDS.includes(kindId)) return { label: name, locked: false, count: null };
  if (counts === null) return { label: name, locked: false, count: null };
  const n = counts[`structure:${kindId}`] ?? 0;
  if (n > 0) return { label: `${name} ×${n}`, locked: false, count: n };
  // Only the Capital locks; any other kind builds from the bank.
  return crate ? { label: `${name} · needs packed`, locked: true, count: 0 } : { label: name, locked: false, count: 0 };
}

/** Kinds placed ONCE per pick: placement ends after a successful place (a
 *  base has one Capital; a sector one lock). Every other kind keeps placing
 *  until the player cancels (build-menu redesign M3). */
export const PLACE_ONCE_KINDS: ReadonlySet<string> = new Set(['capital', 'territory_lock']);

/** The keep-placing rule, shared by the touch Confirm and the desktop click:
 *  after a successful place of `kindId`, does placement end? Yes for a
 *  place-once kind, or a crate-stocked kind whose last crate that was (`counts`
 *  is the stock BEFORE the place; unknown stock never ends it). `planned`:
 *  how many `kindId` are already planned (plan then Build), each spending a
 *  crate of that stock when Build sends them. */
export function placementEndsAfterPlace(
  kindId: string, counts: Readonly<Record<string, number>> | null, inSector = true, planned = 0,
): boolean {
  if (PLACE_ONCE_KINDS.has(kindId)) return true;
  if (!needsPackedCrate(kindId) || !inSector || counts === null) return false;
  return (counts[`structure:${kindId}`] ?? 0) - planned <= 1;
}
