/**
 * Session / identity / per-tick input bookkeeping for SectorRoom.
 *
 * Step 14 of the hazy-pillow decomposition plan — relocates the 6
 * session-tracking fields onto a focused owner.
 *
 * The HEAVY method bodies (`onJoin` with its 5+1 branches per Trap 8 of
 * the revised plan, `onLeave`, the input-rate-limit consume) remain in
 * SectorRoom for now. They span PlayerSlotMap (slot alloc),
 * CombatSubsystem (cleanup), MountAimSubsystem (clear-for-player),
 * SnapshotBroadcaster (extendGrace), the bus (SHIP_SPAWNED /
 * SHIP_DESPAWNED), and Colyseus client lifecycle (leave codes,
 * reserveSeatFor). Migrating those requires the collaborators to have
 * stable interfaces, which lands across Steps 8/9/11/12.
 *
 * What's safe to move now: the maps + the small `consumeInputs()`
 * helper (the inputCountThisTick.clear() at the top of every update()).
 */

export class PlayerSessionManager {
  /** Colyseus sessionId → playerId. */
  readonly sessionToPlayer = new Map<string, string>();
  /** Reverse of `sessionToPlayer`. */
  readonly playerToSession = new Map<string, string>();
  /** Per-tick input-rate-limit counter. Cleared at the top of every
   *  `update()` via `consumeInputs()`. Phase 4 contract: max 3 inputs
   *  per entity per tick; excess silently dropped. */
  readonly inputCountThisTick = new Map<string, number>();
  /** playerId → userId (null for anonymous). Owned by the room's auth
   *  surface. */
  readonly playerToUser = new Map<string, string | null>();
  /** playerId → active shipInstanceId — the Phase 6a indirection map.
   *  An active player owns exactly one hull at a time; lingering /
   *  wrecked hulls don't appear in this map. */
  readonly playerToActiveShipInstance = new Map<string, string>();
  /** PlayerIds whose transit has committed in this room (Limbo entry
   *  written, seat reserved on the destination room) — the upcoming
   *  `onLeave` skips its own Limbo put when this is set. */
  readonly playerToTransitInFlight = new Set<string>();

  /** Reset the per-tick input counter at the top of each tick. */
  consumeInputs(): void {
    this.inputCountThisTick.clear();
  }

  /** Resolve a player's currently-active ship instance id. Returns
   *  undefined if the player has no active hull (left, lingering, or
   *  never spawned). */
  resolveActiveShipKey(playerId: string): string | undefined {
    return this.playerToActiveShipInstance.get(playerId);
  }
}
