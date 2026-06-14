/**
 * ScrapSpawner — scrap-on-death Phase 2b-ii.
 *
 * Turns a dying COMPOSITE ship (player or drone) into a cluster of free-floating
 * scrap pieces — one per `shipScrapGroups(kind)` component. Hand-rolled-mock
 * testable like `TransitOrchestrator`: it owns the death→scrap DECISION logic
 * over a narrow set of injected hooks (`spawnScrap` / `seedHealth` / `evictScrap`),
 * so a unit test can drive it with plain function mocks (no SAB, no worker, no
 * registry).
 *
 * Responsibilities:
 *   1. Resolve the parent kind's precomputed scrap groups (pure geometry, no
 *      runtime cost — `shipScrapGroups`). A polygon kind has none ⇒ no scrap.
 *   2. For each component, transform its CATALOGUE-LOCAL (Pixi-up, pre-scale)
 *      centroid + collider into WORLD math-up coords at the dying ship's pose,
 *      using the SAME `x*scale, -y*scale` mapping `shipShapeToPolygon` uses (so
 *      the scrap collider lands exactly where the rendered silhouette was).
 *   3. Give each piece a gentle radial drift outward from the ship centre
 *      (`SCRAP_BURST_SPEED`) on top of the ship's own velocity, plus the ship's
 *      angle so the recentred collider is oriented correctly.
 *   4. Seed each piece's health (`SCRAP_HP`) so it's damageable, and enforce a
 *      GLOBAL FIFO cap (`MAX_LIVE_SCRAP`) — the oldest scrap is evicted when a
 *      mass-casualty event would otherwise flood the registry. Scrap is
 *      PERMANENT otherwise (no TTL).
 *
 * Death is a DISCRETE event (not a per-tick hot loop), so a small per-death
 * array is acceptable here; the `live` FIFO list is reused across deaths and the
 * `notifyRemoved` accounting keeps the cap honest when scrap dies to combat.
 */

import { shipScrapGroups } from '../../core/geometry/shipScrapGroups.js';
import { shipShapeScale } from '../../core/geometry/shipHullOutline.js';
import { scrapColliderFor } from '../../core/geometry/scrapCollider.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { SCRAP_BURST_SPEED, SCRAP_HP, MAX_LIVE_SCRAP } from '../../core/swarm/scrapConstants.js';
import type { Vec2 } from '../../core/swarm/asteroidShape.js';

/** Spec accepted by the injected `spawnScrap` hook — the exact subset of
 *  `SwarmSpawner.spawnScrap`'s parameter that the ScrapSpawner fills. */
export interface ScrapSpawnSpec {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** World math-up spawn angle (the dying ship's angle). */
  angle: number;
  radius: number;
  parentShipKind: ShipKindId;
  componentIndex: number;
  vertices: ReadonlyArray<Vec2>;
}

/** The dying ship's pose, world math-up. */
export interface DeathPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

export interface ScrapSpawnerDeps {
  /** Spawn one scrap body. Returns true on success (false = no free slot).
   *  Bound to `SwarmSpawner.spawnScrap` in production. */
  spawnScrap: (spec: ScrapSpawnSpec) => boolean;
  /** Seed a scrap piece's health so it's damageable through the swarm path. */
  seedHealth: (id: string, hp: number) => void;
  /** FIFO eviction — quiet despawn of an over-cap scrap entity (broadcast true,
   *  emitDestroyed false: no kill-feed / explosion on a budget cleanup). */
  evictScrap: (id: string) => void;
  /** Injectable RNG (default Math.random) — kept for future jitter; deterministic
   *  in tests. */
  rng?: () => number;
}

export class ScrapSpawner {
  private readonly spawnScrap: (spec: ScrapSpawnSpec) => boolean;
  private readonly seedHealth: (id: string, hp: number) => void;
  private readonly evictScrap: (id: string) => void;
  // RNG retained for future per-piece jitter; not load-bearing yet.
  private readonly rng: () => number;

  /** FIFO of currently-live scrap ids (oldest first). Reused across deaths;
   *  bounded at `MAX_LIVE_SCRAP` via shift-and-evict. */
  private readonly live: string[] = [];

  constructor(deps: ScrapSpawnerDeps) {
    this.spawnScrap = deps.spawnScrap;
    this.seedHealth = deps.seedHealth;
    this.evictScrap = deps.evictScrap;
    this.rng = deps.rng ?? Math.random;
  }

  /**
   * Break a dying composite ship into scrap. No-op for a polygon kind (no
   * salvageable components). One scrap body per component, each seeded with
   * `SCRAP_HP`; the global FIFO cap is enforced after each push.
   */
  spawnFromDeath(
    parentKindId: ShipKindId,
    pose: DeathPose,
    idPrefix: string,
  ): void {
    const groups = shipScrapGroups(parentKindId);
    if (groups.length === 0) return; // polygon kinds never scrap

    const scale = shipShapeScale(getShipKind(parentKindId));
    const cos = Math.cos(pose.angle);
    const sin = Math.sin(pose.angle);

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      // COORDINATE TRANSFORM — must match `shipShapeToPolygon`, which maps a
      // catalogue Pixi-up point -> world math-up via (x*scale, -y*scale):
      //   1. component centroid in ship-LOCAL math-up
      const lx = g.centroid[0] * scale;
      const ly = -g.centroid[1] * scale;
      //   2. rotate by the ship's angle + translate to the ship's world pos
      const worldX = pose.x + lx * cos - ly * sin;
      const worldY = pose.y + lx * sin + ly * cos;

      //   3. scrap-LOCAL math-up collider (recentred group collider, scaled +
      //      Y-flipped to math-up). Shared with the persistence hydrate path via
      //      `scrapColliderFor` so a restored scrap collider is byte-identical.
      const geom = scrapColliderFor(parentKindId, i)!; // non-null: i < groups.length
      const vertices = geom.vertices;
      const radius = geom.radius;

      // Radial drift OUTWARD from the ship centre through this component, on top
      // of the ship's own velocity. A component sitting exactly on the centre
      // (len≈0) gets no burst (can't pick a direction).
      const dx = worldX - pose.x;
      const dy = worldY - pose.y;
      const len = Math.hypot(dx, dy);
      const bx = len > 1e-3 ? (dx / len) * SCRAP_BURST_SPEED : 0;
      const by = len > 1e-3 ? (dy / len) * SCRAP_BURST_SPEED : 0;
      const vx = pose.vx + bx;
      const vy = pose.vy + by;

      const id = `${idPrefix}-${i}`;
      const ok = this.spawnScrap({
        id,
        x: worldX,
        y: worldY,
        vx,
        vy,
        angle: pose.angle,
        radius,
        parentShipKind: parentKindId,
        componentIndex: i,
        vertices,
      });
      if (!ok) continue; // slot pool exhausted — skip, no health/FIFO entry
      this.seedHealth(id, SCRAP_HP);
      this.live.push(id);
      this.enforceCap();
    }
  }

  /**
   * Tell the spawner a scrap entity left the world by some path OTHER than the
   * FIFO cap (combat death routed through the swarm death path). Keeps the cap
   * accounting correct so a later death doesn't over-count live scrap.
   */
  notifyRemoved(id: string): void {
    const idx = this.live.indexOf(id);
    if (idx !== -1) this.live.splice(idx, 1);
  }

  /** Number of scrap pieces the spawner currently tracks as live (test seam). */
  liveCount(): number {
    return this.live.length;
  }

  /** Evict oldest scrap while over the global cap. */
  private enforceCap(): void {
    while (this.live.length > MAX_LIVE_SCRAP) {
      const oldest = this.live.shift();
      if (oldest !== undefined) this.evictScrap(oldest);
    }
  }
}
