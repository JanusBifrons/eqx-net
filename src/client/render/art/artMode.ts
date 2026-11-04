/**
 * Machined art — which look the renderer draws.
 *
 * `?art=machined` turns the Machined look on, `?art=classic` keeps today's
 * vector look. The default is `classic` until the rollout PR flips it.
 * Pure, so the worker (which has no `window`) gets the same answer from the
 * search string the main thread passes it.
 */
export type ArtMode = 'classic' | 'machined';

export const DEFAULT_ART_MODE: ArtMode = 'classic';

export function readArtMode(search: string, fallback: ArtMode = DEFAULT_ART_MODE): ArtMode {
  const m = /[?&]art=(classic|machined)\b/.exec(search);
  return m ? (m[1] as ArtMode) : fallback;
}

/** Test-only: delay every bake by this many ms (`?artDelayMs=`), so an E2E can
 *  watch a sprite start in the fallback look and swap once its art is ready. */
export function readArtDelayMs(search: string): number {
  const m = /[?&]artDelayMs=(\d{1,6})\b/.exec(search);
  return m ? Number(m[1]) : 0;
}
