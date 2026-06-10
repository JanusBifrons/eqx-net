/**
 * Payload-DoS bound for the testMode seed arrays (plan squishy-canyon, S5).
 *
 * `dronePoses` / `structurePoses` / `prebuiltStructures` / `scenarioDrones` /
 * `scenarioAsteroids` / `droneKinds` ride `SectorRoom.onCreate(options)`, which
 * is client-suppliable when a client CREATES a room (Colyseus passes
 * joinOrCreate options to onCreate). They were previously cast with zero
 * validation, so a single create call could ask the sector to seed an unbounded
 * number of entities. We reject oversized arrays at creation — failing room
 * creation is the correct DoS outcome.
 *
 * NOTE: the plan placed this in `JoinOptionsSchema`, but these fields are
 * onCreate options, not join options — they never ride the join `.passthrough()`.
 * Bounding them here is the faithful-to-intent implementation. The
 * production-client-controllable string fields (clientShotId, slotId,
 * targetSectorKey, …) are bounded directly in their zod schemas.
 */

/** Max entries any single seed array may carry. Real scenario rooms use ≤ a
 *  handful; 64 is generous headroom while still bounding the payload. */
export const MAX_SEED_ENTRIES = 64;

/** The onCreate option fields this guard bounds. */
const SEED_ARRAY_FIELDS = [
  'dronePoses',
  'structurePoses',
  'prebuiltStructures',
  'scenarioDrones',
  'scenarioAsteroids',
  'droneKinds',
] as const;

/**
 * Throw if any seed array exceeds `MAX_SEED_ENTRIES`. Runs once per room at
 * onCreate (not a hot path), so the small field-name iteration is fine.
 */
export function assertRoomSeedBounds(opts: Record<string, unknown>): void {
  for (const field of SEED_ARRAY_FIELDS) {
    const value = opts[field];
    if (Array.isArray(value) && value.length > MAX_SEED_ENTRIES) {
      throw new Error(
        `onCreate option "${field}" has ${value.length} entries (max ${MAX_SEED_ENTRIES}) — payload-DoS guard (S5)`,
      );
    }
  }
}
