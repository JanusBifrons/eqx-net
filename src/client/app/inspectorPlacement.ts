/**
 * Where the world-anchored inspector (EntityStatsPanel) sits on screen. The
 * panel is drawn CENTRED above its anchor (`translate(-50%, -100%)`), so the
 * anchor is clamped by the panel's own size: the whole panel stays inside the
 * viewport, below the app header. A target off screen (or near an edge) used
 * to push half the panel out of view, where its buttons couldn't be clicked
 * (v4 T1, found by tests/e2e/teleporter.spec.ts; the header case by
 * tests/e2e/break-in.spec.ts).
 *
 * When the panel is taller than the room below the header, its BOTTOM (the
 * action rows) stays on screen. Pure, so it is unit-tested.
 */

/** Below this, the panel's top would be under the app header. */
export const INSPECTOR_TOP_MIN = 56;
/** Gap kept from the viewport's other edges. */
export const INSPECTOR_EDGE = 8;

export interface InspectorAnchor {
  left: number;
  top: number;
}

export function placeInspector(
  ssx: number,
  ssy: number,
  panelW: number,
  panelH: number,
  viewW: number,
  viewH: number,
  out: InspectorAnchor,
): InspectorAnchor {
  const half = panelW / 2;
  const minX = INSPECTOR_EDGE + half;
  const maxX = viewW - INSPECTOR_EDGE - half;
  out.left = minX > maxX ? viewW / 2 : Math.max(minX, Math.min(maxX, ssx));
  const minY = INSPECTOR_TOP_MIN + panelH;
  const maxY = viewH - INSPECTOR_EDGE;
  out.top = minY > maxY ? maxY : Math.max(minY, Math.min(maxY, ssy));
  return out;
}
