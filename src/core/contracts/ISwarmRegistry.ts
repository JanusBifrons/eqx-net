/**
 * Server-side swarm-entity registry surface. Owns drone create/destroy,
 * the wire-format `u8` kind-index mapping, and the entity iteration
 * order used by both `LagCompRing.recordEntity` and
 * `BroadcastScheduler` per-tick.
 *
 * Today (pre-refactor) this state lives inline in `SectorRoom.ts` as
 * the `swarmRegistry` field + ad-hoc spawn/despawn paths. Commit 20 of
 * the god-file refactor extracts it into `SwarmRegistry.ts`.
 *
 * The `resolveKindIndex` accessor returns the canonical `u8` index used
 * by the binary swarm wire (v3). Adding a new drone kind is append-only
 * per root invariant #11 — never reorder; bump `SWARM_WIRE_VERSION` if
 * you must.
 */

export interface DroneEntry {
  readonly id: string;
  readonly kindId: string;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly angvel: number;
}

export interface ISwarmRegistry {
  /** Spawn a new drone of the given kind; returns the assigned id. */
  create(kindId: string, ownerId: string | null): string;
  /** Despawn by id; idempotent. */
  destroy(id: string): void;
  /** Resolve to the wire-format `u8` kind index (0-based into SHIP_KINDS_LIST). */
  resolveKindIndex(id: string): number;
  /** Iterate live drones in canonical (insertion) order. */
  entries(): Iterable<DroneEntry>;
  /** Number of live drones. */
  size(): number;
}
