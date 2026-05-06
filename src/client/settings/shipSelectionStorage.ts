import {
  DEFAULT_SHIP_KIND,
  isShipKindId,
  type ShipKindId,
} from '../../shared-types/shipKinds.js';
import { loadJSON, saveJSON, type UserId } from './userPrefs.js';

const BASE = 'eqxShipSelection';

interface Stored {
  shipKind: string;
}

function decode(parsed: unknown): ShipKindId | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Partial<Stored>;
  if (typeof obj.shipKind !== 'string') return null;
  return isShipKindId(obj.shipKind) ? obj.shipKind : null;
}

/**
 * Load the user's selected ship kind. Returns `DEFAULT_SHIP_KIND` if nothing
 * is persisted, the stored value is malformed, or the stored kind id was
 * removed from the catalogue (e.g. an older build wrote 'corvette' and the
 * kind no longer exists).
 *
 * No legacy migration here — this preference did not exist before per-user
 * keying landed.
 */
export function loadShipKind(userId: UserId): ShipKindId {
  return loadJSON<ShipKindId>(BASE, userId, decode) ?? DEFAULT_SHIP_KIND;
}

export function saveShipKind(userId: UserId, shipKind: ShipKindId): void {
  saveJSON(BASE, userId, { shipKind } satisfies Stored);
}
