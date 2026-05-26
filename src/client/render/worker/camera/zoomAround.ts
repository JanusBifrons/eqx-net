/**
 * Pure "zoom around a screen point" transform.
 *
 * Keeps the world point currently under `(screenX, screenY)` fixed in
 * screen space as the scale changes. Used by wheel-zoom (anchor at
 * cursor or screen-centre when following) and pinch-zoom (anchor at
 * midpoint of the two pointers).
 *
 * Mutates the provided `target` — pan offset `x/y` and uniform `scale`.
 * The caller is responsible for clamping `newScale` to [min, max]
 * before passing it here.
 */

export interface ZoomTarget {
  x: number;
  y: number;
  scale: {
    x: number;
    y: number;
    set(s: number): void;
  };
}

export function zoomAround(
  target: ZoomTarget,
  screenX: number,
  screenY: number,
  newScale: number,
): void {
  const worldX = (screenX - target.x) / target.scale.x;
  const worldY = (screenY - target.y) / target.scale.y;
  target.scale.set(newScale);
  target.x = screenX - worldX * newScale;
  target.y = screenY - worldY * newScale;
}

/**
 * Wheel-zoom step factor. `deltaY > 0` (wheel down) = zoom out;
 * `deltaY < 0` = zoom in. The 0.9 / 1.1 factor matches pixi-viewport's
 * default `wheel({ smooth: 4 })` roughly.
 */
export function wheelZoomFactor(deltaY: number): number {
  return deltaY > 0 ? 0.9 : 1.1;
}
