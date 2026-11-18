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
import type { PilotHandling } from '../virtualPilot.js';
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
  /** Out of `brakePoint`: where the brakes bring the ship to a halt. */
  stopX = 0;
  stopY = 0;

  /** Take a post (`setGuardPost`): radius `r` already floored by the brain.
   *  A post is a hold: it ends a hunt and a travel.
   *
   *  The GUARD POST: the area (centre + radius) it was sent to
   *  defend. A broadside capital with a post fights from it (see
   *  `BroadsideHelm.guard`) instead of holding its gun stand-off; any other
   *  ship engages only targets inside the radius (measured from the post)
   *  and flies back to the post when it has none (the guard leash). The radius is
   *  at least `shipTuning(kind).guardRadiusMin` (#18), so a big hull has room
   *  to turn. Independent of the move target / flock roles (those steer the
   *  IDLE drone). Server-only: the client never ticks the drone brain.
   *
   *  `anchorId` makes the post FOLLOW that ship (an escort guards round
   *  the ship it escorts): each tick the post moves to the anchor's live pose
   *  (`view.resolveEntityInto`); while the anchor can't be resolved the post
   *  holds its last known spot ((x, y) until the first resolve); the post is
   *  cleared when the anchor leaves the AI controller (`noteEntityGone`).
   *  Omitted / null ⇒ a fixed post at (x, y). */
  post(x: number, y: number, r: number, anchorId: string | null, o: PilotOrderModes): void {
    this.on = true;
    this.anchorId = anchorId;
    this.x = x;
    this.y = y;
    this.r = r;
    o.search.on = false;
    o.travel.state = TRAVEL_NONE;
  }

  /**
   * RTS Part B slice 9, Stop (`stopAt`): The ship brakes to a halt along its course and
   * guards the spot it stops on: the post is where the pilot's brakes
   * (reverse plus damping, this kind's handling) bring it from (vx, vy) at
   * (x, y), so the nose stays on course and it never turns back for a point
   * it has already passed. Ends a travel and a hunt. Server-only. This fills
   * (`stopX`, `stopY`) with kind handling `h`; the brain posts the guard there.
   */
  brakePoint(h: PilotHandling, x: number, y: number, vx: number, vy: number): void {
    const v = Math.hypot(vx, vy);
    const a = h.reverseAccel * 60;
    const k = h.linearDamping;
    let d = 0;
    if (v > 1e-6) {
      if (a <= 0) d = k > 0 ? v / k : 0;
      else if (k <= 1e-9) d = (v * v) / (2 * a);
      else d = v / k - (a / (k * k)) * Math.log(1 + (k * v) / a);
    }
    this.stopX = v > 1e-6 ? x + (vx / v) * d : x;
    this.stopY = v > 1e-6 ? y + (vy / v) * d : y;
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

  writeGoal(_ctx: PilotModeContext, out: PilotModeGoal): void {
    out.kind = MODE_GOAL_MOVE_TO;
    out.tx = this.x;
    out.ty = this.y;
    out.cruiseCap = -1;
    out.boost = false;
  }

  /** Open-ended: the post is held until a setter clears it. */
  isDone(_ctx: PilotModeContext): boolean {
    return false;
  }
}
