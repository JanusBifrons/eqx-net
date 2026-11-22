/**
 * Fleet order + map-pick sends drained by the RAF loop (`gameRafLoop.ts`).
 * Split out of the loop to keep that god file under its cap; behaviour is
 * unchanged. Both run only when the renderer's seq moves, never per frame.
 */

import { useUIStore } from '../state/store.js';
import { logEvent } from '../debug/ClientLogger.js';
import { sendFleetOrder } from '../ships/shipActionsClient.js';
import { fleetCommands } from '../fleet/fleetCommands.js';
import { HELM_SPEED_FRACTION } from '@core/helm/helm';
import type { FleetPickResultWire, RendererFeedback } from '@core/contracts/IRenderer';

/** Send a finished map pick as `set_mode` for the selection (slice 14b).
 *  One small object per pick; nothing is sent with an empty selection. */
export function sendFleetPickResult(result: FleetPickResultWire, ids: readonly string[]): void {
  if (ids.length > 0) {
    const c = fleetCommands();
    if (result.kind === 'patrol') c.setMode(ids, 'patrol', { route: result.route });
    else if (result.kind === 'escort') c.setMode(ids, 'escort', { escortId: result.escortId });
    else if (result.x !== undefined && result.y !== undefined) c.setMode(ids, 'retreat', { x: result.x, y: result.y });
    else c.setMode(ids, 'retreat');
  }
  logEvent('fleet_mode_pick', { kind: result.kind, ships: ids.length });
}

/** Send the renderer's published order for the current selection (one small
 *  object per order). A move order also ends the strip's Move pick (tap rule T3). */
export function sendSelectionOrder(selFb: RendererFeedback): void {
  const ids = selFb.fleetSelIds;
  if (ids.length > 0) {
    if (selFb.orderKind === 'move') {
      // At the Command speed the helm panel shows (Stop / ⅓ / ⅔ / Full).
      const speed = HELM_SPEED_FRACTION[useUIStore.getState().commandSpeed] ?? 1;
      sendFleetOrder(ids.slice(), { kind: 'move', x: selFb.orderX, y: selFb.orderY, speed });
    } else if (selFb.orderKind === 'attack' && selFb.orderTargetId !== null) {
      sendFleetOrder(ids.slice(), { kind: 'attack', targetId: selFb.orderTargetId });
    }
  }
  if (selFb.orderKind === 'move' && useUIStore.getState().fleetPick?.kind === 'move') useUIStore.getState().setFleetPick(null);
  logEvent('fleet_order', { seq: selFb.orderSeq, kind: selFb.orderKind, targetId: selFb.orderTargetId, ships: ids.length });
}
