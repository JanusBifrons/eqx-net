/**
 * Pure miner mining-range-ring radius policy (WS-4 Phase 5 / R2.16).
 *
 * A Miner structure shows a faint dashed ring at its mining-range radius so the
 * player can see the area in which it will extract from asteroids. The radius is
 * a static per-kind catalogue field, read ONCE per miner sprite at create time
 * (never per-frame — invariant #14), mirroring the `aimLineLengthForMount` seam
 * pattern (`render/aimLineLength.ts`).
 *
 * Pure (no Pixi, no I/O) so the radius is unit-lockable independent of the
 * renderer — the failing-first lock is "the ring radius IS the kind's
 * miningRange, never a hardcoded constant."
 */
import { getStructureKind } from '../../shared-types/structureKinds.js';

/** World-unit radius of a structure kind's mining-range ring = the kind's
 *  `miningRange` field. `undefined` for any kind without one (only the Miner
 *  declares it today) — the caller skips the ring for those. */
export function minerRangeForKind(structureKindId: string | undefined): number | undefined {
  return getStructureKind(structureKindId).miningRange;
}
