/**
 * Where a crane bay's clamp grips a parked ship (structure-restyle bug fix):
 * on the hull's edge facing the crane, not on the ship's centre.
 *
 * The clamp head is lifted over every hull (`over` layer) and is bigger than
 * a small hull: aimed at the ship's centre, its wrist hub and body sat right
 * on top of the ship and hid it for the whole hold. Gripping the hull where
 * the line from the crane pivot first meets it puts the hub on the edge, the
 * jaws reaching onto the hull, and keeps the ship being unloaded in view.
 *
 * Pure, host-frame (the bay's structure frame, y-up): the server turns the
 * result into the targeted clip's target, so every side poses the same arm.
 */
import { shipRayHit } from '../combat/shipHitShape.js';
import type { CraneBay } from './rigCatalogue.js';

/**
 * The grip point on a ship of `kindId` whose centre is at host-frame
 * (lx, ly), heading `la` (host frame, rad), served by `bay`: the first
 * contact of the ray from the crane pivot toward the ship's centre with its
 * hull (the hull polygon, never a shield bubble: the clamp grips metal).
 * Falls back to the centre when the ray finds no hull (the pivot inside it).
 * Writes `out` and returns it; allocation-free.
 */
export function craneGripPoint<T extends { x: number; y: number }>(
  bay: CraneBay, lx: number, ly: number, la: number, kindId: string | null | undefined, out: T,
): T {
  const px = bay.pivotX, py = bay.pivotY;
  const dist = Math.hypot(lx - px, ly - py);
  out.x = lx;
  out.y = ly;
  if (dist < 1e-6) return out;
  const dx = (lx - px) / dist, dy = (ly - py) / dist;
  const t = shipRayHit(kindId, false, px, py, dx, dy, dist, lx, ly, la);
  if (t === null || t <= 0) return out;
  out.x = px + dx * t;
  out.y = py + dy * t;
  return out;
}
