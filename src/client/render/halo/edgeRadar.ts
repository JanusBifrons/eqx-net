/**
 * Pure SCREEN-space geometry for the edge-track radar (plan
 * sparkling-wondering-rose, Wave 2). Replaces the ring-radius projection.
 *
 * Rules (docs/architecture/off-screen-indicators.md §3):
 *  - icons sit on a track INSET from the screen edge, where the ray from the
 *    screen centre to the contact's projected screen point meets it — position
 *    carries DIRECTION only;
 *  - distance is carried by SIZE + OPACITY, from `d_off` = how far the contact
 *    is beyond the viewport edge (point-to-rect), log-compressed;
 *  - anything with any part on screen gets no icon (with hysteresis);
 *  - icons fade out approaching the range cutoff instead of popping;
 *  - icons slide out of HUD exclusion zones and are de-overlapped along the edge.
 *
 * All functions are allocation-free (scalars in, caller-owned `out`) — they run
 * per contact per RAF (invariant #14). No Pixi, no DOM.
 */

/** Screen rect the icon CENTRES live on (already inset). */
export interface TrackRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ExclusionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Distance from (px, py) to the axis-aligned rect [0,w]×[0,h]; 0 inside. */
export function pointViewportDistance(px: number, py: number, w: number, h: number): number {
  const dx = px < 0 ? -px : px > w ? px - w : 0;
  const dy = py < 0 ? -py : py > h ? py - h : 0;
  return dx === 0 && dy === 0 ? 0 : Math.sqrt(dx * dx + dy * dy);
}

/**
 * True iff a contact's screen-space bounding circle (centre `sx,sy`, radius
 * `rPx`) — grown by `marginPx` — touches the viewport [0,w]×[0,h]. With
 * `marginPx = 0` this is "any part visible" (→ no icon). The radar applies the
 * hysteresis margin to contacts that were on screen last frame, so a contact
 * re-appears on the radar only once it is clearly outside.
 */
export function circleTouchesViewport(
  sx: number, sy: number, rPx: number, w: number, h: number, marginPx: number,
): boolean {
  return pointViewportDistance(sx, sy, w, h) <= rPx + marginPx;
}

/** Log-compressed distance parameter in [0,1]: 0 = just off-screen, 1 = at or
 *  beyond `far` world units past the edge. Weber–Fechner (research R6). */
export function distanceT(dOffWorld: number, near: number, far: number): number {
  if (dOffWorld <= 0) return 0;
  const n = near > 0 ? near : 1;
  const t = Math.log(1 + dOffWorld / n) / Math.log(1 + far / n);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Range fade: 1 well inside range, linear ramp to 0 across the last
 *  `fadeBand` of `maxRange`, 0 beyond. */
export function rangeFade(dist: number, maxRange: number, fadeBand: number): number {
  if (dist >= maxRange) return 0;
  const band = maxRange * (fadeBand < 0 ? 0 : fadeBand > 1 ? 1 : fadeBand);
  if (band <= 0) return 1;
  const start = maxRange - band;
  if (dist <= start) return 1;
  return (maxRange - dist) / band;
}

/** Near→far interpolation shaped by `gamma`. */
export function rampNearFar(t: number, nearV: number, farV: number, gamma: number): number {
  const s = gamma === 1 ? t : Math.pow(t, gamma);
  return nearV + (farV - nearV) * s;
}

/**
 * Where the ray from the screen centre toward (sx, sy) meets `track`. Writes
 * into `out`. A contact exactly at the centre (degenerate) lands at the top of
 * the track. Direction-preserving: the icon's bearing from the centre equals
 * the contact's.
 */
export function placeOnTrack(
  sx: number, sy: number, w: number, h: number, track: TrackRect, out: ScreenPoint,
): ScreenPoint {
  const cx = w * 0.5;
  const cy = h * 0.5;
  let dx = sx - cx;
  let dy = sy - cy;
  if (dx === 0 && dy === 0) dy = -1;
  let k = Infinity;
  if (dx > 0) k = Math.min(k, (track.right - cx) / dx);
  else if (dx < 0) k = Math.min(k, (track.left - cx) / dx);
  if (dy > 0) k = Math.min(k, (track.bottom - cy) / dy);
  else if (dy < 0) k = Math.min(k, (track.top - cy) / dy);
  if (!Number.isFinite(k) || k < 0) k = 0;
  out.x = cx + dx * k;
  out.y = cy + dy * k;
  return out;
}

/** Perimeter length of the track. */
export function trackPerimeter(track: TrackRect): number {
  const w = track.right - track.left;
  const h = track.bottom - track.top;
  return 2 * (w + h);
}

/**
 * Perimeter coordinate of a point ON the track, clockwise from the top-left
 * corner: top edge [0, w), right edge [w, w+h), bottom [w+h, 2w+h), left
 * [2w+h, 2w+2h).
 */
export function trackParam(x: number, y: number, track: TrackRect): number {
  const w = track.right - track.left;
  const h = track.bottom - track.top;
  const eps = 0.5;
  if (Math.abs(y - track.top) <= eps) return x - track.left;
  if (Math.abs(x - track.right) <= eps) return w + (y - track.top);
  if (Math.abs(y - track.bottom) <= eps) return w + h + (track.right - x);
  return 2 * w + h + (track.bottom - y);
}

/** Inverse of `trackParam` (p wraps). */
export function trackPoint(p: number, track: TrackRect, out: ScreenPoint): ScreenPoint {
  const w = track.right - track.left;
  const h = track.bottom - track.top;
  const per = 2 * (w + h);
  let q = per > 0 ? p % per : 0;
  if (q < 0) q += per;
  if (q < w) { out.x = track.left + q; out.y = track.top; return out; }
  q -= w;
  if (q < h) { out.x = track.right; out.y = track.top + q; return out; }
  q -= h;
  if (q < w) { out.x = track.right - q; out.y = track.bottom; return out; }
  q -= w;
  out.x = track.left;
  out.y = track.bottom - q;
  return out;
}

/**
 * Slide a track point out of any HUD exclusion rect it falls in, ALONG the
 * track (to whichever side of the rect is closer), so the icon is never hidden
 * under a HUD widget. `pad` keeps the icon's own half-size clear. Returns the
 * (possibly) moved perimeter parameter.
 */
export function slideOutOfExclusions(
  p: number,
  track: TrackRect,
  exclusions: readonly ExclusionRect[],
  pad: number,
  scratch: ScreenPoint,
): number {
  let param = p;
  // Two passes: sliding out of one rect can land in a neighbour.
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (let i = 0; i < exclusions.length; i++) {
      const e = exclusions[i]!;
      trackPoint(param, track, scratch);
      const x0 = e.x - pad;
      const y0 = e.y - pad;
      const x1 = e.x + e.w + pad;
      const y1 = e.y + e.h + pad;
      if (scratch.x < x0 || scratch.x > x1 || scratch.y < y0 || scratch.y > y1) continue;
      // Candidate exits along the current edge direction.
      const w = track.right - track.left;
      const h = track.bottom - track.top;
      const onTop = param < w;
      const onRight = !onTop && param < w + h;
      const onBottom = !onTop && !onRight && param < 2 * w + h;
      let back: number;
      let fwd: number;
      if (onTop) { back = param - (scratch.x - x0); fwd = param + (x1 - scratch.x); }
      else if (onRight) { back = param - (scratch.y - y0); fwd = param + (y1 - scratch.y); }
      else if (onBottom) { back = param - (x1 - scratch.x); fwd = param + (scratch.x - x0); }
      else { back = param - (y1 - scratch.y); fwd = param + (scratch.y - y0); }
      param = param - back <= fwd - param ? back - 0.01 : fwd + 0.01;
      moved = true;
    }
    if (!moved) break;
  }
  return param;
}

/**
 * De-overlap icons along the track: given perimeter params `p[0..n)` and their
 * sort `order` (caller-owned scratch, filled here), push each icon forward so
 * consecutive icons are at least `minSpacing` apart — and never closer than
 * their combined half-sizes + a 2 px gap when `sizes` is given (so two icons
 * can never touch, whatever the spacing preference). Mutates `p` in place.
 * One forward sweep (good enough at the icon caps in use; no wrap fix-up).
 */
export function deOverlapAlongTrack(
  p: Float64Array, n: number, minSpacing: number, order: Int32Array, sizes?: Float64Array,
): void {
  for (let i = 0; i < n; i++) order[i] = i;
  // Insertion sort by p (n ≤ 64).
  for (let i = 1; i < n; i++) {
    const oi = order[i]!;
    const v = p[oi]!;
    let j = i - 1;
    while (j >= 0 && p[order[j]!]! > v) {
      order[j + 1] = order[j]!;
      j--;
    }
    order[j + 1] = oi;
  }
  for (let i = 1; i < n; i++) {
    const prevIdx = order[i - 1]!;
    const prev = p[prevIdx]!;
    const cur = order[i]!;
    let gap = minSpacing;
    if (sizes) {
      const touch = (sizes[prevIdx]! + sizes[cur]!) * 0.5 + 2;
      if (touch > gap) gap = touch;
    }
    if (p[cur]! < prev + gap) p[cur] = prev + gap;
  }
}
