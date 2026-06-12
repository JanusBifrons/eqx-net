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
