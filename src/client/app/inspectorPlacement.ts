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
 *
 * It also never covers the centre HUD slot stacks (the top one: helm row,
 * lock band, warnings; the bottom one: the status capsule). A panel
 * horizontally under the top band keeps its top below it (live still,
 * sideways Pixel 7: "Refinery" drawn over the helm Stop button); one over the
 * bottom band keeps its bottom above it where it fits between the two, and
 * where it can't, the top band wins (the helm stays readable) and the panel
 * overlaps the bottom band as little as possible.
 */

/** Below this, the panel's top would be under the app header. */
export const INSPECTOR_TOP_MIN = 56;
/** Gap kept from the viewport's other edges. */
export const INSPECTOR_EDGE = 8;

export interface InspectorAnchor {
  left: number;
  top: number;
}

/** A centre HUD stack's screen box. bottom <= 0 = nothing shown there. */
export interface HudBand {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const TOP_CENTER = '[data-anchor="top-center"]';
const BOTTOM_CENTER = '[data-anchor="bottom-center"]';

/**
 * Measure a visible centre slot stack into `out` from its real Slot host.
 * Called every frame, so it reads offset* (no DOMRect allocation, #14) and
 * only counts children with a size: empty Slot wrappers and the stack gap
 * between them are ignored. Both hosts are fixed, centred with
 * translateX(-50%), and centre their children.
 */
function measureBand(selector: string, out: HudBand): HudBand {
  out.left = 0; out.right = 0; out.top = 0; out.bottom = 0;
  const host = document.querySelector(selector) as HTMLElement | null;
  if (!host) return out;
  let top = Infinity, bottom = 0, half = 0;
  const kids = host.children;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i] as HTMLElement;
    if (c.offsetHeight < 1 || c.offsetWidth < 1) continue;
    top = Math.min(top, c.offsetTop);
    bottom = Math.max(bottom, c.offsetTop + c.offsetHeight);
    half = Math.max(half, c.offsetWidth / 2);
  }
  if (bottom <= 0) return out;
  const mid = window.innerWidth / 2;
  out.left = mid - half; out.right = mid + half;
  out.top = host.offsetTop + top; out.bottom = host.offsetTop + bottom;
  return out;
}

export const measureTopHudBand = (out: HudBand): HudBand => measureBand(TOP_CENTER, out);
export const measureBottomHudBand = (out: HudBand): HudBand => measureBand(BOTTOM_CENTER, out);

/** True when a panel centred at `left`, `half` wide each side, sits under the band. */
function under(band: HudBand | undefined, left: number, half: number): band is HudBand {
  return !!band && band.bottom > 0 && left + half > band.left && left - half < band.right;
}

export function placeInspector(
  ssx: number,
  ssy: number,
  panelW: number,
  panelH: number,
  viewW: number,
  viewH: number,
  out: InspectorAnchor,
  topBand?: HudBand,
  bottomBand?: HudBand,
): InspectorAnchor {
  const half = panelW / 2;
  const minX = INSPECTOR_EDGE + half;
  const maxX = viewW - INSPECTOR_EDGE - half;
  out.left = minX > maxX ? viewW / 2 : Math.max(minX, Math.min(maxX, ssx));
  let topMin = INSPECTOR_TOP_MIN;
  if (under(topBand, out.left, half)) topMin = Math.max(topMin, topBand.bottom + INSPECTOR_EDGE);
  const minY = topMin + panelH;
  const maxY = viewH - INSPECTOR_EDGE;
  out.top = minY > maxY ? maxY : Math.max(minY, Math.min(maxY, ssy));
  // Over the bottom band: bottom above it, but never at the top band's cost.
  if (minY <= maxY && under(bottomBand, out.left, half)) {
    out.top = Math.max(minY, Math.min(out.top, bottomBand.top - INSPECTOR_EDGE));
  }
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
  topBand?: HudBand,
  bottomBand?: HudBand,
): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(top)) return false;
  placeInspector(left, top, panelW, panelH, viewW, viewH, out, topBand, bottomBand);
  return Math.abs(out.left - left) > 0.5 || Math.abs(out.top - top) > 0.5;
}
