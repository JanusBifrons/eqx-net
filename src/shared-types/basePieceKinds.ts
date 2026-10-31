/**
 * Base PIECE catalogue — the architectural vocabulary of procedural bases
 * (Tier A: static, seed-derived geometry; plan: soft-leaping-truffle).
 *
 * APPEND-ONLY (the Invariant #11 contract). A piece's index in
 * `BASE_PIECE_KINDS_LIST` is stored in every generated layout and is part of
 * the version-locked layout hash, so reordering/removing silently changes
 * every base. Append a record and bump `BASE_PIECE_CATALOGUE_VERSION`.
 *
 * Pieces are NOT entities — no slot, no wire record. Geometry is regenerated
 * from the base seed on every side; only per-piece destroy bits travel.
 *
 * `solid: false` pieces (floors, pad markings) are visual only: no collider,
 * no weapon blocking, never counted against clearance.
 */

export type BasePieceRole = 'structural' | 'city' | 'industrial' | 'military';

export interface BasePieceKind {
  readonly id: string;
  readonly role: BasePieceRole;
  /** Blocks ships and weapons. */
  readonly solid: boolean;
  /** Hit points before the piece is destroyed (0 = indestructible). */
  readonly hp: number;
  /** Render palette slot (resolved by the client renderer). */
  readonly palette: 'hull' | 'hullDark' | 'rack' | 'cargo' | 'habitat' | 'tower' | 'military' | 'floor' | 'accent';
}

export const BASE_PIECE_KINDS_LIST: readonly BasePieceKind[] = Object.freeze([
  { id: 'wall', role: 'structural', solid: true, hp: 4000, palette: 'hullDark' },
  { id: 'rack_row', role: 'industrial', solid: true, hp: 1500, palette: 'rack' },
  { id: 'container_stack', role: 'industrial', solid: true, hp: 800, palette: 'cargo' },
  { id: 'loading_bay', role: 'industrial', solid: false, hp: 0, palette: 'floor' },
  { id: 'gate_post', role: 'structural', solid: true, hp: 3000, palette: 'accent' },
]);

/** Bump on ANY append or numeric change to a record above. */
export const BASE_PIECE_CATALOGUE_VERSION = 1;

const INDEX = new Map(BASE_PIECE_KINDS_LIST.map((k, i) => [k.id, i] as const));

/** Catalogue index of a piece kind id (the value stored in layouts). */
export function basePieceIndex(id: string): number {
  const i = INDEX.get(id);
  if (i === undefined) throw new Error(`unknown base piece kind: ${id}`);
  return i;
}

export function basePieceKindAt(index: number): BasePieceKind {
  const k = BASE_PIECE_KINDS_LIST[index];
  if (k === undefined) throw new Error(`base piece index out of range: ${index}`);
  return k;
}
