/**
 * In-sector warp-to (plan prancy-squishing-donut Phase 4, step 4): spool,
 * then a fast straight run to a chosen point (a pocket's rim), then drop out.
 *
 * Driven by the INPUT stream (`ShipInput.warpX/warpY`): the server worker and
 * the client prediction run the same inputs through this same machine, so
 * both sides warp on the same ticks (invariants #4 / #12). Pure: it decides,
 * `World.applyInput` applies the physics.
 *
 *  - idle   → a request starts the SPOOL (normal flight continues);
 *  - spool  → after WARP_SPOOL_TICKS, CRUISE begins; dropping the request
 *             first cancels it. A ship that already got there under its own
 *             engines (`warpReached`: at the point, or past it along the line
 *             from where the spool began) ends the warp where it is instead;
 *  - cruise → a straight run at WARP_SPEED toward the target, controls and
 *             collisions off; it can't be cancelled. When the target is within
 *             one tick it DROPS out there at WARP_EXIT_SPEED.
 *
 * After a drop the same target is latched: a held input still asking for it
 * (the worker re-applies held input) does not warp again until the request
 * changes or is cleared.
 */

/** Spool time before the run (ticks at 60 Hz): 3 s. */
export const WARP_SPOOL_TICKS = 180;
/** Cruise speed (u/s): 150 km in ~7.5 s. */
export const WARP_SPEED = 20_000;
/** Speed on dropping out (u/s), along the run's direction. */
export const WARP_EXIT_SPEED = 150;
/** While spooling the ship turns to face its target: turn rate (rad/s) per
 *  radian off, capped at the kind's turn rate (warpActuator.ts alignToWarp). */
export const WARP_ALIGN_GAIN = 8;

/** A ship engages only once within this of facing its target (rad), pilot
 *  and NPC alike. */
export const WARP_ALIGN_RAD = 0.06;
/** The slowest a spooling ship turns to face its jump (rad/s; 9°/s, so a
 *  battleship comes about in ~20 s instead of 2.5 min at its 1.2°/s helm). */
export const WARP_MIN_TURN = Math.PI / 20;

/** A ship this close to its warp point when the spool is up is there: one
 *  tick of the run (u). */
export const WARP_ARRIVE_RADIUS = WARP_SPEED / 60;

/**
 * Did a spooling ship at (x, y) already get to its point (tx, ty) under its own
 * engines: within `WARP_ARRIVE_RADIUS`, or past it along the line from where
 * the spool began (`s.sx`, `s.sy`)? Then the warp is over where the ship is:
 * a short hop (the picker's near side, 1–3 km) flown at speed overshoots, or
 * circles a point inside its turning circle that it can't face while it still
 * thrusts, and the align hold kept the spool for ever (smoke test 2026-11-21).
 * "Past" has no distance cap on purpose: a ship circling the point crosses
 * that line within a lap, which is what makes every short warp end (a cap
 * brought the endless circles back for a fast hull on boost). A long jump
 * never gets past its point by flying, so it is untouched. Pure, no alloc.
 */
export function warpReached(s: WarpState, x: number, y: number, tx: number, ty: number): boolean {
  const ex = tx - x, ey = ty - y;
  return ex * ex + ey * ey <= WARP_ARRIVE_RADIUS * WARP_ARRIVE_RADIUS || ex * (tx - s.sx) + ey * (ty - s.sy) <= 0;
}

/** Has a spool run its time with the hull still more than `WARP_ALIGN_RAD`
 *  off (tx, ty)? Then it keeps spooling: engaging early snapped a slow hull
 *  round in one tick. Never once the ship got there (`warpReached`): that
 *  warp ends. Nose = (-sin θ, cos θ). Pure; World pilot + bot paths. */
export function spoolHeldForAlign(s: WarpState, x: number, y: number, rot: number, tx: number, ty: number): boolean {
  if (s.phase !== 'spool' || s.ticks < WARP_SPOOL_TICKS - 1) return false;
  if (warpReached(s, x, y, tx, ty)) return false;
  const off = Math.atan2(-(tx - x), ty - y) - rot;
  return Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) > WARP_ALIGN_RAD;
}

export type WarpPhase = 'idle' | 'spool' | 'cruise';

export interface WarpState {
  phase: WarpPhase;
  /** Ticks spent in the current phase. */
  ticks: number;
  tx: number;
  ty: number;
  /** Where the spool began (or last restarted): the line `warpReached` reads. */
  sx: number;
  sy: number;
  /** Unit direction of the run (set when cruise starts). */
  dx: number;
  dy: number;
  /** The last target arrived at: ignored until the request changes. */
  latched: boolean;
  lx: number;
  ly: number;
}

export function newWarpState(): WarpState {
  return { phase: 'idle', ticks: 0, tx: 0, ty: 0, sx: 0, sy: 0, dx: 0, dy: 0, latched: false, lx: 0, ly: 0 };
}

/** What `World.applyInput` does this tick. */
export type WarpAction =
  | 'fly'      // normal flight (idle or spooling)
  | 'engage'   // cruise starts: face (dx, dy), velocity WARP_SPEED, collisions off
  | 'cruise'   // keep the run: velocity WARP_SPEED along (dx, dy)
  | 'drop'     // arrive: position = target, velocity WARP_EXIT_SPEED, collisions on
  | 'arrive';  // got there under its own engines during the spool: over, latched, flies on

/**
 * Advance one tick. `req` is this tick's input request (null = none); (x, y)
 * the ship's position before the step; `dt` the step (s). Mutates `s`.
 */
export function stepWarp(s: WarpState, req: { x: number; y: number } | null, x: number, y: number, dt: number): WarpAction {
  if (s.latched && (req === null || req.x !== s.lx || req.y !== s.ly)) s.latched = false;
  switch (s.phase) {
    case 'idle': {
      if (req === null || s.latched) return 'fly';
      s.phase = 'spool';
      s.ticks = 0;
      s.tx = req.x;
      s.ty = req.y;
      s.sx = x;
      s.sy = y;
      return 'fly';
    }
    case 'spool': {
      if (req === null) { s.phase = 'idle'; s.ticks = 0; return 'fly'; }
      if (req.x !== s.tx || req.y !== s.ty) { s.tx = req.x; s.ty = req.y; s.sx = x; s.sy = y; s.ticks = 0; return 'fly'; } // retarget restarts
      s.ticks++;
      if (s.ticks < WARP_SPOOL_TICKS) return 'fly';
      if (warpReached(s, x, y, s.tx, s.ty)) { finish(s); return 'arrive'; } // got there on its own engines
      const ex = s.tx - x, ey = s.ty - y, len = Math.hypot(ex, ey);
      s.dx = ex / len;
      s.dy = ey / len;
      s.phase = 'cruise';
      s.ticks = 0;
      return 'engage';
    }
    case 'cruise': {
      s.ticks++;
      const ex = s.tx - x, ey = s.ty - y;
      // Arrived when within one tick's run, or past the target along the run.
      if (Math.hypot(ex, ey) <= WARP_SPEED * dt || ex * s.dx + ey * s.dy <= 0) { finish(s); return 'drop'; }
      return 'cruise';
    }
  }
}

function finish(s: WarpState): void {
  s.phase = 'idle';
  s.ticks = 0;
  s.latched = true;
  s.lx = s.tx;
  s.ly = s.ty;
}
