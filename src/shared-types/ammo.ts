/**
 * Ammunition (plan soft-leaping-truffle v3, P2d; user ruling 2026-11-01).
 * Anything that fires a PHYSICAL object spends munitions; lasers only spend
 * power. One unit of munitions (a light good, weight 0.1) loads a structure's
 * magazine with this many shots. Shared by server (firing) and client (the
 * inspector's "no munitions" line), invariant #15.
 */
import type { StructureKindId } from './structureKinds.js';

export const AMMO_SHOTS_PER_UNIT: Readonly<Partial<Record<StructureKindId, number>>> = Object.freeze({
  missile_turret: 8,
  autocannon_turret: 40,
  // Mines laid per munition (a mine is a whole charge, not a burst).
  mine_layer: 2,
});

/** Does this structure kind spend munitions to fire? */
export function usesAmmo(kind: string): boolean {
  return (AMMO_SHOTS_PER_UNIT as Record<string, number | undefined>)[kind] !== undefined;
}
