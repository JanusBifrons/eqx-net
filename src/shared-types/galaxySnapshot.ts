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

/**
 * Recent-combat tally for a sector (Equinox Phase 9 item 5) — the galaxy map's
 * "fighting happened here recently" indicator + the drawer event breakdown. The
 * SERVER windows this (default 5 min) and sends `null`/omits it when quiet, so
 * the client shows the icon purely on `recentCombat` being present.
 */
export interface RecentCombat {
  /** Player + drone (NPC ship) hulls destroyed within the recent window. */
  shipsDestroyed: number;
  /** Structures (incl. bases) destroyed within the recent window. */
  structuresDestroyed: number;
  /** Server epoch ms of the most recent event (best-effort recency; cross-clock,
   *  so don't use for precise client timing — the field's presence already means
   *  "within the window"). */
  lastEventMs: number;
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
  /** Recent-combat tally, or null/absent when the sector has been quiet within
   *  the window. Additive (optional) — pre-Phase-9 producers simply omit it. */
  recentCombat?: RecentCombat | null;
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

export const RecentCombatSchema = z
  .object({
    shipsDestroyed: z.number().int().nonnegative(),
    structuresDestroyed: z.number().int().nonnegative(),
    lastEventMs: z.number().nonnegative(),
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
    // Additive (Equinox Phase 9 item 5) — optional + nullable so pre-Phase-9
    // producers (and the quiet case) validate unchanged.
    recentCombat: RecentCombatSchema.nullable().optional(),
  })
  .strict();

export const GalaxySnapshotResponseSchema = z
  .object({
    sectors: z.array(SectorLiveStateSchema),
  })
  .strict();
