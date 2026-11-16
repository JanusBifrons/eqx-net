/** Wreck lineage (rock cut / laser spread): every wreck carries the id of the
 *  root wreck it descends from (`LiveWreck.root`). These walk the
 *  CapitalWreckSubsystem's maps; split out of it for its size cap. */
import { wreckSalvageQty } from '../../core/destruction/wreckIntegrity.js';
import { GOOD_DEFS } from '../../shared-types/goods.js';
import type { LiveWreck, PieceKnock } from './capitalWreckTypes.js';

/** Visit every live piece id descended from root wreck `root` (the root's
 *  own pieces and every re-split generation below it). Allocates nothing
 *  (#14). */
export function forEachLineagePiece(
  wrecks: ReadonlyMap<number, LiveWreck>, pieceWreck: ReadonlyMap<string, number>,
  root: number, visit: (pieceId: string) => void,
): void {
  for (const w of wrecks.values()) {
    if (w.root !== root || w.pieces <= 0) continue;
    const wreckId = w.desc.wreckId;
    for (let i = 0; i < w.ids.length; i++) {
      const id = w.ids[i]!;
      if (pieceWreck.get(id) === wreckId) visit(id);
    }
  }
}

/** The lineage root of the live wreck piece `pieceId`, or null. */
export function lineageRootOf(
  wrecks: ReadonlyMap<number, LiveWreck>, pieceWreck: ReadonlyMap<string, number>, pieceId: string,
): number | null {
  const wreckId = pieceWreck.get(pieceId);
  const w = wreckId !== undefined ? wrecks.get(wreckId) : undefined;
  return w !== undefined ? w.root : null;
}

/** `CapitalWreckSubsystem.pieceSalvageQty`: a live piece's salvage if stored
 *  whole, what it would leave as a pod when worn out (`wreckSalvageQty` of
 *  its mass). 0: not a live ship-wreck piece (rock pieces store as ore later). */
export function pieceSalvageQtyOf(
  wrecks: ReadonlyMap<number, LiveWreck>, pieceWreck: ReadonlyMap<string, number>,
  knock: ReadonlyMap<string, PieceKnock>, id: string,
): number {
  const k = knock.get(id);
  const wreckId = pieceWreck.get(id);
  const w = wreckId !== undefined ? wrecks.get(wreckId) : undefined;
  return k === undefined || w === undefined || w.src.rock !== null ? 0 : wreckSalvageQty(w.src, k.mass);
}

/** `CapitalWreckSubsystem.pieceHaul`: a live piece's mass and the hold weight
 *  it stores as (its salvage worth, `wreckSalvageQty`, in salvage goods): the
 *  haul test of the lock salvage bits (lockSalvage.ts). False when `id` is
 *  not a live piece. */
export function pieceHaulOf(
  wrecks: ReadonlyMap<number, LiveWreck>, pieceWreck: ReadonlyMap<string, number>,
  knock: ReadonlyMap<string, PieceKnock>, id: string, out: { mass: number; holdWeight: number },
): boolean {
  const k = knock.get(id);
  const w = k === undefined ? undefined : wrecks.get(pieceWreck.get(id) ?? -1);
  if (k === undefined || w === undefined) return false;
  out.mass = k.mass;
  out.holdWeight = wreckSalvageQty(w.src, k.mass) * GOOD_DEFS.salvage.weight;
  return true;
}
