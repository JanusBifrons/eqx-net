/**
 * Guard return (peacetime job `JOB_GUARD`): a ship with a guard post and
 * nothing to fight flies back to the post through the brain's shared fly-to
 * (calm cruise, no boost) and holds there. An anchored post has already been
 * moved onto its anchor's live pose this tick (`followAnchor`).
 *
 * Holds the guard post itself (set by the brain's `setGuardPost`): plain
 * fields, no object, so set / clear never allocates (#14).
 */
import type { AiEntityPoseOut, AiWorldView } from '../../contracts/IAiBehaviour.js';
import { TRAVEL_NONE } from '../hostileDroneTuning.js';
import {
  MODE_GOAL_MOVE_TO, type IPilotMode, type PilotModeContext, type PilotModeGoal, type PilotOrderModes,
} from '../tactics/manoeuvre.js';

export class GuardReturnMode implements IPilotMode {
  /** Guard post (server-only, set by a director via `setGuardPost`): a
   *  broadside capital with a post fights FROM it instead of holding the
   *  stand-off (which under real naval ranges is ~29 km away from what it
   *  guards). Every other ship takes it as a LEASH on its target pick (RTS
   *  Part B slice 5, `guardLeash`). */
  on = false;
  x = 0;
  y = 0;
  r = 0;
  /** The ship the guard post follows (owner 2026-11-15, flagship escorts:
   *  "the zone follows the flagship"); null ⇒ a fixed post. Resolved each
   *  tick into `anchorPose` (`followAnchor`). */
  anchorId: string | null = null;
  private readonly anchorPose: AiEntityPoseOut = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

  /** Take a post (`setGuardPost`): radius `r` already floored by the brain.
   *  A post is a hold: it ends a hunt and a travel. */
  post(x: number, y: number, r: number, anchorId: string | null, o: PilotOrderModes): void {
    this.on = true;
    this.anchorId = anchorId;
    this.x = x;
    this.y = y;
    this.r = r;
    o.search.on = false;
    o.travel.state = TRAVEL_NONE;
  }

  /** Drop the post (and its anchor). */
  clear(): void {
    this.on = false;
    this.anchorId = null;
  }

  /** Move an anchored guard post onto its anchor's live pose; an unresolved
   *  anchor leaves the post at its last known spot. Alloc-free (#14). */
  followAnchor(view: AiWorldView): void {
    const resolve = view.resolveEntityInto;
    if (!this.on || resolve === undefined || !resolve(this.anchorId!, this.anchorPose)) return;
    this.x = this.anchorPose.x;
    this.y = this.anchorPose.y;
  }

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
