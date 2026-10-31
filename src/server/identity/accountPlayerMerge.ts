/**
 * PR 3a — one-off (idempotent) boot pass that folds every account's historical
 * per-browser playerIds into ONE canonical playerId.
 *
 * Source of truth for "which ids belonged to which account": the roster rows'
 * `user_id` (stamped on every ship created while logged in, but never read
 * before this PR). For each account:
 *   - canonical = the account's existing binding, else the playerId that owns
 *     the most recently updated ship (the browser the player used last);
 *   - every OTHER playerId with that account's ships becomes an alias, and its
 *     ships are re-keyed onto the canonical id.
 *
 * Structures / lingering hulls / director wave targets persisted under an old
 * id are NOT rewritten here (they live inside JSON snapshot blobs); they are
 * mapped through `AccountPlayerRegistry.resolve` when they are loaded back
 * into the world, and re-saved under the canonical id on the next persist.
 *
 * Running it twice is a no-op: after the first pass every account's ships sit
 * under its canonical id, so there is nothing left to alias or move.
 */
import type { PlayerShipStore } from '../playerShips/PlayerShipStore.js';
import type { AccountPlayerRegistry } from './AccountPlayerRegistry.js';

export interface AccountMergeResult {
  /** Accounts that were newly bound to a canonical playerId. */
  bound: number;
  /** Historical playerIds recorded as aliases. */
  aliased: number;
  /** Roster rows moved onto a canonical playerId. */
  shipsMoved: number;
}

export function mergeAccountPlayerIds(
  registry: AccountPlayerRegistry,
  ships: PlayerShipStore,
): AccountMergeResult {
  // userId → (playerId → newest updatedAt among that player's ships)
  const byUser = new Map<string, Map<string, number>>();
  for (const rec of ships.all()) {
    if (rec.userId === null || rec.userId === '') continue;
    // Test-fixture accounts keep per-browser identities (see
    // AccountPlayerRegistry.exemptUsers) — never fold them.
    if (registry.isExempt(rec.userId)) continue;
    let players = byUser.get(rec.userId);
    if (players === undefined) {
      players = new Map<string, number>();
      byUser.set(rec.userId, players);
    }
    const prev = players.get(rec.playerId) ?? -Infinity;
    if (rec.updatedAt > prev) players.set(rec.playerId, rec.updatedAt);
  }

  const result: AccountMergeResult = { bound: 0, aliased: 0, shipsMoved: 0 };
  for (const [userId, players] of byUser) {
    let canonical = registry.canonicalForUser(userId);
    if (canonical === null) {
      let newest = -Infinity;
      for (const [pid, updatedAt] of players) {
        // A playerId already owned by ANOTHER account can't become this
        // account's canonical id (defensive — two accounts shared a browser).
        const owner = registry.userForPlayer(pid);
        if (owner !== null && owner !== userId) continue;
        if (updatedAt > newest) { newest = updatedAt; canonical = pid; }
      }
      if (canonical === null) continue;
      registry.bind(userId, canonical);
      result.bound += 1;
    }
    for (const pid of players.keys()) {
      if (pid === canonical) continue;
      const owner = registry.userForPlayer(pid);
      if (owner !== null && owner !== userId) continue;
      registry.addAlias(pid, canonical, userId);
      result.aliased += 1;
      result.shipsMoved += ships.reassignPlayer(pid, canonical, userId);
    }
  }
  return result;
}
