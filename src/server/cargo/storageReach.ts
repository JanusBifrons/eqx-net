/**
 * Storage reach rules (moved out of StorageService.ts): how close a ship must
 * be to storage to hover-deposit, and to install, repair or open cargo.
 */
import { DOCK_DEPOSIT_RANGE, craneBayFor, onStructureCraneBay } from '../../core/articulation/rigCatalogue.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';

/** Hold within this distance of your own hover drop-off to deposit. */
export const DEPOSIT_RANGE = 400;
/** Reach around storage of `kindId` (hover deposit; with the crane bay,
 *  `nearStorage` for module install, cargo access, repair): a freight dock's
 *  covers its whole landing pad
 *  (`DOCK_DEPOSIT_RANGE`, rigCatalogue.ts); other storage uses `DEPOSIT_RANGE`. */
export function depositRangeOf(kindId: string): number {
  return kindId === 'freight_dock' ? Math.max(DEPOSIT_RANGE, DOCK_DEPOSIT_RANGE) : DEPOSIT_RANGE;
}
/** Is world point (x, y) "at" structure `rec` for install, repair and
 *  cargo reach? Within its `depositRangeOf` circle, or on its own crane bay
 *  (`onStructureCraneBay`: a Capital's bay lies past 400 u). Not the deposit
 *  rule: hover deposit stays `takesHoverDeposit` + `depositRangeOf`. Alloc-free. */
export function nearStorage(rec: Pick<StructureRecord, 'kind' | 'x' | 'y' | 'rot' | 'mirror'>, x: number, y: number): boolean {
  const r = depositRangeOf(rec.kind);
  if ((rec.x - x) ** 2 + (rec.y - y) ** 2 <= r * r) return true;
  return onStructureCraneBay(rec.kind, rec.x, rec.y, rec.rot ?? 0, x, y, rec.mirror);
}
/** Does storage of `kindId` take the hover deposit (hold within
 *  `depositRangeOf` for `DEPOSIT_DWELL_TICKS`)? A kind with a crane bay
 *  (`craneBayFor`: freight dock, Capital) unloads only a ship parked on its
 *  bay; other storage (Cargo Bay, Storage Vault) takes the hover deposit. */
export function takesHoverDeposit(kindId: string): boolean {
  return craneBayFor(kindId) === null;
}
/** Hold position this long (60 Hz ticks) to deposit — 2 s. */
export const DEPOSIT_DWELL_TICKS = 120;
