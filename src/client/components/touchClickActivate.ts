import { useCallback, useMemo, useRef, type MouseEvent, type PointerEvent, type TouchEvent } from 'react';

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
 * `ShieldRing`). Its other half, `useFreshPress` / `useFreshPressSurface`
 * below, guards what such a button opens.
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
   *  (e.g. a MUI component's `onOpen`/`onClose`) that can't route through
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
 * After a menu opens, how long before a TOUCH (or pen) press inside it counts:
 * a backstop for the press that opened it (owner playtest 2026-11-21). A mouse
 * press counts at once: a mouse-opened menu opens on the release, so nothing
 * of that press is left over.
 */
export const MENU_ARM_MS = 250;

/** Spread onto a menu option: `onPointerDown` + `onClick`. */
export interface FreshPressProps {
  onPointerDown: (e: PointerEvent<Element>) => void;
  onClick: (e: MouseEvent<Element>) => void;
}

/** Spread onto a whole surface (drawer, full-screen map): capture-phase guard. */
export interface FreshPressSurfaceProps {
  onPointerDownCapture: (e: PointerEvent<Element>) => void;
  onClickCapture: (e: MouseEvent<Element>) => void;
}

interface FreshPressCore {
  /** Record a pointerdown on `e.currentTarget` (or nothing, inside the arm delay). */
  down: (e: PointerEvent<Element>) => void;
  /** Whether this click ends a fresh press on `e.currentTarget`; consumes it. */
  fresh: (e: MouseEvent<Element>) => boolean;
}

/** The one fresh-press state machine behind both bindings below. */
function useFreshPressCore(open: boolean): FreshPressCore {
  const openedAt = useRef(0);
  const wasOpen = useRef(false);
  const pressed = useRef<EventTarget | null>(null);
  if (open && !wasOpen.current) {
    openedAt.current = Date.now();
    pressed.current = null;
  }
  wasOpen.current = open;
  const down = useCallback((e: PointerEvent<Element>): void => {
    const armed = e.pointerType === 'mouse' || Date.now() - openedAt.current >= MENU_ARM_MS;
    pressed.current = armed ? e.currentTarget : null;
  }, []);
  const fresh = useCallback((e: MouseEvent<Element>): boolean => {
    const ok = e.detail === 0 || pressed.current === e.currentTarget;
    pressed.current = null;
    return ok;
  }, []);
  return useMemo(() => ({ down, fresh }), [down, fresh]);
}

/**
 * The other half of the pattern above: what a touch-activated button opens.
 * That button acts on touchstart, so the menu is up before the finger lifts,
 * and the browser's click for that same touch then lands on whatever is now
 * under the finger (`preventDefault` in a React touchstart handler is a no-op:
 * the listener is passive). So a click acts only if it ends a FRESH, full
 * press: a pointerdown on the same element after the menu opened (touch: at
 * least `MENU_ARM_MS` after), then its click. A click with no such down (the
 * opening press's leftover release, or a drag in from another option) is
 * ignored. A keyboard click (`detail === 0`: Enter/Space on a focused button)
 * has no pointer and always acts.
 *
 * `useFreshPress` guards single options; `useFreshPressSurface` guards a whole
 * surface (every button, tab, row and backdrop in it) in the capture phase.
 */
export function useFreshPress(open: boolean): (fn: () => void) => FreshPressProps {
  const { down, fresh } = useFreshPressCore(open);
  return useCallback(
    (fn: () => void): FreshPressProps => ({
      onPointerDown: down,
      onClick: (e) => { if (fresh(e)) fn(); },
    }),
    [down, fresh],
  );
}

/** Surface form of {@link useFreshPress}: while `open`, a click inside the
 *  surface that does not end a fresh press there is stopped before it reaches
 *  its target. Closed (or never opened from a held press): no guard. */
export function useFreshPressSurface(open: boolean): FreshPressSurfaceProps {
  const { down, fresh } = useFreshPressCore(open);
  const openRef = useRef(open);
  openRef.current = open;
  return useMemo(() => ({
    onPointerDownCapture: down,
    onClickCapture: (e: MouseEvent<Element>): void => {
      if (!openRef.current || fresh(e)) return;
      e.stopPropagation();
      e.preventDefault();
    },
  }), [down, fresh]);
}
