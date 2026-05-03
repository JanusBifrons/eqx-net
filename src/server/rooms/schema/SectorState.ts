import { Schema, MapSchema, type } from '@colyseus/schema';
import { SHIP_MAX_HEALTH } from '../../../core/combat/Weapons.js';

export class ShipState extends Schema {
  @type('string') playerId: string = '';
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') angle: number = 0;
  @type('number') vx: number = 0;
  @type('number') vy: number = 0;
  @type('number') angvel: number = 0;
  @type('float32') health: number = SHIP_MAX_HEALTH;
  @type('float32') maxHealth: number = SHIP_MAX_HEALTH;
  @type('boolean') alive: boolean = true;
}

// Phase 5c: ObstacleState removed. Asteroids and drones now flow through the
// binary swarm channel (see src/server/net/BinarySwarmBroadcast.ts) which
// bypasses MapSchema entirely. This was the master plan's "binary packed
// broadcast" deliverable for scaling past ~16 entities.

export class ProjectileState extends Schema {
  @type('string') projectileId: string = '';
  @type('string') ownerId: string = '';
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') vx: number = 0;
  @type('float32') vy: number = 0;
  @type('boolean') destroyed: boolean = false;
}

export class SectorState extends Schema {
  @type({ map: ShipState }) ships = new MapSchema<ShipState>();
  @type({ map: ProjectileState }) projectiles = new MapSchema<ProjectileState>();
  @type('number') tick: number = 0;
  @type('number') clockRate: number = 1.0;
}
