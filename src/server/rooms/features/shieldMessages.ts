/**
 * `set_shields` — the pilot drops or raises their OWN ship's shields (the HUD
 * shield ring tap). The message names no ship: it acts only on the sender's
 * active hull, so nobody can change another ship's shields. The shield rules
 * live in `ShieldHullRouter.setShipShieldsLowered` (the one shield model).
 */
import type { Client } from 'colyseus';
import type { ShipState } from '../schema/SectorState.js';
import type { ShieldHullRouter } from '../ShieldHullRouter.js';
import { SetShieldsSchema } from '../../../shared-types/messages.js';
import { parsedMessage, type ParsedMessageHost, type RoomFeature } from './parsedMessage.js';

/** What the handler needs from the room; getters read the live field. */
export interface ShieldMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  getActiveShip(playerId: string): ShipState | undefined;
  shieldHull(): Pick<ShieldHullRouter, 'setShipShieldsLowered'>;
}

export function registerShieldMessages(h: ShieldMessageHost): RoomFeature {
  parsedMessage(h, 'set_shields', SetShieldsSchema, (msg, client: Client) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    const ship = h.getActiveShip(playerId);
    if (!ship) return;
    h.shieldHull().setShipShieldsLowered(ship, !msg.up);
  });
  return {};
}
