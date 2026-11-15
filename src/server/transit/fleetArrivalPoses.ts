/**
 * RTS fleet warp — where a group of ships lands. ONE rule, shared by the
 * fleet warp (`SectorRoom.handOffHulls`, `fleetAnchor`) and the showcase cue
 * `test_fleet_warp`: the LARGEST hull (the flagship) lands on the anchor and
 * every other hull keeps its offset from it, so the formation arrives as it
 * left. Each pose is clamped to the sector bounds; the destination room then
 * nudges each hull clear of what is already there (`landingPoint`).
 *
 * Pure, no allocation beyond growing `out` (a discrete event, not a tick path).
 */
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';

/** A hull's current pose and size (its extent: hull radius + shield pad). */
export interface FleetHullPose {
  x: number;
  y: number;
  radius: number;
}

/** Where a hull lands. */
export interface FleetArrivalPose {
  x: number;
  y: number;
}

/** Index of the largest hull (first wins a tie), or -1 when there are none. */
export function largestHullIndex(hulls: ArrayLike<FleetHullPose>): number {
  let lead = -1;
  for (let i = 0; i < hulls.length; i++) {
    if (lead === -1 || hulls[i]!.radius > hulls[lead]!.radius) lead = i;
  }
  return lead;
}

function clamp(v: number): number {
  const lim = SECTOR_PLAYABLE_HALF_EXTENT;
  return v < -lim ? -lim : v > lim ? lim : v;
}

/**
 * Fill `out[i]` with where `hulls[i]` lands: the largest hull on `anchor`,
 * the others at their offsets from it, clamped to the sector bounds. `out` is
 * grown to `hulls.length` (existing entries are reused). Returns the index of
 * the largest hull, or -1 when `hulls` is empty.
 */
export function fleetArrivalPoses(
  hulls: ArrayLike<FleetHullPose>,
  anchor: { x: number; y: number },
  out: FleetArrivalPose[],
): number {
  const lead = largestHullIndex(hulls);
  if (lead === -1) return -1;
  const lx = hulls[lead]!.x, ly = hulls[lead]!.y;
  for (let i = 0; i < hulls.length; i++) {
    const h = hulls[i]!;
    let p = out[i];
    if (p === undefined) { p = { x: 0, y: 0 }; out[i] = p; }
    p.x = clamp(anchor.x + h.x - lx);
    p.y = clamp(anchor.y + h.y - ly);
  }
  return lead;
}
