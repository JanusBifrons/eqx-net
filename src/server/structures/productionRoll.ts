/**
 * The processor yield-bonus roll (`ProductionSubsystem.roll`): pure integer
 * hashing, no state. The subsystem caches `idHash` per processor id.
 */

/** FNV-1a hash of a processor id. */
export function idHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h;
}

/** A deterministic roll in [0, 1) for one processor hash and production cycle. */
export function cycleRoll(hash: number, cycle: number): number {
  let x = Math.imul(hash ^ Math.imul(cycle + 1, 0x9e3779b1), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
