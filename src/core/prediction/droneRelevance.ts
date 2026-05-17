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

/**
 * Hard per-snapshot re-sim BUDGET (k-cap), diag m6rq2t 2026-05-17.
 * Option A's radius cull gives zero relief in a melee: inside the bot pack
 * NEAR≈ALL, so per-snapshot reconcile is O(replayWindow × N) and, as the
 * client's snapshot-handle interval slows, the window grows → work grows →
 * handling slows → the progressive combat-lag spiral. Capping the count of
 * tick-accurately re-simmed drones to the K MOST-RELEVANT (hostile, then
 * closest) makes it O(replayWindow × K), K bounded regardless of pack size
 * → no spiral, scales to the 500-objects/sector target. The demoted
 * overflow dead-reckons (Option A established that's visually fine for
 * non-engaged drones; the `_droneRenderOffsets` spring masks the residual).
 * Sibling tuning knob to {@link DRONE_RELEVANCE_RADIUS}; validated against
 * the feel-test-lockstep canary + on-device smoke. 12 keeps the handful you
 * are actually dogfighting tick-accurate while bounding cost.
 */
export const DRONE_RESIM_BUDGET = 12;

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
  /**
   * Hard cap on the NEAR set — at most this many drones are tick-accurately
   * re-simmed per snapshot (the K most-relevant: hostile, then closest);
   * the overflow is demoted to FAR (dead-reckon). Defaults to
   * {@link DRONE_RESIM_BUDGET}. Pass `Infinity` to disable (Option-A
   * radius-only behaviour — used by the byte-identical regression lock).
   */
  readonly maxResim?: number;
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
  const maxResim = opts.maxResim ?? DRONE_RESIM_BUDGET;
  const r2 = radius * radius;
  const far: string[] = [];
  // Near-eligible candidates carry the ranking key so the budget cap can
  // keep the K most-relevant. d2 = squared distance to the player.
  const nearCand: { id: string; hostile: boolean; d2: number }[] = [];
  for (const d of drones) {
    const dx = d.x - opts.playerX;
    const dy = d.y - opts.playerY;
    const d2 = dx * dx + dy * dy;
    const isNear =
      d.hostile ||
      d2 < r2 ||
      (d.lastSnapDist !== undefined && d.lastSnapDist > snapThreshold);
    if (isNear) nearCand.push({ id: d.id, hostile: d.hostile, d2 });
    else far.push(d.id);
  }
  if (nearCand.length <= maxResim) {
    // Under budget ⇒ byte-identical to the pre-cap one-pass behaviour
    // (NEAR in iteration order, FAR in iteration order). Steady-state +
    // chapter-2 lockstep + feel-test-lockstep canary untouched.
    const near = new Set<string>();
    for (const c of nearCand) near.add(c.id);
    return { near, far };
  }
  // Over budget (in-pack melee): keep the K most-relevant tick-accurate,
  // demote the overflow to FAR (dead-reckon). Total deterministic order —
  // hostile first, then closest, then id — so it is input-order-independent
  // and stable frame-to-frame (no re-sim-set flicker).
  nearCand.sort((a, b) =>
    a.hostile !== b.hostile
      ? (a.hostile ? -1 : 1)
      : a.d2 !== b.d2
        ? a.d2 - b.d2
        : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const near = new Set<string>();
  for (let i = 0; i < nearCand.length; i++) {
    if (i < maxResim) near.add(nearCand[i]!.id);
    else far.push(nearCand[i]!.id);
  }
  return { near, far };
}
