/**
 * The right rail's width (UI language plan B2), one source for both sides:
 *
 *   - CSS: `RAIL_W_CSS` reads the `--rail-w` custom property set in
 *     `index.html :root` (0px until the rail mounts, U1-5).
 *   - JS:  `railWidthPx()` reads the same property as a number, for camera
 *     framing maths (`galaxyFocus`, `panelCameraNudge`).
 *
 * Pure TS, no React: safe to import from the renderer worker, where there is
 * no `document` and it reads 0.
 */

/** CSS expression for the rail width; add it to any right-edge offset. */
export const RAIL_W_CSS = 'var(--rail-w, 0px)';

/** Parse a `--rail-w` value (`"48px"`, `" 0px"`, `""`) to CSS px; junk is 0. */
export function parseRailWidth(raw: string): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Current rail width in CSS px (0 without a DOM, e.g. in the render worker). */
export function railWidthPx(): number {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return 0;
  return parseRailWidth(getComputedStyle(document.documentElement).getPropertyValue('--rail-w'));
}
