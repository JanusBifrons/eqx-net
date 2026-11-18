/**
 * Broadside flying for capitals (turret ships that fight beam-on), owned by
 * `HostileDroneBehaviour` and built once. Combat-side (owner decision): the
 * brain dispatches here from `tickCombat`. Each call writes the pilot's
 * wanted facing, velocity, boost and pilot params into this object's out
 * fields; the brain flies them through the virtual pilot. Never fires: the
 * turrets do, under WeaponMountTicker fire control. Allocation-free (#14).
 */
import type { AiEntity } from '../../contracts/IAiBehaviour.js';
import type { MountTargetView } from '../WeaponMountController.js';
import { facingOf, wrapAngle, type PilotParams } from '../virtualPilot.js';
import {
  BROADSIDE_RANGE_DEADBAND,
  BROADSIDE_RANGE_STEER,
  BROADSIDE_SPEED,
  BROADSIDE_STANDOFF,
  ENGAGE_DISTANCE_RATIO,
  GUARD_HOLD_FRAC,
  GUARD_PILOT_PARAMS,
  GUARD_RETURN_FRAC,
  GUARD_RETURN_SPEED,
} from '../hostileDroneTuning.js';

export class BroadsideHelm {
  /** Out: the facing, wanted velocity, boost and pilot params to fly
   *  (`params` undefined = the pilot's defaults). */
  facing = 0;
  wvx = 0;
  wvy = 0;
  boost = false;
  params: Readonly<PilotParams> | undefined = undefined;

  private out(facing: number, wvx: number, wvy: number, boost: boolean, params?: Readonly<PilotParams>): void {
    this.facing = facing;
    this.wvx = wvx;
    this.wvy = wvy;
    this.boost = boost;
    this.params = params;
  }

  /**
   * Capital engagement (plan prancy-squishing-donut Phase 3). Out of reach:
   * close bow-first (the wanted velocity points at the target, so while the
   * target is abaft the beam the pilot backs its engines: reverse brakes the
   * way it carries AWAY and backs it toward the target while the bow comes
   * round — showcase-capital-duel, 2026-11-12). In reach: turn the beam toward
   * the target (whichever side is nearer the current heading) so fore AND aft
   * turrets bear, biased in or out to hold `fireRange × BROADSIDE_STANDOFF`,
   * steaming along that heading at a speed that grows with the range error, so
   * the hull circles its target. Turning is the kind's own torque turn (slow
   * to start and stop). Allocation-free.
   */
  fight(
    self: AiEntity, target: MountTargetView, dx: number, dy: number, dist: number, rangeDist: number,
    fireRange: number, cruiseSpeed: number,
  ): void {
    const bearing = facingOf(dx, dy);
    const cruise = cruiseSpeed;
    if (rangeDist > fireRange) {
      const s = cruise / dist;
      this.out(bearing, dx * s, dy * s, rangeDist > fireRange * ENGAGE_DISTANCE_RATIO);
      return;
    }
    const port = wrapAngle(bearing + Math.PI / 2);
    const stbd = wrapAngle(bearing - Math.PI / 2);
    const usePort = Math.abs(wrapAngle(port - self.angle)) <= Math.abs(wrapAngle(stbd - self.angle));
    const standoff = fireRange * BROADSIDE_STANDOFF;
    // + when too far (turn in toward the target), − when too close; 0 inside
    // the dead-band (at the stand-off: hold the beam, keys off).
    const raw = Math.max(-1, Math.min(1, (rangeDist - standoff) / standoff));
    const over = Math.max(0, Math.abs(raw) - BROADSIDE_RANGE_DEADBAND) / (1 - BROADSIDE_RANGE_DEADBAND);
    const err = raw < 0 ? -over : over;
    const bias = err * BROADSIDE_RANGE_STEER;
    const desired = usePort ? wrapAngle(port - bias) : wrapAngle(stbd + bias);
    // Hold station: steam only to correct range (none at the stand-off), or
    // the hull carries itself out of its own guns' reach. The target's own
    // motion is matched so a moving target stays in reach.
    const speed = cruise * BROADSIDE_SPEED * Math.abs(err);
    const hx = -Math.sin(desired);
    const hy = Math.cos(desired);
    this.out(desired, hx * speed + target.vx, hy * speed + target.vy, false);
  }

  /**
   * A guarding capital in combat (owner decision 2026-11-11: "It should stay
   * close to the thing it's defending, obviously"). It never chases the
   * stand-off or a target out of reach: it keeps station at its post and lets
   * the turrets do the fighting. Station-keeping: the wanted velocity is zero
   * inside `GUARD_HOLD_FRAC` of the radius and grows toward the post beyond it;
   * the pilot thrusts or reverses along the hull axis (the only axis a ship
   * thrusts on) to close the gap. Inside `GUARD_RETURN_FRAC` of the radius the
   * hull turns its beam to the target so fore and aft turrets bear; beyond it,
   * it turns its axis (bow or stern, whichever is nearer) to the correction so
   * thrust or reverse can bring it back. Allocation-free.
   */
  guard(
    self: AiEntity, dx: number, dy: number, guardX: number, guardY: number, guardR: number, maxSpeed: number,
  ): void {
    const px = guardX - self.x;
    const py = guardY - self.y;
    const dPost = Math.hypot(px, py);
    const r = guardR;
    const vMax = maxSpeed;
    const hold = r * GUARD_HOLD_FRAC;
    let want = 0;
    if (dPost > hold) want = vMax * GUARD_RETURN_SPEED * Math.min(1, (dPost - hold) / (r - hold));
    const ux = dPost > 1e-6 ? px / dPost : 0;
    const uy = dPost > 1e-6 ? py / dPost : 0;
    const wvx = ux * want;
    const wvy = uy * want;
    const ex = wvx - self.vx;
    const ey = wvy - self.vy;
    let desired: number;
    if (dPost > r * GUARD_RETURN_FRAC && Math.hypot(ex, ey) > 1e-6) {
      const ahead = facingOf(ex, ey);
      const astern = wrapAngle(ahead + Math.PI);
      desired = Math.abs(wrapAngle(ahead - self.angle)) <= Math.abs(wrapAngle(astern - self.angle)) ? ahead : astern;
    } else {
      const bearing = facingOf(dx, dy);
      const port = wrapAngle(bearing + Math.PI / 2);
      const stbd = wrapAngle(bearing - Math.PI / 2);
      desired = Math.abs(wrapAngle(port - self.angle)) <= Math.abs(wrapAngle(stbd - self.angle)) ? port : stbd;
    }
    this.out(desired, wvx, wvy, false, GUARD_PILOT_PARAMS);
  }
}
