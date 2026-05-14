import { type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLayout } from './useLayout';
import type { AnchorName } from './anchors';

interface Props {
  anchor: AnchorName;
  /**
   * CSS `order` for this slot within its anchor's flex container. Lower =
   * earlier in the anchor's flow direction. Defaults to 10 so siblings can
   * interleave with explicit values 1..9 (above) or 11+ (below) without
   * fighting each other. Ignored for fullscreen-style anchors.
   */
  order?: number;
  /**
   * Override the wrapper's `pointer-events`. Defaults to `'auto'` (the
   * historical Slot behaviour: anchor hosts default to `pointer-events:
   * none` so empty regions pass through, and Slot re-enables auto on
   * its own wrapper for its children).
   *
   * Set to `'none'` on full-screen overlays that need to be transparent
   * to taps (e.g. `<WarpScreen>` when its visual is faded out — the
   * Slot's `fullscreen` host covers the entire viewport, so a stale
   * `pointer-events: auto` wrapper intercepts every tap before it
   * reaches the gameplay canvas or HUD beneath). Lock test:
   * `tests/e2e/join-warp-screen.spec.ts` "UI is interactive after warp hides".
   */
  pointerEvents?: 'auto' | 'none';
  children: ReactNode;
}

/** Anchors whose contents should fill the entire host (vs. flex-stack). */
const FILL_ANCHORS = new Set<AnchorName>(['fullscreen', 'transit']);

/**
 * Portals its children into the host element registered for `anchor` by
 * `LayoutProvider`. The wrapper:
 *   - Re-enables pointer events (anchor hosts default to pointer-events:none
 *     so empty regions pass clicks through to the Pixi canvas).
 *   - Carries the `order` so multiple slots in the same anchor stack
 *     deterministically across components.
 *   - For fullscreen/transit anchors, fills the host via absolute
 *     positioning so overlays cover the screen automatically.
 *
 * If the anchor host hasn't mounted yet (first paint, StrictMode) the slot
 * renders nothing.
 */
export function Slot({ anchor, order = 10, pointerEvents = 'auto', children }: Props): JSX.Element | null {
  const elements = useLayout();
  const host = elements[anchor];
  if (!host) return null;
  const fill = FILL_ANCHORS.has(anchor);
  const style: CSSProperties = fill
    ? { position: 'absolute', inset: 0, pointerEvents }
    : { pointerEvents, order };
  return createPortal(<div style={style}>{children}</div>, host);
}
