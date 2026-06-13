/**
 * Generic Entity base — the identity + routing surface every world object
 * shares (Generic Entity Pipeline, Phase 1).
 *
 * EQX Peri grows horizontally: structures, capital ships, debris, black
 * holes, mines, pickups. Today each new type re-implements the SAME four
 * concerns (send / construct / render / damage) from scratch across four
 * dispatch sites keyed on the shape of a target-id string. This base lets a
 * new type be "a leaf + a small descriptor": the shared registration+routing
 * seam supplies networking, client-construction, rendering, and damage, so
 * the only bespoke code is the leaf's gameplay logic.
 *
 * Zone-pure (src/core, invariant #1): this declares ABSTRACTIONS only. The
 * concretions (Colyseus-schema binding, SAB slot, render-mirror entry) are
 * implemented by src/server / src/client adapters via DI, exactly as
 * `IRenderer` / `ISwarmRegistry` are.
 *
 * ⚠️ SEPARATE from `AiEntity` (`src/core/contracts/IAiBehaviour.ts`), which is
 * a read-only AI pose snapshot handed to a behaviour each tick. `Entity` is
 * the identity/routing surface for the dispatch+sync collapse and must not be
 * conflated with it (HC#7).
 */

/**
 * The closed, APPEND-ONLY set of entity kinds. The order/value of existing
 * tags is never changed (mirrors the ship-kind catalogue discipline,
 * invariant #11). Phase 4 appends `'structure'`.
 *
 * `active-ship` and `lingering-hull` are distinct tags even though both wrap
 * a `ShipState`: they differ by the `isActive` flag and by which death
 * side-effects fire (the load-bearing DamageRouter branch split, HC#1).
 */
export type EntityKindTag =
  | 'active-ship'
  | 'lingering-hull'
  | 'wreck'
  | 'drone'
  | 'asteroid'
  | 'projectile'
  | 'missile'
  | 'structure' // P4 — a static, damageable world object (pose-core kind 2)
  | 'scrap'; // scrap-on-death Phase 2a — a salvage piece shed on death (pose-core kind 3)

/**
 * Scratch-filled pose. Callers own the object and reuse it across entities
 * and frames — `pose()` mutates it in place and returns it, never allocating
 * (invariant #14, no new hot-loop allocation).
 */
export interface PoseOut {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
}

/** Allocate a single reusable PoseOut scratch (call once, outside hot loops). */
export function createPoseOut(): PoseOut {
  return { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
}

/**
 * The base every world object implements. Intentionally tiny — capability is
 * layered on via the narrow contracts (`IDamageable`, `INetworkSynced`,
 * `IRenderContributor`), per interface-segregation. A leaf opts into a
 * capability by also implementing that contract; nothing forces all four.
 */
export interface Entity {
  /** Which leaf kind this is — the routing key. */
  readonly entityKind: EntityKindTag;
  /**
   * Stable per-entity id in the SAME namespace the existing code already
   * uses for this kind (active ship = playerId; lingering hull / wreck =
   * shipInstanceId; drone/asteroid = `swarm-<entityId>` wire id; projectile
   * = `p-<n>`; missile = its numeric id as a string). Adapters MUST NOT
   * invent a new id scheme — downstream broadcast/sprite keying depends on
   * the existing one.
   */
  readonly entityId: string;
  /** Fill `out` with the entity's current pose and return it. No allocation. */
  pose(out: PoseOut): PoseOut;
}
