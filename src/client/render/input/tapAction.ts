/**
 * What a command-view tap does (RTS command layer, slice 12: phone orders).
 *
 * Pure. The renderer picks what is under the tap, then asks this:
 *  - an own ship under the tap always selects it (any pointer);
 *  - touch/pen with a fleet selection gives an ORDER, per the strip's
 *    `fleetOrderMode`: 'move' moves to the tap point (whatever is under it);
 *    'attack' attacks the attackable entity under it, else does nothing;
 *  - otherwise (mouse, or nothing selected) the tap inspects; a plain tap
 *    with a selection first clears it ('deselect' = clear, then inspect).
 * Mouse orders stay on right-click (the router's `order` action).
 */
export type FleetOrderMode = 'move' | 'attack';

export type TapAction = 'select' | 'inspect' | 'deselect' | 'orderMove' | 'orderAttack' | 'none';

export interface TapContext {
  /** 'mouse' | 'touch' | 'pen' */
  pointerType: string;
  /** An own ship is under the tap. */
  hitOwn: boolean;
  /** Some (non-own) entity is under the tap. */
  hitEntity: boolean;
  /** That entity can be attacked (not own, not an asteroid). */
  hitAttackable: boolean;
  /** The fleet selection is non-empty. */
  hasSelection: boolean;
  orderMode: FleetOrderMode;
  /** Shift held (mouse only in practice). */
  additive: boolean;
}

export function decideTapAction(c: TapContext): TapAction {
  if (c.hitOwn) return 'select';
  const touchLike = c.pointerType === 'touch' || c.pointerType === 'pen';
  if (touchLike && c.hasSelection) {
    if (c.orderMode === 'move') return 'orderMove';
    return c.hitEntity && c.hitAttackable ? 'orderAttack' : 'none';
  }
  return c.hasSelection && !c.additive ? 'deselect' : 'inspect';
}
