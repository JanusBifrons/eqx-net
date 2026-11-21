/**
 * Why a blueprint's build is paused, for the inspector (owner play-test: a
 * fresh account's Shipyard sat at 92% with no reason when the starting bank
 * ran dry). Mirrors `StructureGridSubsystem.processConstruction` /
 * `findStorageRoute`: a paid build draws from the first funding-capable
 * Capital with minerals that routes to it. Run from the 1 Hz slice rebuild,
 * only for a stalled build.
 */
import type { StructureRecord } from './StructureRegistry.js';

/** Minerals still owed when the build is paused ONLY because every Capital
 *  that routes to it is empty; null when it is not a minerals stall (built,
 *  prepaid, fully paid, still funded, or no Capital routes to it at all). */
export function buildMineralsShortfall(
  rec: StructureRecord,
  all: Iterable<StructureRecord>,
  route: (fromId: string, toId: string) => readonly string[] | null,
): number | null {
  if (rec.isConstructed || rec.isDeconstructing || rec.constructionCost <= 0) return null;
  if (rec.prepaid === true && rec.upgradeTargetLevel === undefined) return null;
  const remaining = rec.constructionCost - rec.constructionProgress;
  if (remaining <= 0) return null;
  let dryRoute = false;
  for (const cap of all) {
    if (cap.kind !== 'capital') continue;
    if (!cap.isConstructed && cap.upgradeTargetLevel === undefined) continue;
    if (!route(cap.id, rec.id)) continue;
    if (cap.minerals > 0) return null; // still funded
    dryRoute = true;
  }
  return dryRoute ? Math.ceil(remaining) : null;
}
