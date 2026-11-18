/**
 * Join flow stage 3 — baked ship pictures for ship cards (the Hangar).
 *
 * `pnpm ships:portraits` renders each hull in the art lab's `portrait` scene
 * (machined art) and writes `public/ships/<kind>.webp`, committed so a phone's
 * first paint needs no bake. Cards show the picture; the vector outline
 * (`shipShapeSvg`) stays where a vector is needed (map markers).
 */
import { PLAYABLE_SHIP_KINDS_LIST } from '../../../shared-types/shipKinds.js';
import { sizeClassOf } from '../../../shared-types/shipScale/tuning.js';

/** Every hull a pilot can fly (engineering-only test hulls excluded). */
export const PORTRAIT_KINDS: readonly string[] = PLAYABLE_SHIP_KINDS_LIST
  .filter((k) => !k.engineeringOnly)
  .map((k) => k.id);

const HAS = new Set(PORTRAIT_KINDS);

/** Capitals render small in the art lab: zoom in, and no engine glow. */
export function portraitFraming(kind: string): { zm: number; th: number } {
  const k = PLAYABLE_SHIP_KINDS_LIST.find((s) => s.id === kind);
  return k && sizeClassOf(k) === 'capital' ? { zm: 2.5, th: 0 } : { zm: 1, th: 0.6 };
}

/** The baked picture's URL for `kind`, or null when there is none. */
export function shipPortraitUrl(kind: string): string | null {
  return HAS.has(kind) ? `/ships/${kind}.webp` : null;
}
