/**
 * EntitySyncRouter — the single orchestration entry point for every per-tick
 * entity-sync send (Generic Entity Pipeline B4). All outbound entities route
 * through here, ordered by their leaf's `SyncProfile.transport`:
 *
 *   1. `pose-core`  → the binary swarm send (`SwarmBroadcaster`). It builds the
 *      per-(client,tick) interest scratch.
 *   2. `json-slice` → the slim snapshot slices (`SnapshotBroadcaster`:
 *      states / wrecks / projectiles / drones / missiles). It REUSES that
 *      scratch — no second `query9`. **HC#4: pose-core MUST run before
 *      json-slice; the router guarantees that order.**
 *
 * Between the two sends the router evaluates sector-idle — verbatim where the
 * pre-router `update()` did it (`swarm.broadcast()` may apply backpressure before
 * idle reads `clients.length`, so the order is preserved, not reordered).
 *
 * SAFE SHAPE (deliberate + documented, NOT silent — see the GEP B4 handoff):
 * the router owns the routing DECISION + ORDERING + a boot-time transport
 * governance check; the proven broadcasters keep the byte-level ENCODING
 * unchanged. Making the router own per-entity ITERATION would move wire bytes
 * (the tuned 20 Hz json-slice loop + the fixed-stride binary record) for zero
 * functional gain, so we do NOT. `SyncProfile.transport` becomes load-bearing
 * via the construction-time governance check (a kind's declared transport must
 * be well-formed and match the wire), NEVER via a per-tick hot-path branch. If a
 * future change needs the router to own iteration and that moves a wire byte:
 * STOP and keep this shape — the netgate is the verdict.
 *
 * Zone: server. The hot path (`route`) is thin + allocation-free (invariant #14
 * — the wrapper introduces no per-tick allocation; the idle closure is built
 * once at construction and the markPhase hook is passed by reference).
 */
import { entityKinds } from '../../core/entity/EntityKindRegistry.js';
import {
  SWARM_KIND_ASTEROID,
  SWARM_KIND_DRONE,
  SWARM_KIND_STRUCTURE,
} from '../../shared-types/swarmWireFormat.js';
import type { SwarmBroadcaster } from './SwarmBroadcaster.js';
import type { SnapshotBroadcaster } from './SnapshotBroadcaster.js';

export interface EntitySyncRouterDeps {
  swarmBroadcaster: SwarmBroadcaster;
  snapshotBroadcaster: SnapshotBroadcaster;
  /** Pure sector-idle evaluation, invoked BETWEEN the two sends (exactly as the
   *  pre-router `update()` did). Built once at construction — no per-tick closure
   *  allocation. */
  evaluateSectorIdle: () => boolean;
}

export class EntitySyncRouter {
  constructor(private readonly deps: EntitySyncRouterDeps) {
    assertTransportGovernance();
  }

  /**
   * Run the per-tick entity sync. pose-core binary FIRST (builds interestScratch),
   * then json-slice (reuses it) — HC#4 ordering is owned here, not the caller.
   * `markPhase` is the caller's tick-budget hook, invoked at the SAME boundaries
   * as the pre-router code (telemetry-identical).
   */
  route(markPhase: (key: string) => void): void {
    this.deps.swarmBroadcaster.broadcast();
    markPhase('swarmEncode');
    markPhase('swarmBroadcast');
    const sectorIdle = this.deps.evaluateSectorIdle();
    this.deps.snapshotBroadcaster.broadcast(sectorIdle);
    markPhase('snapshotBroadcast');
  }
}

/**
 * Make `SyncProfile.transport` load-bearing (today nothing consumes it). At
 * construction, validate that every registered entity kind's transport is
 * well-formed and that the pose-core kinds match the wire constants — so a
 * registry/wire drift fails loudly at room boot instead of silently mis-routing
 * a send. Boot-time only; NEVER in the per-tick `route()` hot path.
 */
function assertTransportGovernance(): void {
  const wireByteForTag: Record<string, number> = {
    asteroid: SWARM_KIND_ASTEROID,
    drone: SWARM_KIND_DRONE,
    structure: SWARM_KIND_STRUCTURE,
  };
  for (const d of entityKinds()) {
    const t = d.sync.transport;
    if (t === 'pose-core') {
      if (d.sync.poseCoreKind === undefined) {
        throw new Error(`EntitySyncRouter: pose-core kind '${d.tag}' has no poseCoreKind byte`);
      }
      const wire = wireByteForTag[d.tag];
      if (wire !== undefined && wire !== d.sync.poseCoreKind) {
        throw new Error(
          `EntitySyncRouter: '${d.tag}' poseCoreKind ${d.sync.poseCoreKind} ≠ wire constant ${wire} (registry/wire drift)`,
        );
      }
    } else if (t === 'json-slice') {
      if (d.sync.jsonSliceTag === undefined) {
        throw new Error(`EntitySyncRouter: json-slice kind '${d.tag}' has no jsonSliceTag`);
      }
    }
  }
}
