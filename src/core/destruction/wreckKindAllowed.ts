/**
 * Does a ship of a kind break into wreck pieces? Moved from `SectorRoom`
 * (wreck fields plan, review 3) so the wreck-field layout can pick only kinds
 * that wreck; the room passes its own switches.
 */
import { getShipKind, isShipKindId } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { shipScrapGroups } from '../geometry/shipScrapGroups.js';

/** Read from the kind's destruction profile (#18): `capital` with
 *  `capitalWrecksOn`; `subcap` with `subcapWrecksOn`, except composite kinds
 *  (havok), which keep their per-component scrap; `none` / `rock` never.
 *  Per hit: reads the tuning directly, no allocation (#14). */
export function wreckKindAllowed(kindId: string, capitalWrecksOn: boolean, subcapWrecksOn: boolean): boolean {
  if (!isShipKindId(kindId)) return false;
  switch (shipTuning(getShipKind(kindId)).destruction) {
    case 'capital': return capitalWrecksOn;
    case 'subcap': return subcapWrecksOn && shipScrapGroups(kindId).length === 0;
    case 'none': case 'rock': return false;
  }
}
