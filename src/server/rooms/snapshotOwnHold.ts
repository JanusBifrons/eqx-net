/**
 * The own ship's hold and fitted blueprints on its snapshot entry (#16: the
 * client's cargo readout comes only from here). "Own ship" is the one
 * `PilotSwap.ownShipKey` names: the hull the player flies, else the hull they
 * parked by Command / Build — the hold Build takes packed crates from, so a
 * placed Capital's crate leaves the readout while the player is still in
 * Build. Shared references, no allocation (#14).
 * Extension point of `SnapshotBroadcaster`.
 */
import { isHoldEmpty, wireHold } from '../../core/cargo/hold.js';
import type { Hold } from '../../shared-types/goods.js';

export interface OwnHoldEntry {
  cargo?: Hold;
  fitted?: string[];
}

export interface OwnHoldDeps {
  /** Living World P1a — the carried hold of a ship instance (a SHARED reference
   *  from the HoldStore, replaced only on a discrete transfer — #14 safe), or
   *  undefined when it carries nothing. Absent dep ⇒ no cargo slice. */
  shipHoldOf?: (shipInstanceId: string) => Hold | undefined;
  /** Living World P5 — the blueprints fitted to a ship instance (own ship
   *  only on the wire). A SHARED reference; undefined ⇒ none known. */
  fittedOf?: (shipInstanceId: string) => readonly string[] | undefined;
  /** The player's own ship here (`PilotSwap.ownShipKey`). Absent ⇒ the
   *  active hull only. */
  ownShipKeyOf?: (playerId: string) => string | undefined;
}

/** Is this wire ship the recipient's own ship (flown, else parked by Command / Build)? */
export function isOwnHull(deps: OwnHoldDeps, ship: { shipInstanceId: string; playerId: string; isActive: boolean }, recipientPlayerId: string): boolean {
  if (ship.playerId !== recipientPlayerId) return false;
  return ship.isActive || deps.ownShipKeyOf?.(ship.playerId) === ship.shipInstanceId;
}

/** Set `cargo` (non-empty, a rock chunk's hidden ore stripped by `wireHold`)
 *  and `fitted` (non-empty) for the own hull; drop both otherwise. */
export function setOwnHold(entry: OwnHoldEntry, deps: OwnHoldDeps, shipInstanceId: string, ownHull: boolean): void {
  const hold = ownHull ? deps.shipHoldOf?.(shipInstanceId) : undefined;
  if (hold !== undefined && !isHoldEmpty(hold)) entry.cargo = wireHold(hold);
  else if ('cargo' in entry) delete entry.cargo;
  const fitted = ownHull ? deps.fittedOf?.(shipInstanceId) : undefined;
  if (fitted !== undefined && fitted.length > 0) entry.fitted = fitted as string[];
  else if ('fitted' in entry) delete entry.fitted;
}
