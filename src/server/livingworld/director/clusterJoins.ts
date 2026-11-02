/**
 * Robot clusters (Living World P3 follow-up): robot squads roaming the same
 * sector MERGE into one bigger cluster. Squad membership stays fixed (the
 * squad pool is shared with the drones); instead a JOINED squad follows its
 * HOST: it takes the host's roam goal (so they hop together) and its bots
 * flock on the host's leader (so they move and fight as one pack).
 *
 * Pure planning, re-run every control tick. Allocates (control cadence).
 */

/** A merged cluster holds at most this many bots (two full robot squads). */
export const CLUSTER_MAX_MEMBERS = 12;

export interface ClusterCandidate {
  squadId: string;
  sectorKey: string;
  /** Idle and untasked — able to stay in a cluster (also while it travels). */
  eligible: boolean;
  /** All its active bots are in `sectorKey` (not mid-hop): needed to START a
   *  cluster, so squads only merge once both have actually arrived. */
  gathered: boolean;
  /** Its active bots in that sector. */
  size: number;
}

/**
 * Decide which squads join which host this tick: joiner squadId → host squadId.
 *
 * - A join from `prev` survives while both squads stay eligible in the same
 *   sector, the host isn't itself a joiner, and the cluster still fits.
 * - Every other eligible squad, in `squads` order, joins the first host in
 *   its sector it fits under; otherwise it becomes a host itself.
 */
export function planClusterJoins(
  squads: readonly ClusterCandidate[],
  prev: ReadonlyMap<string, string>,
): Map<string, string> {
  const byId = new Map<string, ClusterCandidate>();
  for (const s of squads) byId.set(s.squadId, s);
  const joins = new Map<string, string>();
  /** host squadId → cluster size so far. */
  const clusterSize = new Map<string, number>();
  const hostOf = (id: string): string => joins.get(id) ?? id;

  // Hosts first: every eligible squad that isn't a surviving joiner.
  const keep = (joinerId: string, hostId: string): boolean => {
    const j = byId.get(joinerId);
    const h = byId.get(hostId);
    return j !== undefined && h !== undefined && j.eligible && h.eligible
      && j.sectorKey === h.sectorKey && !prev.has(hostId) && j.size > 0 && h.size > 0;
  };
  for (const s of squads) {
    if (!s.eligible || s.size <= 0) continue;
    const prevHost = prev.get(s.squadId);
    if (prevHost !== undefined && keep(s.squadId, prevHost)) continue;
    clusterSize.set(s.squadId, s.size);
  }
  // Surviving joins (if they still fit).
  for (const s of squads) {
    const prevHost = prev.get(s.squadId);
    if (prevHost === undefined || !keep(s.squadId, prevHost)) continue;
    const size = clusterSize.get(prevHost);
    if (size !== undefined && size + s.size <= CLUSTER_MAX_MEMBERS) {
      joins.set(s.squadId, prevHost);
      clusterSize.set(prevHost, size + s.size);
    } else {
      clusterSize.set(s.squadId, s.size); // no longer fits: it hosts alone
    }
  }
  // New joins: a host with no joiners yet may join an EARLIER host in its sector.
  for (const s of squads) {
    if (!clusterSize.has(s.squadId) || joins.has(s.squadId) || !s.gathered) continue;
    let hasJoiners = false;
    for (const h of joins.values()) if (h === s.squadId) { hasJoiners = true; break; }
    if (hasJoiners) continue;
    for (const other of squads) {
      if (other.squadId === s.squadId) break; // only earlier squads can host
      if (other.sectorKey !== s.sectorKey || !other.gathered || hostOf(other.squadId) !== other.squadId) continue;
      const size = clusterSize.get(other.squadId);
      if (size === undefined || size + s.size > CLUSTER_MAX_MEMBERS) continue;
      joins.set(s.squadId, other.squadId);
      clusterSize.set(other.squadId, size + s.size);
      clusterSize.delete(s.squadId);
      break;
    }
  }
  return joins;
}
