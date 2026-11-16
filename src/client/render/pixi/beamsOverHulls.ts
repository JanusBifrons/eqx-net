/**
 * Beams draw over the hull that fires them (owner, mining-barge clip: the
 * mining lasers and tractor line passed UNDER the hull instead of leaving
 * from the dishes on top). Ship / drone / projectile sprites are appended to
 * `shipContainer` at spawn, so they always land above the fixed fx layers
 * added at init; a zIndex on the beam layers keeps them above every hull
 * (and its turret barrels, which are children of the hull sprite) no matter
 * when the hull spawns. Everything else keeps zIndex 0 and its add order
 * (Pixi's sort is stable).
 */
import type { Container } from 'pixi.js';

/** zIndex of every beam layer: above all hulls (zIndex 0). */
export const BEAMS_OVER_HULL_Z = 1;
/** zIndex of the vaporise flash: above the beams that made the kill. */
export const VAPORISE_OVER_BEAMS_Z = 2;

/** A beam sprite pool's two layers (`BeamSpritePool`). */
interface BeamPoolLayers { readonly container: Container; readonly styledContainer: Container }

/** Lifts `layers` and both layers of each of `pools` (children of `ships`;
 *  null entries skipped) above every hull. Call once at init. */
export function raiseBeamsOverHulls(
  ships: Container, layers: ReadonlyArray<Container | null | undefined>, pools: ReadonlyArray<BeamPoolLayers | null | undefined> = [],
): void {
  ships.sortableChildren = true;
  for (const l of layers) if (l) l.zIndex = BEAMS_OVER_HULL_Z;
  for (const p of pools) if (p) { p.container.zIndex = BEAMS_OVER_HULL_Z; p.styledContainer.zIndex = BEAMS_OVER_HULL_Z; }
}
