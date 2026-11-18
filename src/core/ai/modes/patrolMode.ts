/**
 * Patrol (peacetime jobs `JOB_COURSE` and `JOB_ORBIT`): what a ship with no
 * order flies.
 *
 * Course (Roaming-formation, Phase 5): the director assigned a move target
 * (formation slot / squad destination / a leader's course): fly to it and
 * slow to a stop there through the brain's shared fly-to, instead of the
 * origin orbit. This is how a roaming squad flies in formation toward an
 * arbitrary A→B destination.
 *
 * Orbit: idle behaviour, orbit the sector centre (0, 0) counter-clockwise at
 * `PATROL_RADIUS`. When the drone is outside the radius an inward bias is
 * blended into the desired heading so drones spiral back toward the orbit
 * instead of diverging (the structural fix for the "drone drifted to
 * (4 133 782, -1 093 669) over a long session" bug). Flown through the
 * virtual pilot at a slow patrol speed.
 */
import { shipTuning } from '../../../shared-types/shipScale/tuning.js';
import { CALM_CRUISE_FRAC, PATROL_INWARD_GAIN, PATROL_RADIUS, PATROL_SPEED_FRAC } from '../hostileDroneTuning.js';
import { DEFAULT_PILOT_PARAMS, facingOf } from '../virtualPilot.js';
import {
  JOB_COURSE,
  MODE_GOAL_FLY,
  MODE_GOAL_MOVE_TO,
  type IPilotMode,
  type PilotModeContext,
  type PilotModeGoal,
  type PilotOrderModes,
} from '../tactics/manoeuvre.js';

export class PatrolMode implements IPilotMode {
  /** Roaming-formation (Phase 5): the in-sector point the director wants this
   *  drone to fly to while IDLE (its formation slot / the squad destination for
   *  the leader). `null` ⇒ default origin orbit. Server-only — set via the
   *  brain's `setMoveTarget`; the client never ticks the drone brain. */
  moveTarget: { x: number; y: number } | null = null;
  /** True when this drone is a flock LEADER cruising a course (set by
   *  `setFlockLeaderCourse`, cleared by `setMoveTarget`/`setFlockFollow`). While
   *  set, the fly-to (`pilot/moveTo.ts`) throttles forward thrust by
   *  `LEADER_CRUISE_THROTTLE` so the leader travels slower than its
   *  full-cruise followers and they tighten into the herd. A plain
   *  `setMoveTarget` (lone drone / tests) is full-thrust. */
  leaderCruise = false;

  /** Set the course (`setMoveTarget` / `setFlockLeaderCourse`): it clears any
   *  FOLLOWER role (the ship leads / moves independently now). */
  setCourse(x: number, y: number, leaderCruise: boolean, o: PilotOrderModes): void {
    o.flock.leaderId = null;
    this.leaderCruise = leaderCruise;
    if (this.moveTarget === null) this.moveTarget = { x, y };
    else { this.moveTarget.x = x; this.moveTarget.y = y; }
  }

  /** Drop the course and any follower role (`clearMoveTarget`). */
  clearCourse(o: PilotOrderModes): void {
    this.moveTarget = null;
    o.flock.leaderId = null;
    this.leaderCruise = false;
  }

  begin(_ctx: PilotModeContext): void {}

  writeGoal(ctx: PilotModeContext, out: PilotModeGoal): void {
    const self = ctx.self;
    out.params = DEFAULT_PILOT_PARAMS;
    const mt = ctx.moveTarget;
    if (ctx.job === JOB_COURSE && mt !== null) {
      // Holding a post (slice 9): inside the arrive radius of it the ship
      // stays where it is and only brakes. With the nose kept (the fly-to
      // close in) a few units off the exact point to the side could never be
      // closed: it tapped forward and back across it every second.
      if (ctx.guardOn && mt.x === ctx.guardX && mt.y === ctx.guardY) {
        const dx = mt.x - self.x;
        const dy = mt.y - self.y;
        const r = shipTuning(ctx.kind).wingmanArrive;
        if (dx * dx + dy * dy <= r * r) {
          out.kind = MODE_GOAL_FLY;
          out.facing = self.angle;
          out.vx = 0;
          out.vy = 0;
          out.boost = false;
          return;
        }
      }
      out.kind = MODE_GOAL_MOVE_TO;
      out.tx = mt.x;
      out.ty = mt.y;
      out.cruiseCap = -1;
      out.boost = false;
      return;
    }
    const r = Math.hypot(self.x, self.y);
    const safeR = Math.max(r, 1);

    // Tangent to the circle around origin (counter-clockwise: rotate the
    // outward-radial vector by +90°). At (x, y), the unit radial is
    // (x, y)/r and its CCW perpendicular is (-y, x)/r.
    let dirX = -self.y / safeR;
    let dirY = self.x / safeR;

    // Inward bias: outside the radius, blend the heading toward the origin
    // so the drone spirals back. Clamped to [0, 1] at 2× the patrol radius.
    if (r > PATROL_RADIUS) {
      const overshoot = (r - PATROL_RADIUS) / PATROL_RADIUS;
      const bias = Math.min(1, overshoot * PATROL_INWARD_GAIN);
      dirX = dirX * (1 - bias) + (-self.x / safeR) * bias;
      dirY = dirY * (1 - bias) + (-self.y / safeR) * bias;
      const len = Math.hypot(dirX, dirY);
      if (len > 1e-6) { dirX /= len; dirY /= len; }
    }

    const speed = ctx.handling.cruiseSpeed * CALM_CRUISE_FRAC * PATROL_SPEED_FRAC;
    out.kind = MODE_GOAL_FLY;
    out.facing = facingOf(dirX, dirY);
    out.vx = dirX * speed;
    out.vy = dirY * speed;
    out.boost = false;
  }

  isDone(_ctx: PilotModeContext): boolean {
    return false;
  }
}
