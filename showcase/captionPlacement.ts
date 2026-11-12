/**
 * Where the lower-third caption sits (review 2026-11-12). In a spectator take
 * the game shows its build bar along the bottom of the screen; the caption sat
 * on top of it and both were hard to read. The game UI is filmed as it is
 * (record as is), so the CAPTION moves: the recorder measures the bottom HUD's
 * top edge during the take, and the caption's box ends above it.
 */

/** Output frame (the clip is 1920×1080). */
const OUT_W = 1920;
const OUT_H = 1080;

/** The lower-third's CSS `bottom` with no bottom HUD (pilot mode). */
export const CAPTION_DEFAULT_BOTTOM = 72;
/** Gap between the caption's box and the HUD's top edge. */
export const CAPTION_HUD_MARGIN = 16;

/**
 * A HUD edge measured in the capture's CSS viewport, mapped into the output
 * frame the way the compositor scales a desktop take (fit inside, centred).
 */
export function hudTopInFrame(topCss: number, viewport: { width: number; height: number }): number {
  const scale = Math.min(OUT_W / viewport.width, OUT_H / viewport.height);
  const padY = (OUT_H - viewport.height * scale) / 2;
  return padY + topCss * scale;
}

/**
 * CSS `bottom` (output px) of the lower-third caption box: the default place,
 * or higher so the box ends `CAPTION_HUD_MARGIN` above the bottom HUD's top
 * edge (`hudTopY`, output px; null = no bottom HUD).
 */
export function captionBottomPx(hudTopY: number | null): number {
  if (hudTopY === null) return CAPTION_DEFAULT_BOTTOM;
  return Math.max(CAPTION_DEFAULT_BOTTOM, Math.ceil(OUT_H - hudTopY + CAPTION_HUD_MARGIN));
}
