/**
 * Measure the HUD geometry the off-screen radar must keep clear of (plan
 * sparkling-wondering-rose, research R7 — indicators must not hide under HUD).
 *
 * The radar is drawn on the canvas UNDER the DOM HUD, and the renderer may live
 * in a worker with no DOM — so the main thread measures the visible widgets in
 * the layout slot hosts (joystick, FIRE/BOOST/speed-dial, top chips, drawer
 * toggle, …) and pushes them as exclusion rects (canvas-relative CSS px). Safe
 * areas are covered implicitly: the slot hosts already pad for them.
 */
import type { RadarInsets } from '../../shared-types/settings/radar.js';
import { ANCHOR_NAMES, type AnchorName } from './anchors.js';

/** Full-screen overlay hosts: they cover the whole screen and must never
 *  become exclusions. */
const OVERLAY_ANCHORS: ReadonlySet<AnchorName> = new Set<AnchorName>(['fullscreen', 'transit', 'rotate']);

/** The right rail is a full-height band on the right edge: it insets the
 *  radar's right track (the track runs just inside it) rather than blocking
 *  the whole right side as an exclusion. */
const RAIL_ANCHOR: AnchorName = 'right-rail';

/** Every other anchor is HUD the radar keeps clear of — derived from
 *  ANCHOR_NAMES so a new anchor (the left strip, CI 2026-11-22) can never be
 *  missed by a hand-kept list. */
const EDGE_ANCHORS: readonly AnchorName[] = ANCHOR_NAMES.filter(
  (n) => !OVERLAY_ANCHORS.has(n) && n !== RAIL_ANCHOR,
);

function isShown(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const style = getComputedStyle(el);
  return !(style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0');
}

/** CSS px the right rail takes off the surface's right edge (0 when hidden). */
function railInsetPx(origin: DOMRect): number {
  const host = document.querySelector(`[data-anchor="${RAIL_ANCHOR}"]`);
  if (!host) return 0;
  let left = Infinity;
  for (const child of Array.from(host.children)) {
    if (!isShown(child)) continue;
    left = Math.min(left, child.getBoundingClientRect().left);
  }
  return Number.isFinite(left) ? Math.max(0, Math.round(origin.right - left)) : 0;
}

function appBarHeightPx(): number {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--app-bar-h').trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Measure exclusion rects relative to `surface` (the game surface element whose
 * size the renderer uses as its screen). Pure DOM read; call at low cadence.
 */
export function measureRadarInsets(surface: Element): RadarInsets {
  const origin = surface.getBoundingClientRect();
  const exclusions: RadarInsets['exclusions'] = [];
  for (const name of EDGE_ANCHORS) {
    const host = document.querySelector(`[data-anchor="${name}"]`);
    if (!host) continue;
    for (const child of Array.from(host.children)) {
      if (!isShown(child)) continue;
      const r = child.getBoundingClientRect();
      exclusions.push({
        x: Math.round(r.left - origin.left),
        y: Math.round(r.top - origin.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
  }
  // Experimental HUD controls that live OUTSIDE the slot hosts (floating stick
  // home rings, the fire/attack clusters) opt in with `data-hud-exclusion`.
  // Elements already inside an anchor host were measured above — skip them.
  for (const el of Array.from(document.querySelectorAll('[data-hud-exclusion]'))) {
    if (el.closest('[data-anchor]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    exclusions.push({
      x: Math.round(r.left - origin.left),
      y: Math.round(r.top - origin.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  return { top: Math.max(0, appBarHeightPx() - origin.top), right: railInsetPx(origin), bottom: 0, left: 0, exclusions };
}

/** Change detection so the renderer (possibly a worker) is only messaged when
 *  the HUD layout actually moved. */
export function radarInsetsEqual(a: RadarInsets | null, b: RadarInsets): boolean {
  if (a === null) return false;
  if (a.top !== b.top || a.right !== b.right || a.bottom !== b.bottom || a.left !== b.left) return false;
  if (a.exclusions.length !== b.exclusions.length) return false;
  for (let i = 0; i < a.exclusions.length; i++) {
    const p = a.exclusions[i]!;
    const q = b.exclusions[i]!;
    if (p.x !== q.x || p.y !== q.y || p.w !== q.w || p.h !== q.h) return false;
  }
  return true;
}
