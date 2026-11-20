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
 */

/** Gap kept between the list and the screen edge (px). */
export const FIT_EDGE_MARGIN_PX = 8;
/** Never shrink the list below this (a tiny window still shows a few entries). */
export const FIT_MIN_HEIGHT_PX = 120;
/** Room inside the list, left of each button, for its always-on label. A
 *  scrolling box clips what overflows it, so the labels must sit inside it. */
export const FIT_LABEL_ROOM_PX = 280;

const ACTIONS_SELECTOR = '.MuiSpeedDial-actions';

/** The largest height the open list can take before it crosses the screen edge. */
export function availableListHeight(
  rect: { top: number; bottom: number },
  viewportHeight: number,
  direction: 'up' | 'down',
): number {
  const room = direction === 'down' ? viewportHeight - rect.top : rect.bottom;
  return Math.max(FIT_MIN_HEIGHT_PX, Math.floor(room - FIT_EDGE_MARGIN_PX));
}

function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

/** Cap the open list to the screen and scroll it back to its first entry. */
export function fitActionsToViewport(root: HTMLElement | null, direction: 'up' | 'down'): void {
  const list = root?.querySelector<HTMLElement>(ACTIONS_SELECTOR);
  if (!list) return;
  const max = availableListHeight(list.getBoundingClientRect(), viewportHeight(), direction);
  list.style.maxHeight = `${max}px`;
  // 0 is the start for both directions (column-reverse starts at its bottom).
  list.scrollTop = 0;
}

/** Refit while the dial is open: on open, on every drill (new list), and when
 *  the screen resizes or turns. Event-driven only, never per frame. */
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
    return () => {
      window.removeEventListener('resize', fit);
      vv?.removeEventListener('resize', fit);
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
