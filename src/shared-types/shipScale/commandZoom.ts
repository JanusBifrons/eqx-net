/**
 * The camera's zoom-out floor. Flying, it is the hull's own
 * (`zoomFloorForView`). In command view it is the widest any ship reaches on
 * this viewport (a battleship's), so a fighter's commander sees the far-zoom
 * field too; the starfield is locked full at every ship's floor already.
 * Called on a change of hull, viewport or view mode only, never per frame.
 */
import type { ShipKind } from '../shipKinds/types.js';
import { SHIP_KINDS_LIST } from '../shipKinds/catalogueOrder.js';
import { zoomFloorForView } from './tuning.js';
import { NAVAL_RANGE, type NavalRangeMode } from '../combat/navalRange.js';

export function zoomFloorFor(kind: ShipKind, command: boolean, viewW: number, viewH: number, mode: NavalRangeMode = NAVAL_RANGE): number {
  let floor = zoomFloorForView(kind, viewW, viewH, mode);
  if (!command) return floor;
  for (let i = 0; i < SHIP_KINDS_LIST.length; i++) floor = Math.min(floor, zoomFloorForView(SHIP_KINDS_LIST[i]!, viewW, viewH, mode));
  return floor;
}
