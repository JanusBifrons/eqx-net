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

export class SectorState extends Schema {
  @type({ map: ShipState }) ships = new MapSchema<ShipState>();
  @type('number') tick: number = 0;
  @type('number') clockRate: number = 1.0;
}
