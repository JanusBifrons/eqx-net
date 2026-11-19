/**
 * The pilot's aim: the combat lead point (first-order intercept in the
 * shooter's frame), the range to the target's hull, the bearing to the lead
 * and the hull cone the fire gate and the turn taps use, plus the turret aim
 * point the server's WeaponMountTicker reads (`aimPoint`). Owned by
 * `HostileDroneBehaviour` and built once; the brain keeps a one-line
 * `aimPoint` delegate. Allocation-free (#14): every output is a plain field.
 */
import type { AiEntity, AiWorldView } from '../../contracts/IAiBehaviour.js';
import { shipHitBound, shipHullDistance } from '../../combat/shipHitShape.js';
import type { MountTargetView } from '../WeaponMountController.js';
import { hullFireCone } from '../hullFireCone.js';
import { DEFAULT_AIM_RADIUS } from '../hostileDroneTuning.js';
import { facingOf, wrapAngle, type PilotState } from '../virtualPilot.js';
import type { EngagementProfile } from './engagementProfile.js';

export class PilotAim {
  // ── Turret aim point (owner 2026-11-14: "The turrets also aren't turning
  // to shoot the direction they do") ─────────────────────────────────────
  // Where this pilot's guns want to point THIS tick: the lead point of its
  // combat target, whatever that is (a pilot, another ship, a structure).
  // The server's WeaponMountTicker slews turning mounts onto it, so a turret
  // ship's barrels follow the fight it is in, not only hostile pilots.
  // Cleared at the top of every tick; set only by combat. Plain fields (#14).
  valid = false;
  x = 0;
  y = 0;
  /** Out of `lead`: the lead vector, the bearing to it and the hull cone. */
  aimDx = 0;
  aimDy = 0;
  desiredAngle = 0;
  bearingError = 0;
  hullCone = 0;

  constructor(private readonly eng: EngagementProfile, private readonly _pilot: PilotState) {}

  /** Top of every tick: no aim point until combat sets one. */
  reset(): void { this.valid = false; }

  /** Set the aim point (travel's fire-on-the-way lead). */
  set(x: number, y: number): void {
    this.valid = true;
    this.x = x;
    this.y = y;
  }

  /** The lead point this tick's combat aims at (false = not in combat). */
  aimPoint(out: { x: number; y: number }): boolean {
    if (!this.valid) return false;
    out.x = this.x;
    out.y = this.y;
    return true;
  }

  /** Range to the target's HULL (the shape the fire gate measures to), so a
   *  capital is engaged once a gun reaches its side, not its centre. Cheap
   *  first: past bound + fireRange the centre distance minus the bound is
   *  already out of range; only near range is the polygon measured. */
  hullRange(self: AiEntity, target: MountTargetView, dist: number): number {
    let rangeDist = dist;
    if (target.kindId != null) {
      const far = dist - shipHitBound(target.kindId);
      rangeDist = far > this.eng.fireRange
        ? far
        : shipHullDistance(target.kindId, target.shieldUp === true, self.x, self.y, target.x, target.y, target.angle ?? 0);
    }
    return rangeDist;
  }

  /** The combat lead: fills the aim point and the lead outputs. */
  lead(self: AiEntity, view: AiWorldView, target: MountTargetView, dist: number, rangeDist: number): void {
    // Lead-aim: first-order intercept in the SHOOTER's frame. The bolt
    // inherits the shooter's velocity at spawn (self.v + dir·speed), so the
    // lead uses the target's velocity RELATIVE to the shooter and the
    // weapon's real muzzle speed (hitscan → leadMuzzleSpeed huge → t≈0 →
    // no lead).
    const t = dist / this.eng.leadMuzzleSpeed;
    const aimX = target.x + (target.vx - self.vx) * t;
    const aimY = target.y + (target.vy - self.vy) * t;
    const aimDx = aimX - self.x;
    const aimDy = aimY - self.y;
    // Fire-lane awareness (slice 5b): publish where this gun points while it
    // can shoot, so wingmen keep out of the lane.
    if (rangeDist <= this.eng.fireRange) view.aims?.write(self.id, aimX, aimY, view.tick);

    // Bearing toward the lead-aim point, not the target's current pose.
    const desiredAngle = facingOf(aimDx, aimDy);
    const bearingError = wrapAngle(desiredAngle - self.angle);
    // Fixed guns: the cone the target's hull covers at the lead point (plus the
    // bolt's own radius), capped at the player's window. In range, the pilot
    // eases the nose into it with one-tick taps (`aimCone`) and fires only
    // inside it (the brain's fire gate), so a shot is pulled only when it will hit.
    // Turret kinds send the same cone with the shot: the resolver narrows each
    // barrel's window to it.
    const hullCone = hullFireCone(((target as { hitRadius?: number }).hitRadius ?? DEFAULT_AIM_RADIUS) + this.eng.shotRadius, Math.hypot(aimDx, aimDy));
    if (this.eng.maxTurretHalfArc <= 0 && rangeDist <= this.eng.fireRange) this._pilot.turn.aimCone = hullCone;
    this.set(aimX, aimY);
    this.aimDx = aimDx;
    this.aimDy = aimDy;
    this.desiredAngle = desiredAngle;
    this.bearingError = bearingError;
    this.hullCone = hullCone;
  }
}
