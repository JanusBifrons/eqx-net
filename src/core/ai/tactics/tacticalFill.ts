/**
 * The combat tick's tactical-context refresh (`TacticalContext`, plain writes,
 * #14), owned by `HostileDroneBehaviour` and built once. Holds the target
 * memory it needs across ticks: the smoothed target speed and the parked /
 * slow still-memory. Allocation-free.
 */
import type { AiEntity } from '../../contracts/IAiBehaviour.js';
import type { MountTargetView } from '../WeaponMountController.js';
import { TARGET_SPEED_GAIN, TICKS_PER_S_SIM } from '../hostileDroneTuning.js';
import {
  PARKED_SPEED_FRAC,
  SLOW_SPEED_FRAC,
  TARGET_STILL_MEMORY_S,
  TARGET_STILL_MIN_S,
  type TacticalContext,
} from './manoeuvre.js';

export class TacticalFill {
  /** The target the still-memory is about, and the last ticks it was under
   *  the parked / slow bar (`TARGET_STILL_MEMORY_S`). */
  private _stillTargetId: string | null = null;
  private _tParkedTick = -1_000_000;
  private _tSlowTick = -1_000_000;
  /** Start of the target's current stretch under the parked bar (-1 while
   *  above it): it counts toward the parked memory only after
   *  `TARGET_STILL_MIN_S`. */
  private _tParkedSince = -1;
  /** The body target's speed smoothed over ~`TARGET_SPEED_TAU_TICKS` (reset
   *  on a new target): the slow-target call reads it (`targetSlow`). */
  private _tSpeedAvg = 0;
  private _tSpeedId: string | null = null;

  /** Refresh the tactical context for this combat tick (plain writes, #14). */
  fill(
    c: TacticalContext,
    self: AiEntity,
    tick: number,
    target: MountTargetView,
    dist: number,
    ux: number,
    uy: number,
    aimX: number,
    aimY: number,
    leadAngle: number,
    bearingError: number,
    along: number,
    boostOk: boolean,
    cruiseSpeed: number,
    maxHealth: number,
  ): void {
    c.tick = tick;
    c.x = self.x; c.y = self.y; c.vx = self.vx; c.vy = self.vy;
    c.angle = self.angle;
    c.fwdX = -Math.sin(self.angle);
    c.fwdY = Math.cos(self.angle);
    c.tx = target.x; c.ty = target.y; c.tvx = target.vx; c.tvy = target.vy;
    const tsNow = Math.hypot(target.vx, target.vy);
    if (target.id !== this._tSpeedId) {
      this._tSpeedId = target.id;
      this._tSpeedAvg = tsNow;
    } else {
      this._tSpeedAvg += (tsNow - this._tSpeedAvg) * TARGET_SPEED_GAIN;
    }
    c.targetSpeed = this._tSpeedAvg;
    c.targetIsShip = (target as { ship?: boolean }).ship !== false;
    c.dist = dist; c.ux = ux; c.uy = uy;
    c.aimX = aimX; c.aimY = aimY;
    c.leadAngle = leadAngle;
    c.offBoresight = bearingError < 0 ? -bearingError : bearingError;
    // d(dist)/dt = (v_target − v_self)·u; closing is its negative.
    c.closing = -((target.vx - self.vx) * ux + (target.vy - self.vy) * uy);
    const ts = tsNow;
    // Still-memory: a nudge does not make a parked / slow target a moving one.
    if (target.id !== this._stillTargetId) {
      this._stillTargetId = target.id;
      this._tParkedTick = -1_000_000;
      this._tSlowTick = -1_000_000;
      this._tParkedSince = -1;
    }
    const cruise = cruiseSpeed;
    const minStill = TARGET_STILL_MIN_S * TICKS_PER_S_SIM;
    if (ts <= PARKED_SPEED_FRAC * cruise) {
      if (this._tParkedSince < 0) this._tParkedSince = tick;
      if (tick - this._tParkedSince >= minStill) this._tParkedTick = tick;
    } else {
      this._tParkedSince = -1;
    }
    if (ts < SLOW_SPEED_FRAC * cruise) this._tSlowTick = tick;
    const mem = TARGET_STILL_MEMORY_S * TICKS_PER_S_SIM;
    c.tParkedHeld = tick - this._tParkedTick <= mem;
    c.tSlowHeld = tick - this._tSlowTick <= mem;
    c.targetAspectCos = ts > PARKED_SPEED_FRAC * cruiseSpeed ? -(target.vx * ux + target.vy * uy) / ts : 0;
    c.threatBearingCos = c.fwdX * ux + c.fwdY * uy;
    // The same bearing from the target's side: its nose vs target → me.
    const ta = (target as { angle?: number }).angle;
    const known = ta !== undefined && !Number.isNaN(ta);
    c.targetBowCos = known ? Math.sin(ta) * ux - Math.cos(ta) * uy : 1;
    c.tFwdX = known ? -Math.sin(ta) : 0;
    c.tFwdY = known ? Math.cos(ta) : 0;
    const hp = self.health;
    c.hullFrac = hp === undefined ? 1 : Math.max(0, Math.min(1, hp / maxHealth));
    c.holdAlong = along;
    c.holdBoost = boostOk;
  }
}
