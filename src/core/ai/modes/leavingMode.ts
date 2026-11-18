/**
 * Leaving (peacetime job `JOB_LEAVING`): asked to warp out, the ship runs on
 * along the escape line while the room spools the warp, as a pilot's ship
 * flies on through its spool (take 7: it eased to the calm cruise and looked
 * parked, then vanished). Full speed, boosting while the reserve allows (the
 * spool's drive keeps the nose on the warp heading). Lasts
 * `LEAVING_RUN_TICKS` from the warp-out request.
 */
import { BOOST_RESERVE_FRAC, LEAVING_RUN_TICKS, RUN_PILOT_PARAMS } from '../hostileDroneTuning.js';
import { MODE_GOAL_FLY, type IPilotMode, type PilotModeContext, type PilotModeGoal } from '../tactics/manoeuvre.js';

export class LeavingMode implements IPilotMode {
  /** Last tick of the run; -1 = not leaving (the brain's `pilotJob()` reads it). */
  until = -1;

  begin(ctx: PilotModeContext): void {
    this.until = ctx.tick + LEAVING_RUN_TICKS;
  }

  writeGoal(ctx: PilotModeContext, out: PilotModeGoal): void {
    const v = ctx.handling.maxSpeed;
    out.kind = MODE_GOAL_FLY;
    out.facing = Math.atan2(-ctx.escapeX, ctx.escapeY);
    out.vx = ctx.escapeX * v;
    out.vy = ctx.escapeY * v;
    out.boost = ctx.energy >= BOOST_RESERVE_FRAC * ctx.energyMax;
    out.params = RUN_PILOT_PARAMS;
  }

  isDone(ctx: PilotModeContext): boolean {
    return ctx.tick > this.until;
  }
}
