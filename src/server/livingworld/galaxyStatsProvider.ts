/**
 * Phase-3 — process-global accessor for the LIVE galaxy snapshot, plus the pure
 * response builder the `/galaxy/snapshot` route calls.
 *
 * The `LivingWorldDirector` owns the live per-sector counts (it holds every
 * `galaxy-*` room and aggregates them on its ~1.5 s control tick); the public
 * `galaxyRouter` needs to serve them WITHOUT a hard import of the director or an
 * index.ts cycle. Mirrors the `getIncomingPlayerSink()` singleton-accessor.
 *
 * The provider is null when the Living World is disabled
 * (`EQX_DISABLE_LIVING_WORLD`) or before the director is constructed — every call
 * site null-guards via {@link buildGalaxySnapshot}, which falls back to the
 * static graph with zero counts (never a crash).
 */
import { GALAXY_SECTORS } from '../../core/galaxy/galaxy.js';
import type { GalaxySnapshotResponse, SectorLiveState } from '../../shared-types/galaxySnapshot.js';
import type {
  GalaxyPresenceResponse,
  SectorStructurePresence,
} from '../../shared-types/galaxyPresence.js';

export interface GalaxyStatsProvider {
  /** The cached live per-sector state (one entry per galaxy room the director
   *  holds). O(1) — served from a cache recomputed on the control tick. */
  galaxySnapshot(): SectorLiveState[];
  /** Per-sector count of structures owned by `playerId` (Equinox Phase 7 — the
   *  galaxy-map "my structures" overlay). Computed ON DEMAND (it's per-player,
   *  so it can't share the global snapshot cache) by scanning each live room's
   *  registry — off the 60 Hz tick, called at the ~4 s presence poll. Sectors
   *  where the player owns nothing are omitted. */
  playerStructurePresence(playerId: string): SectorStructurePresence[];
}

let provider: GalaxyStatsProvider | null = null;

export function setGalaxyStatsProvider(p: GalaxyStatsProvider | null): void {
  provider = p;
}

export function getGalaxyStatsProvider(): GalaxyStatsProvider | null {
  return provider;
}

/**
 * Build the `GET /galaxy/snapshot` response. With a live provider, returns its
 * cached per-sector state. Without one (Living World disabled / not yet wired),
 * falls back to the STATIC galaxy graph with zero counts + the static region
 * faction — so the endpoint always answers with the full sector set.
 */
export function buildGalaxySnapshot(p: GalaxyStatsProvider | null): GalaxySnapshotResponse {
  if (p) return { sectors: p.galaxySnapshot() };
  return {
    sectors: GALAXY_SECTORS.map((s) => ({
      key: s.key,
      players: 0,
      enemies: 0,
      neutrals: 0,
      structures: 0,
      owner: { factionId: s.region, contested: false },
    })),
  };
}

/**
 * Build the `GET /galaxy/presence?playerId=` response — the requesting player's
 * owned-structure count per sector. With a live provider, delegates to its
 * on-demand per-player scan; without one (Living World disabled / not yet
 * wired), returns no sectors (the client overlay simply shows nothing). The
 * route still validates/bounds `playerId` before calling this.
 */
export function buildGalaxyPresence(
  p: GalaxyStatsProvider | null,
  playerId: string,
): GalaxyPresenceResponse {
  if (p) return { sectors: p.playerStructurePresence(playerId) };
  return { sectors: [] };
}
