/**
 * Travel (peacetime job `JOB_TRAVEL`): an owner's Move / Retreat
 * (`setTravel`) or one leg of their Patrol (`setPatrolLeg`). Fly the leg and
 * arrive at the full cruise; a leg longer than `TRAVEL_LONG_LEG_GUARD_MUL`
 * guard radii asks for the top speed and lets the pilot boost (its own gate:
 * nose on course, a real speed gap, the pool pays), the old wingman's
 * long-leg rule. Arrived (inside `wingmanArrive`, nearly stopped: `isDone`)
 * the brain guards the point. The course is the brain's shared fly-to (nav
 * routes live there).
 *
 * On the way (`fireOnTheWay`) the ship fires only at a target already in its
 * sights; it never turns toward it. A patrol leg that fights hands the fight
 * to the combat branch instead (the brain decides).
 */
import { shipTuning } from '../../../shared-types/shipScale/tuning.js';
import { shipHitBound, shipHullDistance } from '../../combat/shipHitShape.js';
import type { AiIntent, AiWorldView } from '../../contracts/IAiBehaviour.js';
import type { MountTargetView } from '../WeaponMountController.js';
import {
  DEFAULT_AIM_RADIUS,
  DRONE_AIM_TOLERANCE,
  DRONE_AIM_TOLERANCE_CLOSE,
  POINT_BLANK_RATIO,
  TRAVEL_ARRIVE_SPEED_FRAC,
  TRAVEL_LONG_LEG_GUARD_MUL,
} from '../hostileDroneTuning.js';
import { hullFireCone } from '../hullFireCone.js';
import { facingOf, wrapAngle } from '../virtualPilot.js';
import { MODE_GOAL_MOVE_TO, type IPilotMode, type PilotModeContext, type PilotModeGoal } from '../tactics/manoeuvre.js';

/** The brain's fixed gun numbers (set once at construction). */
export interface TravelFireTune {
  readonly broadside: boolean;
  readonly fireRange: number;
  readonly leadMuzzleSpeed: number;
  readonly shotRadius: number;
  readonly maxTurretHalfArc: number;
}

/** The brain's reused fire scratch (`AiIntent.fire`). */
export interface TravelFireOut { dirX: number; dirY: number; targetId: string; cone: number }

export class TravelMode implements IPilotMode {
  /** The lead point of the last `fireOnTheWay` that held the trigger. */
  aimX = 0;
  aimY = 0;

  constructor(private readonly tune: TravelFireTune, private readonly fireOut: TravelFireOut) {}

  begin(_ctx: PilotModeContext): void {}

  /** Arrived: inside `wingmanArrive` of the travel point, nearly stopped. */
  isDone(ctx: PilotModeContext): boolean {
    const self = ctx.self;
    const t = shipTuning(ctx.kind);
    const dx = ctx.travelX - self.x;
    const dy = ctx.travelY - self.y;
    return dx * dx + dy * dy <= t.wingmanArrive * t.wingmanArrive
      && Math.hypot(self.vx, self.vy) <= ctx.handling.maxSpeed * TRAVEL_ARRIVE_SPEED_FRAC;
  }

  writeGoal(ctx: PilotModeContext, out: PilotModeGoal): void {
    out.kind = MODE_GOAL_MOVE_TO;
    out.tx = ctx.travelX;
    out.ty = ctx.travelY;
    if (this.isDone(ctx)) {
      // Arrived: the calm fly-to holds the point.
      out.cruiseCap = -1;
      out.boost = false;
      return;
    }
    const t = shipTuning(ctx.kind);
    const h = ctx.handling;
    const dx = ctx.travelX - ctx.self.x;
    const dy = ctx.travelY - ctx.self.y;
    const long = dx * dx + dy * dy > (TRAVEL_LONG_LEG_GUARD_MUL * t.guardRadiusMin) ** 2;
    out.cruiseCap = long ? h.maxSpeed : h.cruiseSpeed;
    out.boost = long;
  }

  /**
   * Travel's trigger: hold it at `target` only while the nose (or a turret's
   * arc) already covers the lead point and it is in range, by the same aim
   * rules as the brain's `tickCombat` fire gate (the hull cone for fixed
   * guns, the turret half-arc added for turret kinds). Never steers. A charge
   * weapon has no line to hold here (an owned hull's player pipeline has no
   * wind-up), so the charge rule does not apply. True when the trigger is
   * held (`aimX`, `aimY` = the lead point).
   */
  fireOnTheWay(ctx: PilotModeContext, view: AiWorldView, target: MountTargetView, intent: AiIntent): boolean {
    const tu = this.tune;
    if (tu.broadside) return false;
    const self = ctx.self;
    const rawDx = target.x - self.x;
    const rawDy = target.y - self.y;
    const dist = Math.hypot(rawDx, rawDy);
    if (dist < 1e-3) return false;
    let rangeDist = dist;
    if (target.kindId != null) {
      const far = dist - shipHitBound(target.kindId);
      rangeDist = far > tu.fireRange
        ? far
        : shipHullDistance(target.kindId, target.shieldUp === true, self.x, self.y, target.x, target.y, target.angle ?? 0);
    }
    if (rangeDist > tu.fireRange) return false;
    const lead = dist / tu.leadMuzzleSpeed;
    const aimX = target.x + (target.vx - self.vx) * lead;
    const aimY = target.y + (target.vy - self.vy) * lead;
    const aimDx = aimX - self.x;
    const aimDy = aimY - self.y;
    const aimLen = Math.hypot(aimDx, aimDy);
    view.aims?.write(self.id, aimX, aimY, view.tick);
    const hullCone = hullFireCone(((target as { hitRadius?: number }).hitRadius ?? DEFAULT_AIM_RADIUS) + tu.shotRadius, aimLen);
    const tolerance = tu.maxTurretHalfArc > 0
      ? (rangeDist < tu.fireRange * POINT_BLANK_RATIO ? DRONE_AIM_TOLERANCE_CLOSE : DRONE_AIM_TOLERANCE) + tu.maxTurretHalfArc
      : hullCone;
    if (Math.abs(wrapAngle(facingOf(aimDx, aimDy) - self.angle)) > tolerance) return false;
    this.aimX = aimX;
    this.aimY = aimY;
    const f = this.fireOut;
    if (aimLen > 1e-6) {
      f.dirX = aimDx / aimLen;
      f.dirY = aimDy / aimLen;
    } else {
      f.dirX = -Math.sin(self.angle);
      f.dirY = Math.cos(self.angle);
    }
    f.targetId = target.id;
    f.cone = hullCone;
    intent.fire = f;
    return true;
  }
}
