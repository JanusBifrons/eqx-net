/**
 * Process-global presence registry: which `playerId`s currently have a live
 * connection to ANY room. Used by the Web Push trigger to gate notifications —
 * we only alert an OFFLINE owner that their base is under attack (someone
 * actively connected can already see it).
 *
 * Refcounted (not a plain Set) so two simultaneous sessions for the same player
 * (e.g. two browser tabs) don't unregister each other, and so the brief
 * leave-then-join of an inter-sector transit can't flip a still-connected
 * player to "offline" mid-handoff. `SectorRoom.onJoin` increments;
 * `SectorRoom.onLeave` decrements.
 */
const counts = new Map<string, number>();

export function registerConnectedPlayer(playerId: string): void {
  counts.set(playerId, (counts.get(playerId) ?? 0) + 1);
}

export function unregisterConnectedPlayer(playerId: string): void {
  const n = counts.get(playerId);
  if (n === undefined) return;
  if (n <= 1) counts.delete(playerId);
  else counts.set(playerId, n - 1);
}

export function isPlayerOnline(playerId: string): boolean {
  return counts.has(playerId);
}

/** Test-only: clear the registry between cases. */
export function _resetConnectedPlayers(): void {
  counts.clear();
}
