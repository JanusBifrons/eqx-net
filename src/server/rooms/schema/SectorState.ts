import { Schema, MapSchema, type } from '@colyseus/schema';

export class ShipState extends Schema {
  @type('string') playerId: string = '';
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') angle: number = 0;
  @type('number') vx: number = 0;
  @type('number') vy: number = 0;
}

export class SectorState extends Schema {
  @type({ map: ShipState }) ships = new MapSchema<ShipState>();
  @type('number') tick: number = 0;
  @type('number') clockRate: number = 1.0;
}
