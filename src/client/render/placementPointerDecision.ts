/**
 * Pure decision for the desktop/touch structure-placement pointer state machine
 * (extracted from `PixiRenderer.routePlacementPointer` — Phase A3 pattern, the
 * "decision logic lives in a pure, unit-tested module" rule).
 *
 * The placement ghost FOLLOWS the pointer while `following` is true. On DESKTOP
 * the model is hover-follow (no button) → left-click places; on TOUCH it's
 * tap-to-position → the touch-up PARKS the ghost (so the Confirm banner is
 * stable) → Confirm commits.
 *
 * P3.5 (follow STILL broken, 2026-06-13): the load-bearing rule encoded here is
 * that **`pointerleave` does NOT park the follow**. Desktop hover-follow has no
 * pointerdown to anchor a pointer capture, so the canvas fires `pointerleave`
 * the instant the cursor crosses an HUD overlay (the speed-dial) or runs off the
 * edge — and parking there (the pre-fix behaviour) set `following=false`, after
 * which every later move was ignored and the ghost "broke its lock" and never
 * reconnected. Leaving is now a no-op; the follow stays live until a real commit
 * (mouse left-click) or cancel (Escape / right-click / a genuine pointercancel).
 */
export interface PlacementPointerOutcome {
  /** New value for the follow flag, or `null` to leave it unchanged. */
  following: boolean | null;
  /** Write this event's world point into the chosen-point state. */
  updateChosen: boolean;
  /** Desktop one-click place — bump the commit seq the main thread drains. */
  commit: boolean;
}

/**
 * @param type        pointer event type
 * @param pointerType `'mouse'` | `'touch'` | `'pen'`
 * @param button      pressed button (0 = primary/left)
 * @param following   the CURRENT follow state (so `pointermove` only tracks
 *                    while following — the touch park must hold)
 */
export function decidePlacementPointer(
  type: string,
  pointerType: string,
  button: number,
  following: boolean,
): PlacementPointerOutcome {
  switch (type) {
    case 'pointerdown':
      // Touch drag begins (or a mouse press) — start following + anchor.
      return { following: true, updateChosen: true, commit: false };
    case 'pointermove':
      // Track only while following (false after a touch park, true on desktop
      // hover — which `pointerleave` no longer clears).
      return { following: null, updateChosen: following, commit: false };
    case 'pointerup':
      // Desktop mouse LEFT-release = one-click place (commit). Touch release =
      // park (following → false) so the Confirm banner is hit-testable.
      return pointerType === 'mouse' && button === 0
        ? { following: false, updateChosen: true, commit: true }
        : { following: false, updateChosen: true, commit: false };
    case 'pointercancel':
      // A genuine pointer cancellation (touch aborted by the OS/browser) parks.
      return { following: false, updateChosen: false, commit: false };
    case 'pointerleave':
      // NO-OP — leaving the canvas must NOT park the follow (the P3.5 fix). The
      // window capture-phase pointermove keeps the ghost tracking off-canvas.
      return { following: null, updateChosen: false, commit: false };
    default:
      return { following: null, updateChosen: false, commit: false };
  }
}
