/**
 * Structure-kind lookups — the id-keyed map, the catalogue version and the
 * id / wire-index helpers, all derived from `catalogueOrder.ts`.
 */
import type { StructureKind, StructureKindId } from './types.js';
import { STRUCTURE_KINDS_LIST } from './catalogueOrder.js';

/** Id-keyed lookup, derived from the canonical list (the list is the source of
 *  truth for wire order; this object is a convenience for id-based lookup).
 *  Both agree by construction; the golden test snapshots both. */
export const STRUCTURE_KINDS: Record<StructureKindId, StructureKind> = Object.freeze(
  Object.fromEntries(STRUCTURE_KINDS_LIST.map((k) => [k.id, k])) as Record<
    StructureKindId,
    StructureKind
  >,
);

/** Bump when an EXISTING kind's record changes (any numeric field): a bump
 *  discards saved structures on the next boot (they were minted under the old
 *  stats). Appending a new kind does not need a bump.
 *  3→4 (WS-5): added `CAPITAL.connectionRange = 300` (R2.10).
 *  4→5 (WS-6): shrank CONNECTOR.radius 24→10 + SHIELD_PYLON.radius 30→12 (R2.11/R2.18).
 *  5→6 (WS-8): appended LASER_BOLT_TURRET + MISSILE_TURRET defence kinds (R2.15).
 *  6→7 (P3.2): removed CAPITAL.connectionRange — uniform connection range.
 *  9→10 (P2e, plan soft-leaping-truffle v3): mining + bank retuned to the goods
 *  scale (Miner 1000→20 a pulse, Capital bank 2M→50k, Deep Core Rig 6000→120).
 *  10→11 (structure-restyle 2c++): FREIGHT_DOCK grown to the medium size,
 *  520×240 → 1000×400 (radius 287→539): an old dock could overlap on restore.
 *  11→12 (structure-restyle): FREIGHT_DOCK gains its `keepClear` landing pad;
 *  a saved structure could sit on a restored dock's pad.
 *  12→13 (structure-restyle 3i): CAPITAL gains its crane bay `keepClear` pad;
 *  a saved structure could sit on a restored Capital's pad.
 *  13→14 (structure-restyle stage 4, family 1 size lane): SOLAR 360×150 →
 *  700×300 (power 30→120, cost 120→480); REACTOR 400×400 → 600×600 (power
 *  240→960, cost 1500→4000); BATTERY_BANK 360×360 → 600×600.
 *  14→15 (base loop): SHIPYARD power 220→180, cost 6500→2000 so a starter
 *  base fits the 5,000-mineral Capital bank.
 *  15→16 (structure-restyle F2, gate family size): SHIELD_GATE 320×72 →
 *  416×72, SHIELD_AIRLOCK 320×260 → 392×260, SHIELD_PYLON 72×72 → 120×120
 *  (the openings ships fly through are unchanged).
 *  16→17 (base platforms): every kind gains `deckSlot`. No size or stat
 *  changed, so the bump wipes no kind (`STRUCTURE_KIND_WIPES[17] = []`). */
export const STRUCTURE_KIND_CATALOGUE_VERSION = 17;
// Gates (SHIELD_GATE, SHIELD_AIRLOCK) were APPENDED without a bump: a bump
// discards every saved structure on the next boot (SectorPersistence's version
// gate), and appending a kind leaves every existing record — and so every saved
// row — valid. The user agreed to exactly one reset (8→9).
// 8→9 (plan soft-leaping-truffle v2, phase V): every kind gets a large
// rectangular `footprint` (radius becomes its bounding circle); structures can
// rotate in 90° steps. Persisted structures from v8 are discarded once (user
// decision 2026-11-01: one-time reset, no migration).
// 7→8 (Living World P1a-2): appended CARGO_BAY + the `holdCapacity` field.

/** The pre-built anchor every base starts from. */
export const DEFAULT_STRUCTURE_KIND: StructureKindId = 'capital';

/** Resolve a kind's record. Forgiving: unknown ids fall back to the Capital,
 *  matching `getShipKind`'s stance so a malformed id never crashes. */
/**
 * Kinds nobody builds: they never appear in a build menu, have no blueprint
 * or pack recipe, and a player's `place_structure` of one is refused. The
 * world places them itself (the Ancients' gates).
 */
export const UNBUILDABLE_STRUCTURE_KINDS: readonly StructureKindId[] = ['alien_gate', 'pocket_pad'];

export function isBuildableStructureKind(id: string): boolean {
  return !(UNBUILDABLE_STRUCTURE_KINDS as readonly string[]).includes(id);
}

/**
 * Does this kind act as a grid connector (a cable junction the power grid
 * routes through)? The ONE answer to "is this a connector?" for server and
 * client alike: plate buildings (large teleporter, alien gate) will join this
 * set later, so never test `kind === 'connector'` directly.
 */
export function isConnectorKind(kind: string | null | undefined): boolean {
  return kind === 'connector';
}

/**
 * Flat deck tiles (base platforms): kinds that lie ON the deck. Their body is
 * a permanent hologram (the blueprint ghost body, never turned solid:
 * `server/structures/blueprintBody.ts`), so ships fly over them, navigation
 * routes over them and no weapon touches them (`isWeaponTransparent`). The
 * ONE answer for server and client alike.
 */
export const FLAT_DECK_STRUCTURE_KINDS: readonly StructureKindId[] = ['road'];

export function isFlatDeckKind(kind: string | null | undefined): boolean {
  return kind === 'road';
}

/** Kinds only a deck room builds (base platforms, room flag `deck`): the
 *  build menu hides them elsewhere and the server refuses them. */
export const DECK_ONLY_STRUCTURE_KINDS: readonly StructureKindId[] = ['road'];

export function isDeckOnlyStructureKind(kind: string): boolean {
  return (DECK_ONLY_STRUCTURE_KINDS as readonly string[]).includes(kind);
}

export function getStructureKind(id: string | null | undefined): StructureKind {
  if (id != null && Object.prototype.hasOwnProperty.call(STRUCTURE_KINDS, id)) {
    return STRUCTURE_KINDS[id as StructureKindId];
  }
  return STRUCTURE_KINDS[DEFAULT_STRUCTURE_KIND];
}

/** Type guard — narrows a string to `StructureKindId`. */
export function isStructureKindId(id: string): id is StructureKindId {
  return Object.prototype.hasOwnProperty.call(STRUCTURE_KINDS, id);
}

/** Index in `STRUCTURE_KINDS_LIST` — the wire subtype byte. Unknown ids → 0
 *  (the Capital), the same forgiving stance as `shipKindToIndex`. */
export function structureKindToIndex(id: StructureKindId): number {
  for (let i = 0; i < STRUCTURE_KINDS_LIST.length; i++) {
    if (STRUCTURE_KINDS_LIST[i]!.id === id) return i;
  }
  return 0;
}

/** Inverse of `structureKindToIndex`. Out-of-range indices fall back to the
 *  Capital. */
export function structureKindFromIndex(index: number): StructureKindId {
  const k = STRUCTURE_KINDS_LIST[index];
  return k ? k.id : DEFAULT_STRUCTURE_KIND;
}
