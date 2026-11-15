/**
 * The drawn shield bubble radius for an entity in the render mirror: a ship
 * (`mirror.ships`: pilots' ships and parked hulls, one list since RTS Part A
 * S3) or a drone (`swarm-<entityId>`). The ONE source both shield visuals use,
 * so the drawn bubble is the shield collider (`shieldBubbleRadius`, #15/#18).
 * Returns undefined when the entity or its kind is unknown.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';
import { shieldBubbleRadius } from '@shared-types/shipScale/tuning';

export function shieldBubbleRadiusForEntity(
  id: string,
  mirror: Pick<RenderMirror, 'ships' | 'swarm'>,
): number | undefined {
  if (id.startsWith('swarm-')) {
    const sw = mirror.swarm?.get(parseInt(id.slice('swarm-'.length), 10));
    if (!sw?.shipKind) return undefined;
    return shieldBubbleRadius(getShipKind(sw.shipKind));
  }
  const ship = mirror.ships.get(id);
  if (!ship?.kind) return undefined;
  return shieldBubbleRadius(getShipKind(ship.kind));
}
