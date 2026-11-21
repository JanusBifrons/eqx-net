/**
 * `set_shields` send helper: the HUD shield-ring tap drops (`up: false`) or
 * raises (`up: true`) the pilot's own shields. The server owns the rules
 * (`ShieldHullRouter.setShipShieldsLowered`); the ring's DOWN state comes back
 * on the own-ship snapshot slice `shieldsLowered`, never from this send.
 */
import type { SetShieldsMessage } from '../../shared-types/messages.js';
import { getGameClient } from './clientSingleton.js';

/** Returns false when there is no live room. */
export function sendSetShields(up: boolean): boolean {
  const room = getGameClient()?.getRoom();
  if (!room) return false;
  const msg: SetShieldsMessage = { type: 'set_shields', up };
  room.send('set_shields', msg);
  return true;
}
