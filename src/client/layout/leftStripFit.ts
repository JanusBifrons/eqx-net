/**
 * Keeps the left strip clear of the top-left HUD and on screen (owner
 * 2026-11-22 shots: a tall fleet strip, centred at 57%, grew up over the mode
 * tabs; an 8-icon strip on a sideways phone ran ⚙ and ✕ off the bottom).
 *
 * - The strip stays centred at 57% of the height (mock .lbar) while it fits;
 *   once its top half would reach the top-left HUD it slides down to sit just
 *   under it.
 * - When even that leaves it too tall for the space under the HUD, the whole
 *   strip scales down to fit (never below `MIN_STRIP_SCALE`), so every icon,
 *   ⚙ and ✕ included, stays reachable.
 *
 * Measured CSS variables drive the `left-strip` anchor (layout/anchors.ts):
 * `--hud-tl-bottom` (bottom edge of the top-left anchor), `--left-strip-h`
 * (the strip's height after scaling) and `--left-strip-scale`. The natural
 * height is read from `offsetHeight` (layout size, ignores the transform) so
 * the scale never feeds back into itself. DOM-only: nothing goes in the store.
 */
import { useEffect } from 'react';

const TOP_LEFT = '[data-anchor="top-left"]';
const STRIP = '[data-anchor="left-strip"]';
/** Gap kept under the top-left HUD and above the bottom edge (px). */
export const STRIP_EDGE_GAP = 8;
/** The strip never shrinks below this; past it the bottom may clip. */
export const MIN_STRIP_SCALE = 0.7;

/**
 * Pure: the anchor variables for a top-left bottom edge, the strip's natural
 * (unscaled) height and the viewport height, all px.
 */
export function leftStripFitVars(topLeftBottom: number, naturalHeight: number, viewportHeight: number): Record<string, string> {
  const hud = Math.max(0, Math.round(topLeftBottom));
  const natural = Math.max(0, naturalHeight);
  const room = viewportHeight - hud - 2 * STRIP_EDGE_GAP;
  const scale = natural > 0 && room > 0 && natural > room ? Math.max(MIN_STRIP_SCALE, room / natural) : 1;
  return {
    '--hud-tl-bottom': `${hud}px`,
    '--left-strip-h': `${Math.round(natural * scale)}px`,
    '--left-strip-scale': `${Math.round(scale * 1000) / 1000}`,
  };
}

/** Measures the top-left HUD and the strip while `active`, writing the vars on :root. */
export function useLeftStripFit(active: boolean): void {
  useEffect(() => {
    if (!active || typeof ResizeObserver === 'undefined') return undefined;
    const tl = document.querySelector<HTMLElement>(TOP_LEFT);
    const strip = document.querySelector<HTMLElement>(STRIP);
    const root = document.documentElement.style;
    const write = (): void => {
      const vars = leftStripFitVars(tl?.getBoundingClientRect().bottom ?? 0, strip?.offsetHeight ?? 0, window.innerHeight);
      for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    };
    const ro = new ResizeObserver(write);
    if (tl) ro.observe(tl);
    if (strip) ro.observe(strip);
    window.addEventListener('resize', write);
    write();
    return () => { ro.disconnect(); window.removeEventListener('resize', write); };
  }, [active]);
}
