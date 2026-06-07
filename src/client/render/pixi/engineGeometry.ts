/**
 * Per-kind engine-exhaust geometry — pure, derived from the ship catalogue.
 *
 * The legacy engine emitter spawned every ship's exhaust a flat 25 u behind
 * the hull CENTRE — roughly twice the rear extent of a fighter (rear edge at
 * local y=10), so the plume detached from the hull. This derives the nozzle
 * offset from each kind's actual rear extent (the polygon's max +y × scale,
 * matching where `buildThrustFlameGfx` anchors the legacy flame) so the
 * exhaust emerges AT the engine, and a per-kind plume-size multiplier so a
 * heavy chassis throws a fatter plume than a scout.
 *
 * No new catalogue field, no `SHIP_KINDS_LIST` reorder, no
 * `SHIP_KIND_CATALOGUE_VERSION` bump (that version tracks stored-ship stat
 * drift; a render-only derived offset is not a stored stat). Pure ⇒
 * unit-locked (`engineGeometry.test.ts`), computed once per emitter
 * REGISTRATION (not per frame), so it never touches the hot loop.
 */

import { getShipKind, DEFAULT_SHIP_KIND } from '../../../shared-types/shipKinds';

export interface EngineProfile {
  /** Distance behind ship centre (game units), along the astern direction,
   *  to the engine nozzle. Derived from the hull's rear extent. */
  sternOffset: number;
  /** Plume-size multiplier relative to the default (fighter) chassis — scales
   *  nozzle width, particle size, and emit density so bigger ships throw
   *  bigger plumes. ~0.83 for a scout, > 1 for heavy/gunship. */
  plumeScale: number;
}

/** Reference hull radius (the default fighter) that `plumeScale` is relative to. */
const REFERENCE_RADIUS = getShipKind(DEFAULT_SHIP_KIND).radius;

export function engineProfileForKind(kindId: string | null | undefined): EngineProfile {
  const kind = getShipKind(kindId);
  // Rear extent = the polygon's largest +y (nose is at -y; stern at +y),
  // scaled by the shape's draw scale.
  let rearExtent = 0;
  for (const pt of kind.shape.points) {
    if (pt[1] > rearExtent) rearExtent = pt[1];
  }
  rearExtent *= kind.shape.scale;
  const sternOffset = rearExtent > 0 ? rearExtent : kind.radius;
  const plumeScale = kind.radius / REFERENCE_RADIUS;
  return { sternOffset, plumeScale };
}
