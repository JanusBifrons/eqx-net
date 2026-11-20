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
 * where it can't, it slides sideways beside the bottom stack if a side has
 * room clear of the bottom controls (sticks, boost); failing that, the top
 * band wins (the helm stays readable) and the panel overlaps the bottom band
 * as little as possible.
 *
 * Nor does it cover what is SELECTED (sideways phone ~863x390: a tall card
 * slid down over the building it described). Given the selection box
 * (`selHalf` > 0), a placement that would overlap it is replaced by the first
 * clear candidate: beside the box (right, then left), then below it. Each
 * candidate is whole on screen, below the header and passes the same HUD band
 * and control checks; when none does, the placement above stands.
 */

import { SPEED_DIAL_ACTIONS_SELECTOR, SPEED_DIAL_CLOSED_CLASS, SPEED_DIAL_CONTROLS_SELECTOR } from '../components/speedDialFit.js';

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

/** HUD control boxes (x0, y0, x1, y1 per box in `r`), `n` in use. */
export interface HudRects {
  n: number;
  r: Float64Array;
}

const MAX_RECTS = 48; // HUD controls + an open dial's buttons and labels

/** Build a HudRects from boxes (tests; not for the frame loop). */
export function hudRects(...boxes: [number, number, number, number][]): HudRects {
  const out: HudRects = { n: 0, r: new Float64Array(MAX_RECTS * 4) };
  for (const b of boxes) { out.r.set(b, out.n * 4); out.n++; }
  return out;
}

const controls: HudRects = { n: 0, r: new Float64Array(MAX_RECTS * 4) };
let controlsKey: string | null | undefined;
let controlsW = -1, controlsH = -1, controlsDial = -2;
const CONTROLS_SELECTOR = `[data-hud-exclusion], ${SPEED_DIAL_CONTROLS_SELECTOR}`;
const CLOSED_DIAL_LIST = `.${SPEED_DIAL_CLOSED_CLASS}`;

/** The speed dial's state: -1 closed or absent, else its open action count. */
function dialState(): number {
  const list = document.querySelector(SPEED_DIAL_ACTIONS_SELECTOR);
  return !list || list.classList.contains(SPEED_DIAL_CLOSED_CLASS) ? -1 : list.childElementCount;
}

/**
 * The HUD controls the inspector may slide beside: `[data-hud-exclusion]`
 * (sticks, boost, capsule, chips) and the speed dial's buttons AND label pills
 * (Build menu "Back", "Core", ...), skipping the parked closed list. The
 * sticks sit on CSS transforms, so this needs DOMRects: it re-measures only
 * when `key` (the selected id), the viewport size or the dial (open / action
 * count) changes, never every frame (#14). Returns a module scratch.
 */
export function hudControlsFor(key: string | null, viewW: number, viewH: number): HudRects {
  const dial = dialState();
  if (key === controlsKey && viewW === controlsW && viewH === controlsH && dial === controlsDial) return controls;
  controlsKey = key; controlsW = viewW; controlsH = viewH; controlsDial = dial; controls.n = 0;
  const els = document.querySelectorAll(CONTROLS_SELECTOR);
  for (let i = 0; i < els.length && controls.n < MAX_RECTS; i++) {
    if (els[i]!.closest(CLOSED_DIAL_LIST)) continue;
    const b = els[i]!.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    const o = controls.n++ * 4;
    controls.r[o] = b.left; controls.r[o + 1] = b.top; controls.r[o + 2] = b.right; controls.r[o + 3] = b.bottom;
  }
  return controls;
}

/** True when the box [x0, y0, x1, y1] overlaps no control. */
function clearOf(c: HudRects, x0: number, y0: number, x1: number, y1: number): boolean {
  for (let i = 0; i < c.n; i++) {
    const o = i * 4;
    if (x0 < c.r[o + 2]! && x1 > c.r[o]! && y0 < c.r[o + 3]! && y1 > c.r[o + 1]!) return false;
  }
  return true;
}

/** Slide the panel (anchor out.top) beside the bottom band, nearer side first. */
function slideBeside(
  out: InspectorAnchor, ssx: number, half: number, panelH: number, viewW: number,
  bottom: HudBand, c: HudRects, topBand: HudBand | undefined,
): boolean {
  const l = bottom.left - INSPECTOR_EDGE - half, r = bottom.right + INSPECTOR_EDGE + half;
  const first = Math.abs(ssx - l) <= Math.abs(ssx - r) ? l : r;
  for (let k = 0; k < 2; k++) {
    const x = k === 0 ? first : first === l ? r : l;
    if (x - half < INSPECTOR_EDGE || x + half > viewW - INSPECTOR_EDGE) continue;
    if (under(topBand, x, half) && out.top - panelH < topBand.bottom + INSPECTOR_EDGE) continue;
    if (!clearOf(c, x - half, out.top - panelH, x + half, out.top)) continue;
    out.left = x;
    return true;
  }
  return false;
}

/**
 * Put the panel centred at `x` with its bottom as near `pref` as the room
 * between `lo` and the screen allows, clear of both HUD bands and the
 * controls. False (out untouched) when it can't.
 */
function tryClearAt(
  out: InspectorAnchor, x: number, half: number, lo: number, pref: number, panelH: number,
  viewW: number, viewH: number, topBand: HudBand | undefined, bottomBand: HudBand | undefined, c: HudRects | undefined,
): boolean {
  if (x - half < INSPECTOR_EDGE || x + half > viewW - INSPECTOR_EDGE) return false;
  let min = Math.max(lo, INSPECTOR_TOP_MIN + panelH);
  if (under(topBand, x, half)) min = Math.max(min, topBand.bottom + INSPECTOR_EDGE + panelH);
  let max = viewH - INSPECTOR_EDGE;
  if (under(bottomBand, x, half)) max = Math.min(max, bottomBand.top - INSPECTOR_EDGE);
  if (min > max) return false;
  const y = Math.max(min, Math.min(max, pref));
  if (c && !clearOf(c, x - half, y - panelH, x + half, y)) return false;
  out.left = x; out.top = y;
  return true;
}

/**
 * The panel (bottom-centre anchor) for a target at (`ssx`, `ssy`). With
 * `selHalf` > 0 that point is the top-centre of the selection box, which
 * spans `ssx ± selHalf`, `ssy .. ssy + 2·selHalf`, and the panel keeps
 * clear of it (see the file comment).
 */
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
  hudControls?: HudRects,
  selHalf = 0,
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
  // Over the bottom band: bottom above it if it fits between the bands, else
  // beside the stack if a side has room, else never at the top band's cost.
  const fit = bottomBand ? bottomBand.top - INSPECTOR_EDGE : maxY;
  if (minY <= maxY && under(bottomBand, out.left, half) && out.top > fit) {
    if (minY <= fit) out.top = fit;
    else if (!hudControls || !slideBeside(out, ssx, half, panelH, viewW, bottomBand, hudControls, topBand)) out.top = minY;
  }
  if (!(selHalf > 0)) return out;
  // Clear of the selection box already (above it, or beside/below it)?
  const bx0 = ssx - selHalf, bx1 = ssx + selHalf, by1 = ssy + 2 * selHalf;
  if (out.left + half <= bx0 || out.left - half >= bx1 || out.top <= ssy || out.top - panelH >= by1) return out;
  const centre = ssy + selHalf + panelH / 2;
  const right = Math.max(INSPECTOR_EDGE, bx1 + INSPECTOR_GAP) + half;
  const left = Math.min(viewW - INSPECTOR_EDGE, bx0 - INSPECTOR_GAP) - half;
  const below = Math.max(INSPECTOR_TOP_MIN, by1 + INSPECTOR_GAP) + panelH;
  if (tryClearAt(out, right, half, -Infinity, centre, panelH, viewW, viewH, topBand, bottomBand, hudControls)) return out;
  if (tryClearAt(out, left, half, -Infinity, centre, panelH, viewW, viewH, topBand, bottomBand, hudControls)) return out;
  const belowX = minX > maxX ? viewW / 2 : Math.max(minX, Math.min(maxX, ssx));
  tryClearAt(out, belowX, half, below, below, panelH, viewW, viewH, topBand, bottomBand, hudControls);
  return out; // nothing clear fits: the placement above stands
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
