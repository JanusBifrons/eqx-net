/**
 * The own ACTIVE ship's economy numbers on its snapshot entry (#16: the
 * client reads them only from here). Economy v2 W1 — wallet balance; join
 * flow — free capital launches left. Plain numbers, no allocation (#14).
 * Extension point of `SnapshotBroadcaster`.
 */

export interface OwnEconomyEntry {
  wallet?: number;
  freeLaunches?: number;
}

export interface OwnEconomyDeps {
  walletOf?: (playerId: string) => number;
  freeLaunchesOf?: (playerId: string) => number;
}

/** Set both fields for the owner's active hull; drop them otherwise. */
export function setOwnEconomy(entry: OwnEconomyEntry, deps: OwnEconomyDeps, playerId: string, ownActive: boolean): void {
  const wallet = ownActive ? deps.walletOf?.(playerId) : undefined;
  if (wallet !== undefined) entry.wallet = wallet;
  else if ('wallet' in entry) delete entry.wallet;
  const free = ownActive ? deps.freeLaunchesOf?.(playerId) : undefined;
  if (free !== undefined) entry.freeLaunches = free;
  else if ('freeLaunches' in entry) delete entry.freeLaunches;
}
