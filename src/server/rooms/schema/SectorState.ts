import { Schema, MapSchema, type } from '@colyseus/schema';

export class ShipState extends Schema {
  @type('string') playerId: string = '';
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') angle: number = 0;
  @type('number') vx: number = 0;
  @type('number') vy: number = 0;
  @type('number') angvel: number = 0;
  @type('float32') health: number = 100;
  @type('float32') maxHealth: number = 100;
  @type('boolean') alive: boolean = true;
}

export class ObstacleState extends Schema {
  @type('string') obstacleId: string = '';
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') angle: number = 0;
  @type('number') vx: number = 0;
  @type('number') vy: number = 0;
  @type('number') radius: number = 24;
}

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
  @type({ map: ObstacleState }) obstacles = new MapSchema<ObstacleState>();
  @type({ map: ProjectileState }) projectiles = new MapSchema<ProjectileState>();
  @type('number') tick: number = 0;
  @type('number') clockRate: number = 1.0;
}
