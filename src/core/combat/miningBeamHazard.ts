/**
 * Mining-beam player hazard (Equinox Round 2 WS-4 Phase 3 / R2.27).
 *
 * The Miner's mining beam is a VISIBLE aimable beam (broadcast on `laser_fired`)
 * that, per the accepted asteroid-interaction-model ADR, lightly damages a
 * player who flies into its path. It is a thin DAMAGE RAY — a point-to-segment
 * test against each player ship — NOT a physics collider: it never blocks
 * movement, it just stings.
 *
 * Pure + allocation-free (scalar in/out) — safe on the structure tick path.
 */
import { rayHitsSphere } from './Weapons.js';

/** A solid circle the mining beam can stop against (a built structure). */
export interface MiningBeamObstacle {
  x: number;
  y: number;
  radius: number;
}

/**
 * P1b — resolve where a Miner's mining beam ENDS. Like a real laser it stops at
 * the first solid thing along the miner→asteroid line:
 *   - the asteroid SURFACE (`centre − radius`) by default, so the beam CUTS at the
 *     point of impact instead of plunging to the asteroid centre;
 *   - SOONER if an obstacle (a built structure, the miner excluded by the caller)
 *     intersects the ray first — the beam stops at that building (`blocked`),
 *     instead of shooting through it, and a blocked beam mines no ore.
 * Returns the clipped endpoint + whether an obstacle blocked it. Pure scalar.
 */
export function resolveMiningBeamEndpoint(
  minerX: number, minerY: number,
  astX: number, astY: number, astRadius: number,
  obstacles: Iterable<MiningBeamObstacle>,
): { x: number; y: number; blocked: boolean } {
  const dx = astX - minerX;
  const dy = astY - minerY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-3) return { x: astX, y: astY, blocked: false };
  const dirX = dx / dist;
  const dirY = dy / dist;
  let clip = Math.max(0, dist - astRadius); // asteroid surface (cut at impact)
  let blocked = false;
  for (const o of obstacles) {
    const hit = rayHitsSphere(minerX, minerY, dirX, dirY, clip, o.x, o.y, o.radius);
    if (hit !== null && hit < clip) {
      clip = hit;
      blocked = true;
    }
  }
  return { x: minerX + dirX * clip, y: minerY + dirY * clip, blocked };
}

/** Gentle damage-per-second a mining beam deals to a player in its path. Per
 *  the ADR (resolved decision #2) ~1–2 HP/tick-equivalent — a hazard, not a
 *  kill. The per-broadcast chip is `DPS × (MINING_BEAM_CADENCE_MS / 1000)`.
 *  Smoke-tune knob. */
export const MINING_BEAM_PLAYER_DPS = 1.5;

/** Half-width (game units) of the mining beam's damage ray. A ship whose centre
 *  is within `shipRadius + MINING_BEAM_HALF_WIDTH` of the beam segment is "in
 *  the beam". A small fraction of the rendered beam so it reads as a thin line.
 *  Smoke-tune knob. */
export const MINING_BEAM_HALF_WIDTH = 8;

/** Shortest distance from point (px,py) to the segment (ax,ay)-(bx,by).
 *  Zero-length segment (a==b) degrades to point-to-point. Scalar, alloc-free. */
export function distancePointToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const ab2 = abx * abx + aby * aby;
  let t = ab2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / ab2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  return Math.hypot(dx, dy);
}

/** True when a ship of radius `shipRadius` centred at (px,py) intersects the
 *  mining beam segment (ax,ay)-(bx,by) widened by `beamHalfWidth`. */
export function playerInMiningBeam(
  ax: number, ay: number,
  bx: number, by: number,
  px: number, py: number,
  shipRadius: number,
  beamHalfWidth: number,
): boolean {
  return distancePointToSegment(px, py, ax, ay, bx, by) <= shipRadius + beamHalfWidth;
}
