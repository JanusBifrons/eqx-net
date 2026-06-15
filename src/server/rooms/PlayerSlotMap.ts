/**
 * Slot-allocation state for SectorRoom.
 *
 * Step 4 of the hazy-pillow decomposition plan — extracts the
 * slot bookkeeping (player ↔ slot, lingering hull → slot,
 * initial-spawn-position memo) without changing iteration patterns at
 * the call sites: each Map is exposed as a public readonly field so
 * existing `for (const [pid] of this.slots.playerToSlot)` style loops
 * keep working with a one-token rename.
 *
 * Helper methods (`allocSlot`, `freeSlotForPlayer`, `bindLinger`,
 * `releaseLinger`, `assertInvariants`) atomically update
 * the related maps for the common cases. The maps themselves remain
 * mutable so the existing call sites that touch multiple maps in one
 * coordinated transaction (e.g. `onJoin`) can
 * continue inline until those orchestrations extract in later steps.
 */

export class PlayerSlotMap {
  /** Player id → SAB slot. Each active hull owns exactly one slot. */
  readonly playerToSlot = new Map<string, number>();
  /** Reverse of `playerToSlot`. */
  readonly slotToPlayer = new Map<number, string>();
  /** LIFO stack of unallocated slots. */
  readonly freeSlots: number[] = [];
  /** Phase 6b — ship-instance id → slot for lingering hulls (player
   *  disconnected within the 15-min linger window). Keyed by
   *  shipInstanceId, NOT playerId, so fresh-spawn-displace doesn't
   *  orphan the original hull's evict timer. */
  readonly lingeringSlots = new Map<string, number>();
  /** Memo of where a player's hull spawned this session — used by
   *  `handleRespawn` to restore the spawn anchor across deaths. */
  readonly initialSpawnPositions = new Map<string, { x: number; y: number }>();

  constructor(capacity: number) {
    // Push in reverse so slot 0 pops first (matches the legacy fill order).
    for (let i = capacity - 1; i >= 0; i--) this.freeSlots.push(i);
  }

  /** Number of active (player-owned) slots. */
  get size(): number { return this.playerToSlot.size; }

  hasFreeSlot(): boolean { return this.freeSlots.length > 0; }

  /** Allocate the next free slot and bind it to `playerId`.
   *  Returns the slot, or `null` if the pool is empty. */
  allocSlot(playerId: string): number | null {
    const slot = this.freeSlots.pop();
    if (slot === undefined) return null;
    this.playerToSlot.set(playerId, slot);
    this.slotToPlayer.set(slot, playerId);
    return slot;
  }

  /** Release the slot a player owns back to the pool. Returns the slot
   *  that was freed, or `null` if the player owned none. */
  freeSlotForPlayer(playerId: string): number | null {
    const slot = this.playerToSlot.get(playerId);
    if (slot === undefined) return null;
    this.playerToSlot.delete(playerId);
    this.slotToPlayer.delete(slot);
    this.freeSlots.push(slot);
    return slot;
  }

  /** Bind a lingering hull's ship-instance id to a slot. */
  bindLinger(shipInstanceId: string, slot: number): void {
    this.lingeringSlots.set(shipInstanceId, slot);
  }

  /** Release a lingering hull's slot back to the free pool. */
  releaseLinger(shipInstanceId: string): number | null {
    const slot = this.lingeringSlots.get(shipInstanceId);
    if (slot === undefined) return null;
    this.lingeringSlots.delete(shipInstanceId);
    this.freeSlots.push(slot);
    return slot;
  }

  /** Throw if any slot appears in more than one of {player, linger,
   *  free}. Useful as a debug-mode assertion at sensitive lifecycle
   *  boundaries (join, leave, transit). */
  assertInvariants(): void {
    const seen = new Map<number, string>();
    const claim = (slot: number, owner: string): void => {
      const prior = seen.get(slot);
      if (prior !== undefined) {
        throw new Error(`PlayerSlotMap invariant violation: slot ${slot} claimed by both ${prior} and ${owner}`);
      }
      seen.set(slot, owner);
    };
    for (const slot of this.playerToSlot.values()) claim(slot, 'player');
    for (const slot of this.lingeringSlots.values()) claim(slot, 'linger');
    for (const slot of this.freeSlots) claim(slot, 'free');
  }
}
