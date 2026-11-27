/**
 * Selection HUD S9: the world tag when its anchor (the focus, or the group's
 * centroid) is OFF screen. The tag sticks to that screen edge with a small
 * arrow pointing at it and the distance; tapping it glides the camera there.
 *
 * Placement reuses the edge radar's track maths (`render/halo/edgeRadar.ts`,
 * rules in docs/architecture/off-screen-indicators.md §3): the tag's CENTRE
 * rides a track inset from the screen edge by the tag's half size, at the
 * point where the ray from the screen centre to the anchor meets it, and
 * slides out of the HUD exclusion rects (`layout/radarInsets.ts`, the same
 * 2 Hz measurement the radar and the placement hints use).
 *
 * Distance and the glide target come from the renderer feedback alone (the
 * camera centre `viewX/Y` + `viewHalf`): no per-frame mirror read. In Fly the
 * camera follows the own ship with no look-ahead, so the distance is the own
 * ship's; in Command it is from the camera centre.
 *
 * Alloc-free per frame: module scratch, the blocked intervals rebuilt only
 * when the screen, the HUD or the tag's size changes.
 */
import type { RadarInsets } from '../../shared-types/settings/radar.js';
import {
  buildBlockedIntervals, placeOnTrack, resolveBlocked, trackParam, trackPerimeter, trackPoint,
  type ExclusionRect, type TrackRect,
} from '../render/halo/edgeRadar.js';

/** Screen px between the edge-stuck tag and the screen edge / a HUD widget. */
export const WORLD_TAG_EDGE_GAP_PX = 6;

/** Result scratch of {@link placeWorldTagOnEdge}: the tag's centre and the
 *  arrow's screen angle (radians, y down, 0 = pointing right). */
export const worldTagEdgeAt = { x: 0, y: 0, angle: 0 };

const _track: TrackRect = { left: 0, top: 0, right: 0, bottom: 0 };
const _pt = { x: 0, y: 0 };
const _blocked = new Float64Array(128);
let _blockedN = 0;
/** HUD rects grown by the tag's half size per axis (reused objects). */
const _grown: ExclusionRect[] = [];
let _cW = -1;
let _cH = -1;
let _cHalfW = -1;
let _cHalfH = -1;
let _cHud: RadarInsets | null = null;

function rebuildBlocked(halfW: number, halfH: number, hud: RadarInsets): void {
  const ex = hud.exclusions;
  // Grows only when the HUD gains rects (low cadence), never per frame.
  while (_grown.length < ex.length) _grown.push({ x: 0, y: 0, w: 0, h: 0 });
  _grown.length = ex.length;
  for (let i = 0; i < ex.length; i++) {
    const r = ex[i]!;
    const g = _grown[i]!;
    g.x = r.x - halfW;
    g.y = r.y - halfH;
    g.w = r.w + 2 * halfW;
    g.h = r.h + 2 * halfH;
  }
  _blockedN = buildBlockedIntervals(_track, _grown, WORLD_TAG_EDGE_GAP_PX, _blocked);
}

/**
 * Place a `2·halfW × 2·halfH` tag on the screen edge toward the off-screen
 * anchor (`ax, ay`, screen px) on a `w × h` screen with `hud` insets. Writes
 * {@link worldTagEdgeAt}; false when the anchor is not finite or the screen
 * is too small for a track.
 */
export function placeWorldTagOnEdge(
  ax: number, ay: number, w: number, h: number, halfW: number, halfH: number, hud: RadarInsets,
): boolean {
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return false;
  const g = WORLD_TAG_EDGE_GAP_PX;
  _track.left = hud.left + halfW + g;
  _track.top = hud.top + halfH + g;
  _track.right = w - hud.right - halfW - g;
  _track.bottom = h - hud.bottom - halfH - g;
  if (_track.right <= _track.left || _track.bottom <= _track.top) return false;
  if (w !== _cW || h !== _cH || halfW !== _cHalfW || halfH !== _cHalfH || hud !== _cHud) {
    _cW = w; _cH = h; _cHalfW = halfW; _cHalfH = halfH; _cHud = hud;
    rebuildBlocked(halfW, halfH, hud);
  }
  placeOnTrack(ax, ay, w, h, _track, _pt);
  if (_blockedN > 0) {
    const p = resolveBlocked(trackParam(_pt.x, _pt.y, _track), _blocked, _blockedN, trackPerimeter(_track));
    trackPoint(p, _track, _pt);
  }
  worldTagEdgeAt.x = _pt.x;
  worldTagEdgeAt.y = _pt.y;
  worldTagEdgeAt.angle = Math.atan2(ay - _pt.y, ax - _pt.x);
  return true;
}

/** World units per screen px from the feedback's `viewHalf` (the larger half
 *  of the visible world, along the screen's larger side); NaN when unknown. */
function unitsPerPx(w: number, h: number, viewHalf: number): number {
  const half = Math.max(w, h) / 2;
  return viewHalf > 0 && half > 0 ? viewHalf / half : NaN;
}

/** World distance from the camera centre to the screen point (`ax, ay`). */
export function worldTagDistance(ax: number, ay: number, w: number, h: number, viewHalf: number): number {
  return Math.hypot(ax - w / 2, ay - h / 2) * unitsPerPx(w, h, viewHalf);
}

/** The game-space point (Y up) under the screen point (`ax, ay`), from the
 *  camera centre `viewX/Y`; false when the view is unknown. */
export function worldTagWorldPoint(
  ax: number, ay: number, w: number, h: number, viewX: number, viewY: number, viewHalf: number,
  out: { x: number; y: number },
): boolean {
  const u = unitsPerPx(w, h, viewHalf);
  if (!Number.isFinite(u) || !Number.isFinite(ax) || !Number.isFinite(ay)) return false;
  out.x = viewX + (ax - w / 2) * u;
  out.y = viewY - (ay - h / 2) * u;
  return true;
}

/** The step `formatContactKm` shows a distance at (10 m, 0.1 km, 1 km), so
 *  the label is re-formatted only when its text can change (no per-frame
 *  string). */
export function distanceTextKey(d: number): number {
  if (!(d >= 0)) return -1;
  if (d < 1000) return Math.round(d / 10) * 10;
  if (d < 10_000) return Math.round(d / 100) * 100;
  return Math.round(d / 1000) * 1000;
}
