/**
 * Where the world-anchored inspector (EntityStatsPanel) sits on screen. The
 * panel's anchor is its BOTTOM-CENTRE (`translate(-50%, -100%)`), so the
 * anchor is clamped by the panel's own size: the whole panel stays inside the
 * viewport, below the app header. A target off screen (or near an edge) used
 * to push half the panel out of view, where its buttons couldn't be clicked
 * (v4 T1, found by tests/e2e/teleporter.spec.ts; the header case by
 * tests/e2e/break-in.spec.ts).
 *
 * The panel never covers what is selected. It goes above the selection box
 * when it fits there; else beside it (right, then left), centred on it and
 * clamped on screen; else below it. Only when none of those fit (a panel
 * taller than the whole view) is it clamped over the selection, its BOTTOM
 * (the action rows) kept on screen. A sideways phone (~863x390) is where the
 * above slot usually runs out. Pure and alloc-free, so it is unit-tested.
 */

/** Below this, the panel's top would be under the app header. */
export const INSPECTOR_TOP_MIN = 56;
/** Gap kept from the viewport's other edges. */
export const INSPECTOR_EDGE = 8;
/** Gap kept between the panel and the selection box when beside or below it. */
export const INSPECTOR_GAP = 6;

export interface InspectorAnchor {
  left: number;
  top: number;
}

/** Clamp a bottom-centre anchor so the whole panel is on screen. */
function clampInspector(
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

/**
 * Place the panel for a selection whose bracket box has its top-centre at
 * (`ssx`, `ssy`) and is `selHalf` px half-size (so it spans
 * `ssx ± selHalf`, `ssy .. ssy + 2·selHalf`). `selHalf` ≤ 0 (unknown) keeps
 * the plain clamp above the point.
 */
export function placeInspector(
  ssx: number,
  ssy: number,
  selHalf: number,
  panelW: number,
  panelH: number,
  viewW: number,
  viewH: number,
  out: InspectorAnchor,
): InspectorAnchor {
  clampInspector(ssx, ssy, panelW, panelH, viewW, viewH, out);
  if (!(selHalf > 0)) return out;
  const minBottom = INSPECTOR_TOP_MIN + panelH;
  const maxBottom = viewH - INSPECTOR_EDGE;
  // Above: the clamped bottom is at or above the box top, so it is clear.
  if (out.top <= ssy) return out;
  if (minBottom <= maxBottom) {
    // Beside: vertically centred on the box, clamped on screen.
    const centreBottom = ssy + selHalf + panelH / 2;
    const sideBottom = Math.max(minBottom, Math.min(maxBottom, centreBottom));
    const rightEdge = Math.max(INSPECTOR_EDGE, ssx + selHalf + INSPECTOR_GAP);
    if (rightEdge + panelW <= viewW - INSPECTOR_EDGE) {
      out.left = rightEdge + panelW / 2;
      out.top = sideBottom;
      return out;
    }
    const leftEdge = Math.min(viewW - INSPECTOR_EDGE, ssx - selHalf - INSPECTOR_GAP);
    if (leftEdge - panelW >= INSPECTOR_EDGE) {
      out.left = leftEdge - panelW / 2;
      out.top = sideBottom;
      return out;
    }
    // Below: the panel's top just under the box bottom.
    const belowBottom = Math.max(INSPECTOR_TOP_MIN, ssy + 2 * selHalf + INSPECTOR_GAP) + panelH;
    if (belowBottom <= maxBottom) {
      out.top = belowBottom;
      return out;
    }
  }
  // Nothing clear fits: the plain clamp (already in `out`).
  return out;
}

/**
 * A HELD panel (a pointer is on it: inspectorHold.ts) keeps its spot so taps
 * land, but if it grew (a loot window opening) the whole panel is clamped
 * back on screen. `left`/`top` are its current anchor (NaN = never placed:
 * leave it). Writes `out`; true when it must move.
 */
export function reclampHeldInspector(
  left: number,
  top: number,
  panelW: number,
  panelH: number,
  viewW: number,
  viewH: number,
  out: InspectorAnchor,
): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(top)) return false;
  clampInspector(left, top, panelW, panelH, viewW, viewH, out);
  return Math.abs(out.left - left) > 0.5 || Math.abs(out.top - top) > 0.5;
}
