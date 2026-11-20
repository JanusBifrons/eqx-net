import { useLayoutEffect, type RefObject } from 'react';

/**
 * The speed-dial's open action list fits the screen (sideways phone: 412 px
 * tall). The longer build categories (Economy, Industry) ran off the screen
 * edge, so their last entries (the Shipyard) could not be tapped. The open list
 * is capped to the space between it and the far screen edge and scrolls inside
 * itself; the look of every entry is unchanged.
 *
 * Measured, not a fixed `dvh` sum: the dial sits under the top-right toolbar,
 * whose height varies, so the cap is taken from the list's own on-screen edge.
 *
 * Command view: the bottom-centre stack (desktop build palette, fleet panel /
 * strip, status capsule) can reach under the dial's column (its buttons and
 * their always-on labels). Then a downward list also stops above that stack,
 * so the build list and the fleet / build panels never cover each other
 * (Pixel 7 landscape and desktop). A stack clear of the column changes nothing.
 */

/** Gap kept between the list and the screen edge (px). */
export const FIT_EDGE_MARGIN_PX = 8;
/** Never shrink the list below this (a tiny window still shows a few entries). */
export const FIT_MIN_HEIGHT_PX = 120;
/** Room inside the list, left of each button, for its always-on label. A
 *  scrolling box clips what overflows it, so the labels must sit inside it. */
export const FIT_LABEL_ROOM_PX = 280;

const ACTIONS_SELECTOR = '.MuiSpeedDial-actions';
const LABEL_SELECTOR = '.MuiSpeedDialAction-staticTooltipLabel';
/** The dial's action list (open or parked). */
export const SPEED_DIAL_ACTIONS_SELECTOR = `[data-testid="speed-dial"] ${ACTIONS_SELECTOR}`;
/** The parked (closed) action list: what is inside it is not on screen. */
export const SPEED_DIAL_CLOSED_CLASS = 'MuiSpeedDial-actionsClosed';
/** Every dial control the inspector must not cover: the main button, the
 *  action buttons and their always-on label pills (inspectorPlacement.ts). */
export const SPEED_DIAL_CONTROLS_SELECTOR =
  `[data-testid="speed-dial"] .MuiSpeedDial-fab, [data-testid="speed-dial"] .MuiSpeedDialAction-fab, [data-testid="speed-dial"] ${LABEL_SELECTOR}`;
/** The layout host of the bottom-centre slot stack (LayoutProvider). */
const BOTTOM_STACK_SELECTOR = '[data-anchor="bottom-center"]';

interface Box { top: number; bottom: number; left: number; right: number }

/**
 * Where a downward list must stop: the screen's bottom edge, or the top of the
 * bottom-centre stack when that stack reaches under the list's column (an empty
 * or hidden stack has no size and never counts).
 */
export function listFloor(
  column: { left: number; right: number },
  stack: Box | null,
  viewportHeight: number,
): number {
  if (!stack || stack.bottom - stack.top <= 0 || stack.right - stack.left <= 0) return viewportHeight;
  const overlaps = stack.left < column.right && stack.right > column.left;
  return overlaps ? Math.min(viewportHeight, stack.top) : viewportHeight;
}

/** The largest height the open list can take before it crosses the screen edge
 *  (or, going down, the `floor` from `listFloor`). */
export function availableListHeight(
  rect: { top: number; bottom: number },
  viewportHeight: number,
  direction: 'up' | 'down',
  floor: number = viewportHeight,
): number {
  const room = direction === 'down' ? floor - rect.top : rect.bottom;
  return Math.max(FIT_MIN_HEIGHT_PX, Math.floor(room - FIT_EDGE_MARGIN_PX));
}

/** The list's visible column: its buttons plus the labels left of them (the
 *  label-room padding is empty and lets taps through, so it does not count). */
function listColumn(list: HTMLElement, rect: Box): { left: number; right: number } {
  let left = rect.right;
  for (const el of Array.from(list.children)) left = Math.min(left, el.getBoundingClientRect().left);
  for (const el of Array.from(list.querySelectorAll(LABEL_SELECTOR))) left = Math.min(left, el.getBoundingClientRect().left);
  return { left, right: rect.right };
}

function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

/** Cap the open list to the screen and scroll it back to its first entry. */
export function fitActionsToViewport(root: HTMLElement | null, direction: 'up' | 'down'): void {
  const list = root?.querySelector<HTMLElement>(ACTIONS_SELECTOR);
  if (!list) return;
  const rect = list.getBoundingClientRect();
  const vh = viewportHeight();
  const stack = direction === 'down' ? document.querySelector<HTMLElement>(BOTTOM_STACK_SELECTOR) : null;
  const floor = stack ? listFloor(listColumn(list, rect), stack.getBoundingClientRect(), vh) : vh;
  const max = availableListHeight(rect, vh, direction, floor);
  list.style.maxHeight = `${max}px`;
  // 0 is the start for both directions (column-reverse starts at its bottom).
  list.scrollTop = 0;
}

/** Refit while the dial is open: on open, on every drill (new list), when the
 *  screen resizes or turns, and when the bottom-centre stack changes size (the
 *  fleet panel shows / hides as ships are selected). Event-driven only, never
 *  per frame. */
export function useFitActionsToViewport(
  rootRef: RefObject<HTMLElement | null>,
  direction: 'up' | 'down',
  open: boolean,
  viewKey: string,
): void {
  useLayoutEffect(() => {
    if (!open) return undefined;
    const fit = (): void => fitActionsToViewport(rootRef.current, direction);
    fit();
    const vv = window.visualViewport;
    window.addEventListener('resize', fit);
    vv?.addEventListener('resize', fit);
    const stack = direction === 'down' ? document.querySelector<HTMLElement>(BOTTOM_STACK_SELECTOR) : null;
    const ro = stack && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    if (stack) ro?.observe(stack);
    return () => {
      window.removeEventListener('resize', fit);
      vv?.removeEventListener('resize', fit);
      ro?.disconnect();
    };
  }, [rootRef, direction, open, viewKey]);
}

/** The open list scrolls inside itself (touch drag on the labels), and the drag
 *  never reaches the game (`overscroll-behavior: contain`). The label room is
 *  added as padding and taken back with a negative margin, so the list's place
 *  on screen does not move; the empty room lets taps through to the game. */
export const FIT_OPEN_LIST_SX = {
  boxSizing: 'border-box',
  overflowY: 'auto',
  overflowX: 'hidden',
  overscrollBehavior: 'contain',
  touchAction: 'pan-y',
  scrollbarWidth: 'thin',
  paddingLeft: `${FIT_LABEL_ROOM_PX}px`,
  marginLeft: `-${FIT_LABEL_ROOM_PX}px`,
  pointerEvents: 'none',
  '& > *': { pointerEvents: 'auto' },
} as const;
