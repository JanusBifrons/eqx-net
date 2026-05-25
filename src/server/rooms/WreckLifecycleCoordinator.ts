/**
 * Wreck-conversion + ownerless-hull-eviction state for SectorRoom.
 *
 * Step 12 of the hazy-pillow decomposition plan (NEW vs R1) —
 * carves out a dedicated owner for the 8-collaborator
 * `convertShipToWreck` transaction. The transaction itself stays inline
 * in SectorRoom for now because it touches PhysicsBridge,
 * PlayerSlotMap, MountAimSubsystem, CombatSubsystem, SnapshotRing,
 * PlayerSessionManager, the Colyseus schema, and bus emits — none of
 * which have stable interfaces yet. What lands here:
 *
 * 1. **`ownerlessShips`** — the 15-minute auto-evict timer set, keyed
 *    by shipInstanceId per the 2026-05-13 Phase 6b cleanup. Tests
 *    reach into this via `_internals.ownerlessShips`.
 * 2. **`wreckConversions`** — diagnostic counter incremented inside
 *    `convertShipToWreck`. Surfaces in periodic load / capacity logs.
 *
 * As CombatSubsystem (Step 8 method bodies, not yet shipped),
 * PhysicsBridge (Step 6 method bodies), and PlayerSessionManager
 * (Step 14, not yet shipped) extract their respective interfaces,
 * `convertShipToWreck` / `destroyWreck` / `evictOwnerlessShip` /
 * `tickAbandonDetection` migrate here as well.
 */

export class WreckLifecycleCoordinator {
  /** 15-min auto-evict timers for hulls whose owners have disconnected
   *  from a galaxy room. Keyed by shipInstanceId (NOT playerId — see
   *  2026-05-13 Phase 6b cleanup in src/server/CLAUDE.md). */
  readonly ownerlessShips = new Map<string, ReturnType<typeof setTimeout>>();

  /** Diagnostic counter — number of ships converted to wrecks across
   *  this room's lifetime. Surfaces in periodic load logs. */
  wreckConversions = 0;
}
