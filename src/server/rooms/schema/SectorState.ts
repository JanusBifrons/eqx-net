import { Schema, MapSchema, type } from '@colyseus/schema';
import { SHIP_MAX_HEALTH } from '../../../core/combat/Weapons.js';
import { DEFAULT_SHIP_KIND } from '../../../shared-types/shipKinds.js';

// Wire-traffic invariant (network-discipline P1, see plan):
// Spatial fields (x/y/vx/vy/angle/angvel) MUST NOT live on this schema.
// Pose flows on exactly one channel — the (binary) snapshot — sourced from
// `SectorRoom.shipPoseCache` (mirrored from SAB once per update). Re-adding
// `@type('number') x` here re-introduces the duplicate broadcast that this
// refactor deleted.
export class ShipState extends Schema {
  @type('string') playerId: string = '';
  @type('float32') health: number = SHIP_MAX_HEALTH;
  @type('float32') maxHealth: number = SHIP_MAX_HEALTH;
  @type('boolean') alive: boolean = true;
  /** Ship kind id from `SHIP_KINDS` (e.g. 'scout' | 'fighter' | 'heavy').
   *  Set on join from the client's `JoinOptions.shipKind`, validated server-side
   *  via `isShipKindId`. Drives per-kind physics in the worker and per-kind
   *  silhouette + colour on the client renderer. Defaults to the catalogue
   *  default so legacy snapshots that pre-date this field remain valid. */
  @type('string') kind: string = DEFAULT_SHIP_KIND;
  /** Player display name shown above remote ships in the renderer. Populated
   *  in `SectorRoom.onJoin` from the auth profile (`displayName ?? email`).
   *  Empty string when anonymous; client falls back to a `Pilot ${id}` label.
   *  Discrete UI string — broadcast through Colyseus MapSchema diff and read
   *  by the client's `LabelManager` once per state patch. */
  @type('string') displayName: string = '';
  /** Phase 3 multi-ship roster — the `player_ships.ship_id` UUID this ship
   *  was hydrated from (or freshly created with on first spawn). Empty
   *  string in engineering rooms (no persistence) and during the brief
   *  pre-Phase-3 transition window for galaxy rooms whose Limbo entry
   *  hasn't been backfilled yet. Lets the client roster panel mark the
   *  player's currently-bound ship and the abandon endpoint reject the
   *  active ship. */
  @type('string') shipInstanceId: string = '';
}

// Phase 5c: ObstacleState removed. Asteroids and drones now flow through the
// binary swarm channel (see src/server/net/BinarySwarmBroadcast.ts) which
// bypasses MapSchema entirely. This was the master plan's "binary packed
// broadcast" deliverable for scaling past ~16 entities.
//
// Wire-discipline P3 follow-on: ProjectileState removed. Live projectiles now
// flow per-recipient on the (interest-filtered) snapshot message; the
// in-memory `liveProjectiles` map in `SectorRoom` is the sole source of
// truth.

/**
 * Phase 4 — an ownerless ship hull left behind by abandonment. Keyed
 * by the original `shipInstanceId` (the `player_ships.ship_id` UUID
 * the ship was hydrated from) in `state.wrecks`. The hull keeps a SAB
 * slot so the physics worker continues to step it — wrecks have
 * inertia, drift, and collide — but the owning player is gone and no
 * AI is bound. Damage runs through the standard `applyDamage` path;
 * at health 0 the wreck explodes and is removed.
 *
 * Pose lives in `wreckPoseCache` (parallel to `shipPoseCache`), NOT on
 * this schema. The schema diff broadcasts identity + health only; pose
 * rides the snapshot channel.
 */
export class WreckState extends Schema {
  @type('string') shipInstanceId: string = '';
  @type('float32') health: number = SHIP_MAX_HEALTH;
  @type('float32') maxHealth: number = SHIP_MAX_HEALTH;
  @type('string') kind: string = DEFAULT_SHIP_KIND;
}

export class SectorState extends Schema {
  @type({ map: ShipState }) ships = new MapSchema<ShipState>();
  /** Phase 4 — abandoned ship hulls, keyed by shipInstanceId. */
  @type({ map: WreckState }) wrecks = new MapSchema<WreckState>();
  @type('number') tick: number = 0;
  @type('number') clockRate: number = 1.0;
}
