import { HITSCAN_RANGE } from '../combat/Weapons.js';

/**
 * Relevance-culled reconciler replay (2026-05-17, Option A — diag
 * `2026-05-16T20-03-36-048Z-a3f5na`).
 *
 * The chapter-2 Phase C lockstep mechanism re-sims every in-interest drone's
 * `HostileDroneBehaviour` on every replayed tick so the client forward-
 * extrapolates the swarm in lockstep with the server. That is inherently
 * O(ticksAhead × N) and was the 116–266 ms sector-change client stall (48 ms
 * at N=500 / ticksAhead=48 ≈ 3× a 16.67 ms frame). The architecture targets
 * ~500 entities/sector, so the fix must SCALE, not throttle, the count.
 *
 * Key insight: the player can only PERCEIVE drone prediction error on drones
 * that are near them, hostile to them, or visibly diverging. Tick-accurately
 * re-sim only those (the NEAR set); freeze the stable far majority at their
 * server-authoritative replay anchor — a frozen body cannot inertia-drift, so
 * the re-sim it would have received is dead work. Replay becomes
 * O(k × ticksAhead), k ≪ N, and lockstep is preserved exactly where it is
 * visible.
 *
 * This is PREDICTION-ONLY. The server always simulates every drone
 * authoritatively, so culling the CLIENT's replay re-sim cannot change
 * authority — it only chooses where to spend client prediction fidelity. The
 * partition is recomputed every snapshot (~20 Hz); a far→near transition (the
 * player flies toward a frozen drone) is therefore picked up within one
 * snapshot, and the `_droneRenderOffsets` render spring masks that single-
 * snapshot catch-up. chapter-2's one-correction-path rule stays intact: the
 * SAME `tickClientAi` / `AiController` path advances NEAR drones, only scoped.
 *
 * Pure / deterministic / no DOM / no I/O — unit-tested in
 * `droneRelevance.test.ts`, scaling-locked in
 * `tests/integration/reconcilerReplayScaling.test.ts`.
 */

/**
 * Replay re-sim relevance horizon. A non-hostile, non-diverging drone within
 * this distance of the player is still re-simmed (the player is close enough
 * to see a snap); beyond it, it holds frozen at the replay anchor. Expressed
 * as a combat-range multiple — `HITSCAN_RANGE` is the catalogue-derived combat
 * unit, so this is not a magic number. This is the PRIMARY tuning knob against
 * the `feel-test-lockstep` `swarmSnapP50` canary: widen it if the canary
 * regresses, narrow it for more scaling headroom.
 */
export const DRONE_RELEVANCE_RADIUS = HITSCAN_RANGE * 2;

/**
 * A drone whose most recent snapshot correction exceeded this (world units)
 * is re-simmed regardless of distance/hostility — it is actively diverging
 * and the player would see the snap even at range. Just above the
 * `LERP_THRESHOLD`-scale noise floor; well below the ~10–15 u pre-fix
 * `swarm_snap_diagnostics` p50 the canary tracks.
 */
export const DRONE_SNAP_RELEVANCE_U = 10;

export interface DroneRelevanceInput {
  /**
   * Stable identifier echoed back in the partition. The caller chooses the
   * convention; the client passes the `AiController` registration id (the
   * numeric entityId as a string) so the NEAR set drops straight into the
   * `AiController.tick` `shouldTick` gate.
   */
  readonly id: string;
  /**
   * Server-authoritative replay-anchor pose (from the snapshot drone slice) —
   * NOT the current predWorld pose, so the distance gate matches what the
   * re-sim AI will read after the reconciler re-seeds the body.
   */
  readonly x: number;
  readonly y: number;
  /** Is this drone currently hostile to the local player? */
  readonly hostile: boolean;
  /** Magnitude (u) of this drone's most recent snapshot correction, if known. */
  readonly lastSnapDist?: number;
}

export interface DroneRelevanceOpts {
  readonly playerX: number;
  readonly playerY: number;
  /** Defaults to {@link DRONE_RELEVANCE_RADIUS}. */
  readonly radius?: number;
  /** Defaults to {@link DRONE_SNAP_RELEVANCE_U}. */
  readonly snapThreshold?: number;
}

export interface DronePartition {
  /** Ids to tick-accurately re-sim during replay (kept UNfrozen). */
  readonly near: ReadonlySet<string>;
  /** Ids to freeze at the replay anchor for the duration of the replay. */
  readonly far: readonly string[];
}

/**
 * Split in-interest drones into the NEAR set (re-sim during reconciler replay)
 * and the FAR list (freeze at the replay anchor). A drone is NEAR iff it is
 * hostile to the player, OR within `radius` of the player, OR its last
 * snapshot correction exceeded `snapThreshold`. Distance uses the squared form
 * (no `sqrt`). Allocates one Set + one array per call — called once per
 * snapshot (~20 Hz), never per physics tick.
 */
export function partitionDronesByRelevance(
  drones: Iterable<DroneRelevanceInput>,
  opts: DroneRelevanceOpts,
): DronePartition {
  const radius = opts.radius ?? DRONE_RELEVANCE_RADIUS;
  const snapThreshold = opts.snapThreshold ?? DRONE_SNAP_RELEVANCE_U;
  const r2 = radius * radius;
  const near = new Set<string>();
  const far: string[] = [];
  for (const d of drones) {
    const dx = d.x - opts.playerX;
    const dy = d.y - opts.playerY;
    const isNear =
      d.hostile ||
      dx * dx + dy * dy < r2 ||
      (d.lastSnapDist !== undefined && d.lastSnapDist > snapThreshold);
    if (isNear) near.add(d.id);
    else far.push(d.id);
  }
  return { near, far };
}
