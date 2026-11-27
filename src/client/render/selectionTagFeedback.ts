import type { RendererFeedback } from '@core/contracts/IRenderer';

/**
 * The selection-HUD world tag fields of `RendererFeedback` (S6a): their
 * initial values and the worker FEEDBACK copy. Pixi-free, so the main-thread
 * `WorkerRendererClient` imports it without the renderer; the per-frame
 * projection is `writeSelectionTag` (`selectionTag.ts`).
 */

/** The `RendererFeedback` fields the world tag owns. */
export type SelectionTagFeedback = Pick<RendererFeedback,
  'focusScreenX' | 'focusScreenY' | 'focusOnScreen' | 'focusScreenDiam'
  | 'selCentroidScreenX' | 'selCentroidScreenY' | 'selCentroidOnScreen'>;

/** Initial (nothing selected) values, spread into a fresh feedback struct. */
export function selectionTagFeedbackInit(): SelectionTagFeedback {
  return {
    focusScreenX: NaN, focusScreenY: NaN, focusOnScreen: false, focusScreenDiam: 0,
    selCentroidScreenX: NaN, selCentroidScreenY: NaN, selCentroidOnScreen: false,
  };
}

/** Copy the tag fields (worker FEEDBACK → main-thread feedback). */
export function copySelectionTagFeedback(dst: SelectionTagFeedback, src: SelectionTagFeedback): void {
  dst.focusScreenX = src.focusScreenX;
  dst.focusScreenY = src.focusScreenY;
  dst.focusOnScreen = src.focusOnScreen;
  dst.focusScreenDiam = src.focusScreenDiam;
  dst.selCentroidScreenX = src.selCentroidScreenX;
  dst.selCentroidScreenY = src.selCentroidScreenY;
  dst.selCentroidOnScreen = src.selCentroidOnScreen;
}
