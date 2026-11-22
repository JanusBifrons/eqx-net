/**
 * What a gameplay tap does (Command, Fly and Build alike; every pointer).
 *
 * Pure. The renderer picks what is under the tap, then asks this:
 *  - an own ship under the tap selects it;
 *  - something that is not mine, with ships selected: FOCUS it and keep the
 *    ships selected (the left strip shows it; its Lock button orders them to
 *    attack it);
 *  - free space with ships selected: DESELECT, like an RTS (shift keeps the
 *    ships and only drops the focus);
 *  - otherwise inspect whatever is (or is not) under the tap.
 * A tap is never an order, on touch either: move and attack orders stay on the
 * mouse right-click (the router's `order` action).
 */
export type FleetOrderMode = 'move' | 'attack';

export type TapAction = 'select' | 'focus' | 'inspect' | 'deselect';

export interface TapContext {
  /** 'mouse' | 'touch' | 'pen'. The rule is the same for every pointer. */
  pointerType: string;
  /** An own ship is under the tap. */
  hitOwn: boolean;
  /** Some entity is under the tap. */
  hitEntity: boolean;
  /** The fleet selection is non-empty. */
  hasSelection: boolean;
  /** Shift held (mouse only in practice). */
  additive: boolean;
}

export function decideTapAction(c: TapContext): TapAction {
  if (c.hitOwn) return 'select';
  if (!c.hasSelection) return 'inspect';
  if (c.hitEntity) return 'focus';
  return c.additive ? 'inspect' : 'deselect';
}
