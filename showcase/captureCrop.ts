/**
 * Screencast crop. Chrome sometimes reports a capture surface bigger than
 * the page (a 844×390 phone page at 2× DPR came back as 1688×780 frames
 * with the page painted into the top-left quarter, the rest black). The
 * frame metadata says how big that surface is; when it is wider or taller
 * than the page, the encode crops every frame back to the page's area.
 */

export interface CaptureCrop {
  /** Width and height (frame pixels) of the page area at the frame's top left. */
  w: number;
  h: number;
}

/** The crop for a take, from its first frame's metadata, or null when the frame is the page. */
export function captureCrop(
  meta: { deviceWidth: number; deviceHeight: number },
  page: { width: number; height: number },
  cap: { maxWidth: number; maxHeight: number },
): CaptureCrop | null {
  if (meta.deviceWidth <= page.width + 1 && meta.deviceHeight <= page.height + 1) return null;
  // The screencast scales the surface down to fit its cap; the page area shrinks with it.
  const k = Math.min(1, cap.maxWidth / meta.deviceWidth, cap.maxHeight / meta.deviceHeight);
  return { w: Math.round(page.width * k), h: Math.round(page.height * k) };
}

/** The ffmpeg filter step for a take's crop ('' when none), placed first in the chain. */
export function cropFilter(crop: CaptureCrop | null | undefined): string {
  return crop ? `crop=${crop.w}:${crop.h}:0:0,` : '';
}
