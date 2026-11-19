/** The line-of-fire grid's player-ship bodies (`SectorRoom.fillLofShips`). */
import type { ShipState } from './schema/SectorState.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';

/** A player's ship (a pilot's ACTIVE ship, keyed by playerId, or a LINGERING
 *  hull, keyed by shipInstanceId) as a `LineOfFireGate` body: players' ships
 *  are not swarm records. One per ship key, reused (#14). */
export class LofShipBody {
  id = '';
  slot = 0;
  /** Broadphase bound: kind 1 + `shipKind` bins by `shipHitBound`. */
  radius = 0;
  readonly kind = 1;
  shipKind = '';
  /** Owning player. */
  owner = '';
  /** The ship's instance id (= `id` for a lingering hull). */
  sid = '';
  ship: ShipState | null = null;
  /** Build generation it was last filled in (stale-body sweep). */
  gen = 0;
}
export type LofBody = SwarmEntityRecord | LofShipBody;
