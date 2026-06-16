/**
 * Per-player galaxy presence — the shape returned by `GET /galaxy/presence?playerId=`
 * (Equinox Phase 7) and the merged shape the client pushes to the galaxy map.
 *
 * The global `/galaxy/snapshot` (galaxySnapshot.ts) carries per-sector TOTALS
 * (players / enemies / neutrals / structures, all owners). It cannot answer "how
 * many of MY structures are in sector X" because it isn't per-player and the
 * client only ever sees the structures[] slice for its CURRENT room. This
 * endpoint fills that gap: the requesting player's owned-structure count per
 * sector, aggregated across every live galaxy room by the LivingWorldDirector.
 *
 * Ship locations come from the client's own roster (RosterEntry.sectorKey), so
 * they need no server round-trip — they're merged in client-side into the
 * layer-facing {@link SectorPresence}.
 *
 * Cross-zone contract: pure TS + zod only.
 */
import { z } from 'zod';

/** One sector's count of structures owned by the requesting player. */
export interface SectorStructurePresence {
  key: string;
  structures: number;
}

export interface GalaxyPresenceResponse {
  sectors: SectorStructurePresence[];
}

export const SectorStructurePresenceSchema = z
  .object({
    key: z.string(),
    structures: z.number().int().nonnegative(),
  })
  .strict();

export const GalaxyPresenceResponseSchema = z
  .object({
    sectors: z.array(SectorStructurePresenceSchema),
  })
  .strict();

/**
 * Layer-facing MERGED per-sector presence the client pushes to the galaxy map:
 * the logged-in player's own ships (from the roster) + owned structures (from
 * `GET /galaxy/presence`) in that sector. Plain data — it crosses the renderer
 * worker boundary (structured-clone), so no methods / handles.
 */
export interface SectorPresence {
  key: string;
  ships: number;
  structures: number;
}
