/**
 * Swarm-entity bookkeeping for SectorRoom.
 *
 * Step 5 of the hazy-pillow decomposition plan — extracts the three
 * swarm-side storage fields (registry, interest grid, per-recipient
 * interest scratch) as a single owner. The fields are exposed as
 * public readonly properties because:
 *
 * 1. `SwarmSpawner` is constructed with a reference to `registry` and
 *    holds it for its lifetime.
 * 2. `LoadShedder` is constructed with `registry` for its eviction
 *    candidate enumeration.
 * 3. The per-client interest-window calc reuses `interestScratch` Maps
 *    by identity to avoid per-tick allocation.
 *
 * Methods that span the swarm + other subsystems (`evictSwarmEntity`
 * touches snapshotRing, aiController, drone-mount maps, slots pool;
 * `swarmEntitySnapshot` reads sabF32) stay on SectorRoom for now
 * because their collaborators don't have stable interfaces yet. Those
 * methods migrate here once CombatSubsystem (Step 8), MountAimSubsystem
 * (Step 9), and PhysicsBridge (Step 6) have extracted.
 */

import { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import { SpatialGrid } from '../interest/SpatialGrid.js';

export class SwarmLifecycleManager {
  readonly registry = new SwarmEntityRegistry();
  /** Phase 5d: per-client interest grid. 2048-unit cells, 3×3 query window. */
  readonly grid = new SpatialGrid();
  /** Reused per-tick scratch sets so query9 doesn't allocate per call.
   *  Keyed by session/player id; value is the set of slot indices in
   *  that recipient's interest window. */
  readonly interestScratch = new Map<string, Set<number>>();

  size(): number { return this.registry.size(); }
}
