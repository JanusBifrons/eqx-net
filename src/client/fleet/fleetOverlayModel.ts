/**
 * Main-thread builder for the renderer's fleet overlay model (RTS slice 15a).
 *
 * The renderer may live in a worker, so it cannot read the `fleetStatus`
 * singleton. `gameRafLoop` calls {@link pushFleetOverlayModelIfChanged} each
 * frame; it rebuilds + posts the compact model only when the status version
 * moved (no allocation on unchanged frames).
 */
import type { FleetOverlayModel, FleetOverlayShip, IRenderer } from '@core/contracts/IRenderer';
import { forEachFleetStatus, getFleetStatusVersion, type FleetStatusRow } from './fleetStatus.js';

/** One row → the renderer's per-ship entry. */
export function overlayShipFor(id: string, row: FleetStatusRow): FleetOverlayShip {
  const s: FleetOverlayShip = {
    id,
    squadId: row.squadId ?? null,
    orderKind: row.orderKind ?? null,
  };
  if (row.orderKind === 'move' && row.orderX !== undefined && row.orderY !== undefined) {
    s.destX = row.orderX;
    s.destY = row.orderY;
  }
  if (row.orderKind === 'attack' && row.targetId !== null) s.targetId = row.targetId;
  const escort = row.escortId ?? (row.mode === 'escort' && row.targetId !== null ? row.targetId : undefined);
  if (escort !== undefined && row.orderKind === undefined) s.escortId = escort;
  if (row.route !== undefined && row.route.length > 0 && row.orderKind === undefined) {
    s.route = row.route.map((p) => [p[0], p[1]] as [number, number]);
  }
  return s;
}

/** The whole model from the current status rows. Allocates; call on change. */
export function buildFleetOverlayModel(): FleetOverlayModel {
  const ships: FleetOverlayShip[] = [];
  forEachFleetStatus((id, row) => { ships.push(overlayShipFor(id, row)); });
  return { ships };
}

/**
 * Push the model to `renderer` when the fleet status version differs from
 * `lastVersion`; returns the version now pushed (or `lastVersion`).
 */
export function pushFleetOverlayModelIfChanged(renderer: IRenderer, lastVersion: number): number {
  const v = getFleetStatusVersion();
  if (v === lastVersion) return lastVersion;
  renderer.setFleetOverlayModel(buildFleetOverlayModel());
  return v;
}
