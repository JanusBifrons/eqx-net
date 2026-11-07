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
 *             first cancels it;
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

export type WarpPhase = 'idle' | 'spool' | 'cruise';

export interface WarpState {
  phase: WarpPhase;
  /** Ticks spent in the current phase. */
  ticks: number;
  tx: number;
  ty: number;
  /** Unit direction of the run (set when cruise starts). */
  dx: number;
  dy: number;
  /** The last target arrived at: ignored until the request changes. */
  latched: boolean;
  lx: number;
  ly: number;
}

export function newWarpState(): WarpState {
  return { phase: 'idle', ticks: 0, tx: 0, ty: 0, dx: 0, dy: 0, latched: false, lx: 0, ly: 0 };
}

/** What `World.applyInput` does this tick. */
export type WarpAction =
  | 'fly'      // normal flight (idle or spooling)
  | 'engage'   // cruise starts: face (dx, dy), velocity WARP_SPEED, collisions off
  | 'cruise'   // keep the run: velocity WARP_SPEED along (dx, dy)
  | 'drop';    // arrive: position = target, velocity WARP_EXIT_SPEED, collisions on

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
      return 'fly';
    }
    case 'spool': {
      if (req === null) { s.phase = 'idle'; s.ticks = 0; return 'fly'; }
      if (req.x !== s.tx || req.y !== s.ty) { s.tx = req.x; s.ty = req.y; s.ticks = 0; return 'fly'; } // retarget restarts
      s.ticks++;
      if (s.ticks < WARP_SPOOL_TICKS) return 'fly';
      const ex = s.tx - x, ey = s.ty - y, len = Math.hypot(ex, ey);
      if (len <= WARP_SPEED * dt) { finish(s); return 'drop'; } // already there
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
