/**
 * Wingman brain (RTS command layer, slice 2): the AI pilot that flies a ship
 * its owner is not flying.
 *
 * Why not `IAiBehaviour`: that contract returns an `AiIntent` of raw impulses
 * and torque applied straight to the body (the drone path, which bypasses the
 * player's speed cap and grip). The owner's rule is that wingmen fly with
 * PLAYER CONTROLS ONLY, so this brain returns the control bits a pilot would
 * hold ({@link WingmanControls}) and the server feeds them through the same
 * INPUT → `applyShipInput` path as a pilot's keys. Hence the sibling
 * {@link IWingmanBrain} interface.
 *
 * Model:
 *  - MODE: standing behaviour. Slice 2 implements `defend` (hold a guard post,
 *    return when pushed outside the guard radius). `patrol` / `hunt` /
 *    `escort` / `retreat` are TODO and fall back to defend.
 *  - ORDER: one-off, on top of the mode. `move` (arrive at a point), `stop`
 *    (hold here = defend at the spot the ship brakes to), `attack` (pursue to
 *    a stand-off; no firing yet).
 *  - When an order completes the mode RESUMES FROM WHERE THE SHIP IS NOW: for
 *    defend the guard post becomes the current position (later: patrol flies
 *    to its nearest waypoint).
 *  - STANCE: stored for the firing slice; does not affect movement yet.
 *
 * Pure, zone-blind, allocation-free per tick (#14): scratch lives on fields.
 * Size-dependent distances (arrive / guard radius) come from the caller, which
 * reads them from `shipTuning(kind)` (#18).
 */
import {
  intentToControlBits,
  makeControlIntent,
} from './wingman/intentToControlBits.js';
import type {
  WingmanActivity,
  WingmanControls,
  WingmanMode,
  WingmanOrder,
  WingmanPose,
  WingmanPoseOut,
  WingmanShipStats,
  WingmanStance,
  WingmanWorldView,
} from './wingman/types.js';
import { makeWingmanControls } from './wingman/types.js';

/** The brain contract the server's fleet subsystem drives once per tick. */
export interface IWingmanBrain {
  tick(self: WingmanPose, view: WingmanWorldView): WingmanControls;
  readonly activity: WingmanActivity;
  /** The entity the wingman is engaging / pursuing, or null. */
  readonly targetId: string | null;
}

export interface WingmanConfig {
  readonly stats: WingmanShipStats;
  /** An order to a point is done inside this radius (u). */
  readonly arriveRadius: number;
  /** Defend: the ship returns to its post once further than this (u). */
  readonly guardRadius: number;
  /** Boost on legs longer than this (u). Default 3 × guardRadius. */
  readonly boostDistance?: number;
  /** Attack: hold this far from the target (u). Default guardRadius / 2. */
  readonly attackStandoff?: number;
  readonly mode?: WingmanMode;
  readonly stance?: WingmanStance;
}

/** Plan braking at this fraction of the reverse deceleration (margin for the
 *  turn latency and the on/off control). */
export const WINGMAN_BRAKE_MARGIN = 0.8;
/** An order to a point is done once slower than this fraction of max speed. */
export const WINGMAN_ARRIVE_SPEED_FRAC = 0.03;

/**
 * Distance a ship at speed `v` covers while braking with reverse held:
 * dv/dt = −(a + k·v) ⇒ d = v/k − (a/k²)·ln(1 + k·v/a). Without damping,
 * v²/2a.
 */
export function stoppingDistance(v: number, stats: WingmanShipStats): number {
  if (v <= 0) return 0;
  const a = stats.reverseAccel, k = stats.linearDamping;
  if (a <= 0) return k > 0 ? v / k : Infinity;
  if (k <= 1e-9) return (v * v) / (2 * a);
  return v / k - (a / (k * k)) * Math.log(1 + (k * v) / a);
}

export class WingmanBehaviour implements IWingmanBrain {
  private readonly stats: WingmanShipStats;
  private readonly arriveRadius: number;
  private guardRadius: number;
  private readonly boostDistance: number;
  private readonly attackStandoff: number;

  private _mode: WingmanMode;
  private _stance: WingmanStance;
  private _order: WingmanOrder | null = null;
  private _activity: WingmanActivity = 'idle';
  private _targetId: string | null = null;

  private postX = 0;
  private postY = 0;
  /** False ⇒ the next tick takes the current position as the guard post. */
  private postValid = false;
  /** Defend: flying back to the post after being pushed out. */
  private returning = false;
  /** Stop order: coasting onto the post just set (reads as 'guarding'). */
  private settling = false;

  private readonly intent = makeControlIntent();
  private readonly controls = makeWingmanControls();
  private readonly targetPose: WingmanPoseOut = { x: 0, y: 0, vx: 0, vy: 0 };

  constructor(config: WingmanConfig) {
    this.stats = config.stats;
    this.arriveRadius = config.arriveRadius;
    this.guardRadius = config.guardRadius;
    this.boostDistance = config.boostDistance ?? config.guardRadius * 3;
    this.attackStandoff = config.attackStandoff ?? config.guardRadius * 0.5;
    this._mode = config.mode ?? 'defend';
    this._stance = config.stance ?? 'defensive';
  }

  // ---- Read-outs (status streaming) ---------------------------------------
  get mode(): WingmanMode { return this._mode; }
  get stance(): WingmanStance { return this._stance; }
  get order(): WingmanOrder | null { return this._order; }
  get activity(): WingmanActivity { return this._activity; }
  get targetId(): string | null { return this._targetId; }
  /** Current guard post, or null until the first tick sets it. */
  get guardPostX(): number | null { return this.postValid ? this.postX : null; }
  get guardPostY(): number | null { return this.postValid ? this.postY : null; }

  // ---- Commands (discrete, event-driven) ----------------------------------
  /** Change the standing mode. With a post, defend there; without, resume from
   *  the current position. Does not cancel a direct order. */
  setMode(mode: WingmanMode, postX?: number, postY?: number): void {
    this._mode = mode;
    if (postX !== undefined && postY !== undefined) this.setGuardPost(postX, postY);
    else this.postValid = false;
    this.returning = false;
  }

  setStance(stance: WingmanStance): void { this._stance = stance; }

  setGuardPost(x: number, y: number): void {
    this.postX = x; this.postY = y; this.postValid = true;
    this.returning = false; this.settling = false;
  }

  setGuardRadius(r: number): void { this.guardRadius = r; }

  /** Replace any current order. Takes effect on the next tick. */
  issueOrder(order: WingmanOrder): void {
    this._order = order;
    this._targetId = order.kind === 'attack' ? order.targetId : null;
  }

  /** Drop the current order and resume the mode from where the ship is. */
  clearOrder(): void {
    this._order = null;
    this._targetId = null;
    this.postValid = false;
    this.returning = false;
  }

  // ---- Per-tick -------------------------------------------------------------
  tick(self: WingmanPose, view: WingmanWorldView): WingmanControls {
    if (!this.postValid) this.setGuardPost(self.x, self.y);
    const it = this.intent;
    it.dvx = 0; it.dvy = 0; it.boost = false;

    const order = this._order;
    let handled = false;
    if (order !== null) {
      switch (order.kind) {
        case 'move':
          if (this.steerTo(self, order.x, order.y, true)) {
            this.completeOrder(self);
          } else {
            this._activity = 'moving';
            handled = true;
          }
          break;
        case 'stop': {
          // Hold position: defend the spot the ship brakes to.
          const sp = Math.hypot(self.vx, self.vy);
          const d = stoppingDistance(sp, this.stats);
          const k = sp > 1e-6 ? d / sp : 0;
          this._order = null;
          this._targetId = null;
          this._mode = 'defend';
          this.setGuardPost(self.x + self.vx * k, self.y + self.vy * k);
          // It coasts onto that spot: holding, not returning.
          this.returning = true;
          this.settling = true;
          break;
        }
        case 'attack':
          if (this.pursue(self, view, order.targetId)) handled = true;
          else this.completeOrder(self);
          break;
      }
    }

    if (!handled) this.runMode(self);
    return intentToControlBits(it, self, this.stats, this.controls);
  }

  /** Order done: clear it and resume the mode from the current position. */
  private completeOrder(self: WingmanPose): void {
    this._order = null;
    this._targetId = null;
    this.resumeFrom(self);
  }

  /** The resume rule. Defend (and, until their slices land, every other mode):
   *  the guard post becomes where the ship is now.
   *  TODO(rts patrol): patrol flies to its nearest waypoint instead. */
  private resumeFrom(self: WingmanPose): void {
    this.setGuardPost(self.x, self.y);
  }

  private runMode(self: WingmanPose): void {
    // TODO(rts slice): patrol / hunt / escort / retreat. Fall back to defend.
    switch (this._mode) {
      case 'defend':
      case 'patrol':
      case 'hunt':
      case 'escort':
      case 'retreat':
        this.tickDefend(self);
        break;
    }
  }

  private tickDefend(self: WingmanPose): void {
    const dx = this.postX - self.x, dy = this.postY - self.y;
    if (dx * dx + dy * dy > this.guardRadius * this.guardRadius) this.returning = true;
    if (this.returning) {
      if (this.steerTo(self, this.postX, this.postY, !this.settling)) {
        this.returning = false;
        this.settling = false;
        this._activity = 'guarding';
      } else {
        this._activity = this.settling ? 'guarding' : 'moving';
      }
      return;
    }
    // Inside the guard radius: hold still (intent stays zero ⇒ brake).
    this._activity = 'guarding';
  }

  /**
   * Set the intent to arrive at (tx, ty): full speed far out, slowing so the
   * reverse key can stop the ship at the point. Returns true once inside the
   * arrive radius and nearly stopped (the intent is then zero ⇒ brake).
   */
  private steerTo(self: WingmanPose, tx: number, ty: number, allowBoost: boolean): boolean {
    const dx = tx - self.x, dy = ty - self.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const it = this.intent;
    if (dist <= this.arriveRadius) {
      it.dvx = 0; it.dvy = 0; it.boost = false;
      return Math.hypot(self.vx, self.vy) <= this.stats.maxSpeed * WINGMAN_ARRIVE_SPEED_FRAC;
    }
    const brakeDist = Math.max(0, dist - this.arriveRadius * 0.5);
    const a = this.stats.reverseAccel * WINGMAN_BRAKE_MARGIN;
    const v = Math.min(this.stats.maxSpeed, Math.sqrt(2 * a * brakeDist));
    it.dvx = (dx / dist) * v;
    it.dvy = (dy / dist) * v;
    it.boost = allowBoost && dist > this.boostDistance;
    return false;
  }

  /** Attack order movement: close to the stand-off and match the target's
   *  velocity. No firing in this slice. False ⇒ the target is gone. */
  private pursue(self: WingmanPose, view: WingmanWorldView, targetId: string): boolean {
    const tp = this.targetPose;
    if (view.resolvePoseInto === undefined || !view.resolvePoseInto(targetId, tp)) return false;
    this._targetId = targetId;
    const dx = tp.x - self.x, dy = tp.y - self.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const standoff = this.attackStandoff;
    if (dist > 1e-6) {
      const ux = dx / dist, uy = dy / dist;
      this.steerTo(self, tp.x - ux * standoff, tp.y - uy * standoff, true);
    }
    // Feed the target's velocity forward so the wingman keeps station on it.
    this.intent.dvx += tp.vx;
    this.intent.dvy += tp.vy;
    this._activity = dist > standoff * 1.5 ? 'chasing' : 'attacking';
    return true;
  }
}
