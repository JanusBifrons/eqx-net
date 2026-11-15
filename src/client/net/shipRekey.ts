/**
 * Where a wire ship is drawn now when it is not under the key it resolves to
 * (RTS Part A, seamless take controls). The key a ship lives under comes from
 * `shipMirrorKey`; it changes when someone takes its controls (shipInstanceId
 * -> pilot's playerId) or lets go of them (playerId -> shipInstanceId). The
 * snapshot router and `syncMirror` ask this before creating an entry, so the
 * existing entry is MOVED (`ColyseusClient.rekeyShip`) instead of a second one
 * being created and the old one dropped (the renderer rebuilt the ship: the
 * flicker).
 *
 * Pure, allocation-free. The scan runs only when `key` is missing from the
 * mirror (a new ship or a re-key), never for a ship already listed.
 */
import type { ShipRenderState } from '@core/contracts/IRenderer';

/**
 * The key `shipInstanceId` is drawn under now, when that is not `key`; null
 * when `key` is already listed or the ship is new. A parked hull lives under
 * its own id; an active ship carries `shipInstanceId` on its entry.
 */
export function findRekeySource(
  ships: ReadonlyMap<string, ShipRenderState>,
  shipInstanceId: string,
  key: string,
): string | null {
  if (ships.has(key)) return null;
  if (key !== shipInstanceId && ships.has(shipInstanceId)) return shipInstanceId;
  for (const [k, e] of ships) {
    if (k !== key && e.shipInstanceId === shipInstanceId) return k;
  }
  return null;
}
