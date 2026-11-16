/** Wreck lineage (rock cut / laser spread): every wreck carries the id of the
 *  root wreck it descends from (`LiveWreck.root`). These walk the
 *  CapitalWreckSubsystem's maps; split out of it for its size cap. */
import type { LiveWreck } from './capitalWreckTypes.js';

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
