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
 * (the strip's height after scaling) and `--left-strip-scale`. It also writes
 * `--left-strip-w` (the strip's drawn width plus the edge gap, 0 while no strip
 * shows) so the `middle-left` / `middle-left-over` anchors (the warp spool bar) sits beside the strip,
 * never under it (CI 2026-11-22: the strip's ✕ took the spool's Abort click). The natural
 * height is read from `offsetHeight` (layout size, ignores the transform) so
 * the scale never feeds back into itself. The who-hex column (`left-column`
 * anchor, under the top-left HUD) gets the same fit (`--left-column-scale`)
 * and its reach joins `--left-strip-w`. DOM-only: nothing goes in the store.
 */
import { useEffect } from 'react';

const TOP_LEFT = '[data-anchor="top-left"]';
const STRIP = '[data-anchor="left-strip"]';
const COLUMN = '[data-anchor="left-column"]';
/** Gap kept under the top-left HUD and above the bottom edge (px). */
export const STRIP_EDGE_GAP = 8;
/** The strip never shrinks below this; past it the bottom may clip. */
export const MIN_STRIP_SCALE = 0.7;

/**
 * Pure: the anchor variables for a top-left bottom edge, the strip's natural
 * (unscaled) height, the viewport height and the strip's natural width, all px.
 */
export function leftStripFitVars(topLeftBottom: number, naturalHeight: number, viewportHeight: number, naturalWidth = 0): Record<string, string> {
  const hud = Math.max(0, Math.round(topLeftBottom));
  const natural = Math.max(0, naturalHeight);
  const scale = fitScale(hud, natural, viewportHeight);
  return {
    '--hud-tl-bottom': `${hud}px`,
    '--left-strip-h': `${Math.round(natural * scale)}px`,
    '--left-strip-scale': `${Math.round(scale * 1000) / 1000}`,
    '--left-strip-w': naturalWidth > 0 ? `${Math.round(naturalWidth * scale) + STRIP_EDGE_GAP}px` : '0px',
  };
}

/** The scale that fits `natural` px under a HUD ending at `hud` px (1 when it fits). */
function fitScale(hud: number, natural: number, viewportHeight: number): number {
  const room = viewportHeight - hud - 2 * STRIP_EDGE_GAP;
  return natural > 0 && room > 0 && natural > room ? Math.max(MIN_STRIP_SCALE, room / natural) : 1;
}

/**
 * Pure: the who-hex column's fit (the `left-column` anchor, 8px under the
 * top-left HUD, `left` px from the screen edge). Returns its scale var and how
 * far right it reaches after scaling, plus the gap (0 while empty), which joins
 * `--left-strip-w` so the spool bar clears the column too.
 */
export function leftColumnFit(topLeftBottom: number, naturalHeight: number, viewportHeight: number, left: number, naturalWidth: number): { vars: Record<string, string>; reach: number } {
  const scale = fitScale(Math.max(0, Math.round(topLeftBottom)), Math.max(0, naturalHeight), viewportHeight);
  return {
    vars: { '--left-column-scale': `${Math.round(scale * 1000) / 1000}` },
    reach: naturalWidth > 0 ? Math.round(left + naturalWidth * scale) + STRIP_EDGE_GAP : 0,
  };
}

/** Measures the top-left HUD, the strip and the who-hex column while `active`, writing the vars on :root. */
export function useLeftStripFit(active: boolean): void {
  useEffect(() => {
    if (!active || typeof ResizeObserver === 'undefined') return undefined;
    const tl = document.querySelector<HTMLElement>(TOP_LEFT);
    const strip = document.querySelector<HTMLElement>(STRIP);
    const column = document.querySelector<HTMLElement>(COLUMN);
    const root = document.documentElement.style;
    const write = (): void => {
      const hud = tl?.getBoundingClientRect().bottom ?? 0;
      const vars = leftStripFitVars(hud, strip?.offsetHeight ?? 0, window.innerHeight, strip?.offsetWidth ?? 0);
      const col = leftColumnFit(hud, column?.offsetHeight ?? 0, window.innerHeight, column?.getBoundingClientRect().left ?? 0, column?.offsetWidth ?? 0);
      const w = Math.max(parseFloat(vars['--left-strip-w'] ?? '0'), col.reach);
      Object.assign(vars, col.vars, { '--left-strip-w': `${w}px` });
      for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    };
    const ro = new ResizeObserver(write);
    if (tl) ro.observe(tl);
    if (strip) ro.observe(strip);
    if (column) ro.observe(column);
    window.addEventListener('resize', write);
    write();
    return () => { ro.disconnect(); window.removeEventListener('resize', write); root.setProperty('--left-strip-w', '0px'); };
  }, [active]);
}
