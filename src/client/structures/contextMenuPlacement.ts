/**
 * Pure decision for the window `contextmenu` handler during structure placement
 * (Equinox Phase 6 / P6.2 — "click and hold vibrates then fails to place").
 *
 * Background: on DESKTOP a right-click cancels placement (WS-10 / R2.5), and we
 * `preventDefault` the native menu while placing. But Android Chrome ALSO fires
 * a `contextmenu` event on a touch LONG-PRESS — so holding a finger on the
 * canvas during placement was cancelling the placement (the desktop affordance
 * leaking onto mobile), and the OS long-press haptic fired alongside it (the
 * "vibrates then doesn't place" report).
 *
 * Fix: still `preventDefault` whenever placing (suppress the native menu on BOTH
 * input types — harmless on touch, wanted on desktop), but only CANCEL when the
 * gesture came from a MOUSE. We can't read `pointerType` off the `contextmenu`
 * MouseEvent reliably, so the caller tracks the most recent `pointerdown`'s
 * `pointerType` (a long-press's pointerdown is `'touch'`; a right-click's is
 * `'mouse'`). This is per-GESTURE, not per-device, so a mouse on a hybrid
 * touchscreen still right-click-cancels (the general fix, no `isTouchDevice()`
 * device-axis special-casing).
 */
export interface ContextMenuPlacementOutcome {
  /** Suppress the browser's native context menu. */
  preventDefault: boolean;
  /** Exit placement mode (`setPlacementKind(null)`). */
  cancel: boolean;
}

/**
 * @param hasPlacementKind whether a structure placement is currently active
 * @param lastPointerType  `pointerType` of the most recent `pointerdown`
 *                         (`'mouse'` | `'touch'` | `'pen'` | `''` if none yet)
 */
export function decideContextMenuPlacement(
  hasPlacementKind: boolean,
  lastPointerType: string,
): ContextMenuPlacementOutcome {
  if (!hasPlacementKind) return { preventDefault: false, cancel: false };
  // Suppress the native menu on both inputs; only a MOUSE right-click cancels.
  return { preventDefault: true, cancel: lastPointerType === 'mouse' };
}
