/**
 * Guard return (peacetime job `JOB_GUARD`): a ship with a guard post and
 * nothing to fight flies back to the post through the brain's shared fly-to
 * (calm cruise, no boost) and holds there. An anchored post has already been
 * moved onto its anchor's live pose this tick (`followGuardAnchor`).
 */
import { MODE_GOAL_MOVE_TO, type IPilotMode, type PilotModeContext, type PilotModeGoal } from '../tactics/manoeuvre.js';

export class GuardReturnMode implements IPilotMode {
  begin(_ctx: PilotModeContext): void {}

  writeGoal(ctx: PilotModeContext, out: PilotModeGoal): void {
    out.kind = MODE_GOAL_MOVE_TO;
    out.tx = ctx.guardX;
    out.ty = ctx.guardY;
    out.cruiseCap = -1;
    out.boost = false;
  }

  /** Open-ended: the post is held until a setter clears it. */
  isDone(_ctx: PilotModeContext): boolean {
    return false;
  }
}
