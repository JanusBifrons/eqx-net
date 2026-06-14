/**
 * Live per-sector galaxy state — the shape returned by `GET /galaxy/snapshot`
 * (Living Galaxy Phase 3) and consumed by the client's galaxy-map poll.
 *
 * Cross-zone contract: pure TS + zod only. The COUNTS are live (aggregated by
 * the `LivingWorldDirector` from every galaxy room on its ~1.5 s control tick).
 * OWNERSHIP is **cosmetic/static in v1** — `owner.factionId` is the sector's
 * static region faction baked in `galaxy.ts`, `contested` is always `false`.
 *
 * FUTURE (the stable seam — do not change the shape, fill it in):
 *   - derive `owner` from the StructureRegistry (the dominant Capital holder);
 *   - set `contested` when >1 base owner holds structures in a sector;
 *   - then named NPC factions; then a conquest flip.
 * See docs/architecture/living-galaxy.md for the expansion ladder.
 */
import { z } from 'zod';

/** Ownership/control of a sector. Cosmetic/static in v1 (see file header). */
export interface SectorOwner {
  /** v1: the static per-region faction id from `galaxy.ts` (a GALAXY_FACTIONS id). */
  factionId: string;
  /** v1: always false. FUTURE: true when multiple base owners coexist. */
  contested: boolean;
}

export interface SectorLiveState {
  /** Stable sector key (matches `GalaxySector.key`). */
  key: string;
  /** Active player hulls in the sector room. */
  players: number;
  /** Hostile drones (kind 1) — drones hostile to a present player (an active
   *  wave). Roaming neutral squads are NOT counted here (they're `neutrals`). */
  enemies: number;
  /** Neutral roaming drones (kind 1, not hostile to any present player). */
  neutrals: number;
  /** Placed structures (StructureRegistry count). */
  structures: number;
  /** Ownership/faction control. v1: the static region faction (never null while
   *  every sector has a region); the seam supports `null` = unclaimed for the
   *  future derived-ownership model. */
  owner: SectorOwner | null;
}

export interface GalaxySnapshotResponse {
  sectors: SectorLiveState[];
}

export const SectorOwnerSchema = z
  .object({
    factionId: z.string(),
    contested: z.boolean(),
  })
  .strict();

export const SectorLiveStateSchema = z
  .object({
    key: z.string(),
    players: z.number().int().nonnegative(),
    enemies: z.number().int().nonnegative(),
    neutrals: z.number().int().nonnegative(),
    structures: z.number().int().nonnegative(),
    owner: SectorOwnerSchema.nullable(),
  })
  .strict();

export const GalaxySnapshotResponseSchema = z
  .object({
    sectors: z.array(SectorLiveStateSchema),
  })
  .strict();
