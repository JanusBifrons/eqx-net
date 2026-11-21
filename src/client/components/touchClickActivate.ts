import { useCallback, useRef, type MouseEvent, type PointerEvent, type TouchEvent } from 'react';

/**
 * Shared touch/click activation for discrete (tap, not held) HUD buttons.
 *
 * The problem (playtest 2026-06-10 Issue 1 + smoke handoff 2026-06-06 Issue 3):
 * mobile browsers synthesize a `click` ONLY for the PRIMARY touch sequence. A
 * SECOND simultaneous touch — e.g. tapping a button while a steering joystick
 * touch is already held — fires `touchstart` but NEVER a click. So a button
 * bound to `onClick` only is dead while steering. FIRE/BOOST escape this
 * because they bind `onTouchStart`.
 *
 * The fix pattern: bind BOTH. `onTouchStart` toggles on the raw touch (which
 * IS delivered to a second touch point) and opens a short suppression window;
 * `onClick` stays live for desktop but is dropped if it lands within that
 * window (so the trailing synthesized click doesn't double-fire — the historic
 * AutoFireToggleButton double-toggle trap).
 *
 * This hook is the ONE implementation of that pattern (used by
 * `SpeedDialMenu`). Its other half, `useFreshPress` below, guards the options
 * of a menu such a button opens.
 */

/**
 * Window after a handled `onTouchStart` during which a synthesized `click` is
 * ignored, so touch activation doesn't double-fire. 700 ms comfortably covers
 * the browser's touch→click delay without swallowing a deliberate follow-up
 * desktop click.
 */
export const TOUCH_CLICK_SUPPRESS_MS = 700;

/** Pure suppress-window predicate (unit-locked independent of React). */
export function isClickSuppressed(lastTouchMs: number, nowMs: number): boolean {
  return nowMs - lastTouchMs < TOUCH_CLICK_SUPPRESS_MS;
}

export interface TouchClickActivate {
  /** Bind to `onTouchStart`: runs `fn` on the raw touch (works for a 2nd
   *  simultaneous touch point) + opens the click-suppression window. */
  touchActivate: (fn: () => void) => (e: TouchEvent) => void;
  /** Bind to `onClick`: runs `fn` unless a touch handled the same gesture
   *  within the suppress window (drops the trailing synthesized click). */
  clickActivate: (fn: () => void) => () => void;
  /** True if a `touchActivate` fired within the suppress window — for consumers
   *  (e.g. MUI SpeedDial `onOpen`/`onClose`) that can't route through
   *  `clickActivate`. */
  isWithinSuppressWindow: () => boolean;
}

export function useTouchClickActivate(): TouchClickActivate {
  const lastTouchMs = useRef(0);
  const touchActivate = useCallback(
    (fn: () => void) =>
      (e: TouchEvent): void => {
        e.preventDefault(); // best-effort suppress the synthesized click
        e.stopPropagation();
        lastTouchMs.current = Date.now();
        fn();
      },
    [],
  );
  const clickActivate = useCallback(
    (fn: () => void) =>
      (): void => {
        // Ignore the click some browsers still synthesize shortly after a
        // touchstart we already handled.
        if (isClickSuppressed(lastTouchMs.current, Date.now())) return;
        fn();
      },
    [],
  );
  const isWithinSuppressWindow = useCallback(
    () => isClickSuppressed(lastTouchMs.current, Date.now()),
    [],
  );
  return { touchActivate, clickActivate, isWithinSuppressWindow };
}

/**
 * After a menu opens, how long before a press on one of its options counts:
 * a backstop for the press that opened it (owner playtest 2026-11-21).
 */
export const MENU_ARM_MS = 250;

/** Spread onto a menu option: `onPointerDown` + `onClick`. */
export interface FreshPressProps {
  onPointerDown: (e: PointerEvent<Element>) => void;
  onClick: (e: MouseEvent<Element>) => void;
}

/**
 * The other half of the pattern above: the options of a menu that a
 * touch-activated button opens. That button acts on touchstart, so the menu is
 * up before the finger lifts, and the browser's click for that same touch then
 * lands on whatever option is now under the finger (`preventDefault` in a
 * React touchstart handler is a no-op: the listener is passive). So an option
 * acts only on a FRESH, full press: a pointerdown on that same option at least
 * `MENU_ARM_MS` after the menu opened, then its click. A click with no such
 * down (the opening press's leftover release, or a drag in from another
 * option) is ignored. A keyboard click (`detail === 0`: Enter/Space on a
 * focused button) has no pointer and always acts.
 */
export function useFreshPress(open: boolean): (fn: () => void) => FreshPressProps {
  const openedAt = useRef(0);
  const wasOpen = useRef(false);
  const pressed = useRef<EventTarget | null>(null);
  if (open && !wasOpen.current) {
    openedAt.current = Date.now();
    pressed.current = null;
  }
  wasOpen.current = open;
  return useCallback(
    (fn: () => void): FreshPressProps => ({
      onPointerDown: (e) => {
        pressed.current = Date.now() - openedAt.current >= MENU_ARM_MS ? e.currentTarget : null;
      },
      onClick: (e) => {
        const fresh = e.detail === 0 || pressed.current === e.currentTarget;
        pressed.current = null;
        if (fresh) fn();
      },
    }),
    [],
  );
}
