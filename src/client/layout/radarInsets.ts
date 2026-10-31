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

/** Edge anchors only — the `fullscreen` / `transit` overlay hosts cover the
 *  whole screen and must never become exclusions. */
const EDGE_ANCHORS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
] as const;

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
      const r = child.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const style = getComputedStyle(child);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
      exclusions.push({
        x: Math.round(r.left - origin.left),
        y: Math.round(r.top - origin.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
  }
  return { top: Math.max(0, appBarHeightPx() - origin.top), right: 0, bottom: 0, left: 0, exclusions };
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
