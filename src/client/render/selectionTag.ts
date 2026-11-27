import type { RenderMirror } from '@core/contracts/IRenderer';
import { bracketHalfPx, resolveSelectable, type SelectableTarget } from './SelectionBracket';
import type { SelectionTagFeedback } from './selectionTagFeedback.js';

/**
 * Selection-HUD world tag anchors (S6a): where a floating DOM name tag sits
 * over the focus and over the selected fleet. Written each frame in
 * `update()` (`RendererInputController.updateSelectionBrackets`) through the
 * same camera projection as the selection brackets and `placementScreenX/Y`,
 * so both renderer paths (main thread and worker) publish them; the worker
 * copies them across with `copySelectionTagFeedback` (`selectionTagFeedback.ts`). Alloc-free (#14).
 */

/** The camera surface the projection needs (`worker/Camera.ts`). */
export interface SelectionTagCamera {
  toScreenInto(worldX: number, worldY: number, out: { x: number; y: number }): void;
  readonly scale: { readonly x: number };
  readonly screenWidth: number;
  readonly screenHeight: number;
}

const _t: SelectableTarget = { x: 0, y: 0, r: 0, hw: 0, hh: 0 };
const _s = { x: 0, y: 0 };

/**
 * Project the focus (its bracket's top-centre + on-screen diameter) and the
 * selected ships' centroid into `fb`. Game y is up, Pixi y down: the world
 * point is projected at `(x, -y)` like `SelectionBracket.draw`.
 */
export function writeSelectionTag(
  mirror: RenderMirror,
  focusId: string | null,
  selShips: ReadonlySet<string>,
  camera: SelectionTagCamera,
  fb: SelectionTagFeedback,
): void {
  const zoom = camera.scale.x;
  const w = camera.screenWidth;
  const h = camera.screenHeight;
  if (focusId !== null && resolveSelectable(mirror, focusId, _t)) {
    camera.toScreenInto(_t.x, -_t.y, _s);
    const hw = bracketHalfPx(_t.hw, zoom);
    const hh = bracketHalfPx(_t.hh, zoom);
    fb.focusScreenX = _s.x;
    fb.focusScreenY = _s.y - hh;
    fb.focusScreenDiam = 2 * _t.r * zoom;
    fb.focusOnScreen = _s.x + hw >= 0 && _s.x - hw <= w && _s.y + hh >= 0 && _s.y - hh <= h;
  } else {
    fb.focusScreenX = NaN;
    fb.focusScreenY = NaN;
    fb.focusScreenDiam = 0;
    fb.focusOnScreen = false;
  }
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (const id of selShips) {
    if (!resolveSelectable(mirror, id, _t)) continue;
    sx += _t.x;
    sy += _t.y;
    n++;
  }
  if (n > 0) {
    camera.toScreenInto(sx / n, -sy / n, _s);
    fb.selCentroidScreenX = _s.x;
    fb.selCentroidScreenY = _s.y;
    fb.selCentroidOnScreen = _s.x >= 0 && _s.x <= w && _s.y >= 0 && _s.y <= h;
  } else {
    fb.selCentroidScreenX = NaN;
    fb.selCentroidScreenY = NaN;
    fb.selCentroidOnScreen = false;
  }
}
