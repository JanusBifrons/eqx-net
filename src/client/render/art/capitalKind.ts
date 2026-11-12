/**
 * Is this ship kind a capital (`sizeClass === 'capital'`, via the shared
 * `sizeClassOf`)? GPU-lit art uses it so capitals neither shade nor are
 * shaded by each other (`occluderShades`). Unknown ids are not capitals.
 * Called once when a sprite is built, never per frame.
 */
import { getShipKind, isShipKindId } from '@shared-types/shipKinds';
import { sizeClassOf } from '@shared-types/shipScale/tuning';

export function isCapitalKindId(id: string): boolean {
  return isShipKindId(id) && sizeClassOf(getShipKind(id)) === 'capital';
}
