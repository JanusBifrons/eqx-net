/**
 * Keeps the left strip clear of the top-left HUD (owner 2026-11-22 shots: a
 * tall fleet strip, centred at 57%, grew up over the mode tabs).
 *
 * The strip stays centred at 57% of the height (mock .lbar) while it fits; once
 * its top half would reach the top-left HUD it slides down to sit just under
 * it. Two measured CSS variables drive the `left-strip` anchor's `top`
 * (layout/anchors.ts): `--hud-tl-bottom` (bottom edge of the top-left anchor)
 * and `--left-strip-h` (the strip's own height). DOM-only: nothing goes in the
 * store.
 */
import { useEffect } from 'react';

const TOP_LEFT = '[data-anchor="top-left"]';
const STRIP = '[data-anchor="left-strip"]';

/** Pure: the two variable values for a top-left bottom edge and strip height (px). */
export function leftStripFitVars(topLeftBottom: number, stripHeight: number): Record<string, string> {
  return {
    '--hud-tl-bottom': `${Math.max(0, Math.round(topLeftBottom))}px`,
    '--left-strip-h': `${Math.max(0, Math.round(stripHeight))}px`,
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
      const vars = leftStripFitVars(tl?.getBoundingClientRect().bottom ?? 0, strip?.getBoundingClientRect().height ?? 0);
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
