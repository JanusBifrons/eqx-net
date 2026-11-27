/**
 * Sealed sectors (docs/features/sandbox.md): rooms whose ships, holds and
 * credits never reach the real game. One predicate, shared by the roster
 * (reuse-recent, Hangar list, boot purge), exits (warp, teleport) and payouts.
 */

/** The sandbox room's sector key (`?room=sandbox`). */
export const SANDBOX_SECTOR_KEY = 'sandbox';

const SEALED: ReadonlySet<string> = new Set([SANDBOX_SECTOR_KEY]);

/** Is `sectorKey` a sealed sector? Null / undefined (no sector) = not sealed. */
export function isSealedSectorKey(sectorKey: string | null | undefined): boolean {
  return sectorKey != null && SEALED.has(sectorKey);
}
