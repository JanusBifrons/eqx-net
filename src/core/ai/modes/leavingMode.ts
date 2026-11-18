/**
 * Leaving (peacetime job `JOB_LEAVING`): asked to warp out, the ship runs on
 * along the escape line while the room spools the warp, as a pilot's ship
 * flies on through its spool (take 7: it eased to the calm cruise and looked
 * parked, then vanished). Full speed, boosting while the reserve allows (the
 * spool's drive keeps the nose on the warp heading). Lasts
 * `LEAVING_RUN_TICKS` from the warp-out request.
 *
 * Also writes the warp-out request itself (`requestWarp`, Flee's end).
 */
import type { AiEntity, AiIntent } from '../../contracts/IAiBehaviour.js';
import { BOOST_RESERVE_FRAC, LEAVING_RUN_TICKS, RUN_PILOT_PARAMS } from '../hostileDroneTuning.js';
import { MODE_GOAL_FLY, type IPilotMode, type PilotModeContext, type PilotModeGoal } from '../tactics/manoeuvre.js';

export class LeavingMode implements IPilotMode {
  /** Last tick of the run; -1 = not leaving (the brain's `pilotJob()` reads it). */
  until = -1;
  /** Warp-outs requested (test-visible). */
  warpOuts = 0;
  /** Reused warp-out request (attached on the one tick it is asked). */
  private readonly warp = { x: 0, y: 0 };

  /** Ask the server to warp out `dist` along the escape heading
   *  (`intent.warpOut`, no shot this tick); returns the drop point. */
  requestWarp(self: AiEntity, escapeX: number, escapeY: number, dist: number, intent: AiIntent): { x: number; y: number } {
    const w = this.warp;
    w.x = self.x + escapeX * dist;
    w.y = self.y + escapeY * dist;
    intent.warpOut = w;
    intent.fire = undefined;
    this.warpOuts++;
    return w;
  }

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
