import type { SectorLiveState } from '../../../shared-types/galaxySnapshot.js';

/**
 * Sector OWNERSHIP seam (Equinox Phase 9, item 1) — the single extension point
 * the galaxy-map territory system reads to decide "who controls this sector".
 *
 * A {@link import('./galaxyTerritories').Territory} is a maximal run of
 * CONTIGUOUS same-OWNER sectors — the unit that breathes/shrinks together on
 * hover and gets one perimeter outline. Grouping by owner (not the baked
 * `GalaxySector.region`) is what makes the map DYNAMIC: as ownership changes the
 * territories re-form with no change to `computeTerritories` or `GalaxyMapLayer`.
 *
 * **v1 — everything is NEUTRAL.** There are no sector-capture or NPC-faction
 * mechanics yet, so every sector resolves to {@link NEUTRAL_OWNER}; the whole
 * connected galaxy reads as ONE dynamic neutral territory.
 *
 * **FUTURE (signposted, do NOT special-case elsewhere):**
 *   - NPC factions → return the controlling faction id.
 *   - Player capture → return the dominant base owner's id. The server already
 *     documents this seam (derive `SectorLiveState.owner` from the dominant
 *     Capital holder — see src/shared-types/galaxySnapshot.ts); pass the live
 *     `/galaxy/snapshot` state in via `liveStateByKey` and return
 *     `st.owner.factionId`. The `liveStateByKey` arg is threaded ahead of that
 *     so lighting up real territories touches ONLY this function + the per-owner
 *     colour map, never the grouping/render code.
 */
export type OwnerId = string;

/** The owner every sector resolves to today (no capture/faction mechanics yet). */
export const NEUTRAL_OWNER: OwnerId = 'neutral';

/**
 * Resolve a sector's current owner from the LIVE `/galaxy/snapshot` state
 * (campaign 4.4 — the body the seam was signposted for). A sector with a live
 * `owner` resolves to its `factionId`; a null owner / missing sector / absent
 * live map resolves to {@link NEUTRAL_OWNER} (the pre-4.4 behaviour, and the
 * pre-first-poll state of the map).
 *
 * v1 producers stamp `owner` with the sector's static region faction, so the
 * map now groups into the region territories; when the server derives owner
 * from the dominant Capital holder, real player territories light up through
 * this same line with no further client change.
 */
export function resolveSectorOwner(
  sectorKey: string,
  liveStateByKey?: ReadonlyMap<string, SectorLiveState> | null,
): OwnerId {
  const owner = liveStateByKey?.get(sectorKey)?.owner;
  return owner ? owner.factionId : NEUTRAL_OWNER;
}
