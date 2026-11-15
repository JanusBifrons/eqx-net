/**
 * One tractor field from one mount (salvage plan PR 11b): the server's lease
 * (`ForceFieldSubsystem`) and the client's prediction world
 * (`client/net/tractorLinks.ts`) both build their `TractorForceField` here,
 * so the two sides run the same pull (#15). Allocation-free.
 */
import type { TractorForceField } from '../physics/forceFields.js';
import type { WeaponMount } from '../../shared-types/shipKinds.js';
import { MOUNT_SIZE_TUNING } from '../../shared-types/shipScale/tuning.js';
import { getWeapon } from './WeaponCatalogue.js';
import { mountWeaponReach } from './mountReach.js';
import { shipCollisionParts } from '../geometry/shipHullDecomp.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

/**
 * The per-mount constants of `f` from the mount's tractor weapon: force ×
 * the mount size's power, reach, the falloff, cushion and beam-line numbers.
 * Returns false (and leaves `f` alone) when the mount carries no tractor.
 */
export function setTractorMountConstants(
  f: TractorForceField, mount: Pick<WeaponMount, 'weaponId' | 'size'>,
): boolean {
  const spec = getWeapon(mount.weaponId).tractor;
  if (spec === undefined) return false;
  f.force = spec.force * MOUNT_SIZE_TUNING[mount.size ?? 'S'].power;
  f.reach = mountWeaponReach(mount);
  f.dRef = spec.dRef;
  f.hold = spec.hold;
  f.lineHalfWidth = spec.lineHalfWidth;
  f.lineFrac = spec.lineFrac;
  return true;
}

/** The field's muzzle (`mx`, `my`): the mount's world origin on an emitter
 *  at (x, y) facing `angle`. */
export function setTractorMuzzle(
  f: TractorForceField, x: number, y: number, angle: number, mount: Pick<WeaponMount, 'localX' | 'localY'>,
): void {
  const c = Math.cos(angle), s = Math.sin(angle);
  f.mx = x + (mount.localX * c - mount.localY * s);
  f.my = y + (mount.localX * s + mount.localY * c);
}

/**
 * The cushion for this pull (`f.hold`): the weapon's `hold`, or more when the
 * emitter's hull reaches further from the muzzle along the line to the load,
 * so a load of radius `loadRadius` hovering there never touches the hull:
 * hold ≥ muzzle-to-hull clearance + the load's radius. The clearance is where
 * the line muzzle → load (tx, ty) last leaves the emitter's hull
 * (`shipCollisionParts`, its collider). Call after `setTractorMountConstants`
 * and `setTractorMuzzle`; both sides run it each time they pose the field
 * (#15). Allocation-free.
 */
export function setTractorHold(
  f: TractorForceField, mount: Pick<WeaponMount, 'weaponId' | 'localX' | 'localY'>,
  emitterKindId: string | null | undefined, angle: number, tx: number, ty: number, loadRadius: number,
): void {
  const spec = getWeapon(mount.weaponId).tractor;
  if (spec === undefined) return;
  f.hold = spec.hold;
  const dx = tx - f.mx, dy = ty - f.my;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (!(d > 0)) return;
  // The line in the emitter's local frame (the mount's and the collider's).
  const c = Math.cos(-angle), s = Math.sin(-angle);
  const ux = (dx * c - dy * s) / d, uy = (dx * s + dy * c) / d;
  const need = holdPastHull(shipCollisionParts(emitterKindId), mount.localX, mount.localY, ux, uy, loadRadius);
  if (need > f.hold) f.hold = need;
}

/**
 * The least distance along the ray from local (px, py) in direction (ux, uy)
 * at which a circle of radius `r` on the ray is clear of every CCW convex
 * part it crosses: where the ray leaves the part, plus `r` over the cosine of
 * the exit edge's angle to the ray (capped at 2r, a grazing exit), so the
 * circle clears that edge, not just its centre. 0 when it crosses none. Each
 * part is slab-clipped as in `rayHitsConvexPolygon`.
 */
function holdPastHull(
  parts: ReadonlyArray<ReadonlyArray<Vec2>>, px: number, py: number, ux: number, uy: number, r: number,
): number {
  let best = 0;
  for (let p = 0; p < parts.length; p++) {
    const poly = parts[p]!;
    const n = poly.length;
    if (n < 3) continue;
    let tIn = 0, tOut = Infinity, cosOut = 1;
    for (let i = 0; i < n && tIn <= tOut; i++) {
      const a = poly[i]!, b = poly[i + 1 < n ? i + 1 : 0]!;
      const nx = b.y - a.y, ny = -(b.x - a.x); // outward normal (CCW)
      const denom = ux * nx + uy * ny;
      const numer = (px - a.x) * nx + (py - a.y) * ny;
      if (denom === 0) { if (numer > 0) tOut = -1; continue; }
      const t = -numer / denom;
      if (denom < 0) { if (t > tIn) tIn = t; } else if (t < tOut) { tOut = t; cosOut = denom / Math.sqrt(nx * nx + ny * ny); }
    }
    if (!(tIn <= tOut) || tOut === Infinity || tOut <= 0) continue;
    const need = tOut + r / Math.max(cosOut, 0.5);
    if (need > best) best = need;
  }
  return best;
}
