import {
  type AiEntity,
  type AiIntent,
  type AiPlayerView,
  type AiWorldView,
  type IAiBehaviour,
} from '../contracts/IAiBehaviour.js';
import { HITSCAN_RANGE, WEAPON_COOLDOWN_TICKS } from '../combat/Weapons.js';
import { getShipKind, type ShipKind } from '../../shared-types/shipKinds.js';

/** Drone fires when within this fraction of full hitscan range. */
const DRONE_FIRE_RANGE = HITSCAN_RANGE * 0.6;
/** Aim cone (radians). Drones won't fire unless their nose is within this many radians of the target. */
const DRONE_AIM_TOLERANCE = 0.25; // ~14°
/** Wider fire arc used when the target is at point-blank (`< 0.4 ×
 *  DRONE_FIRE_RANGE`). At brawl distance even an off-cone shot tends to
 *  connect, so drones get to be more aggressive. */
const DRONE_AIM_TOLERANCE_CLOSE = 0.45; // ~26°
/** Distance threshold (relative to fire range) below which the wide
 *  point-blank arc kicks in. */
const POINT_BLANK_RATIO = 0.4;
/** Distance threshold (relative to fire range) above which the drone
 *  gets a thrust boost to close engagement faster. Tuned so the boost
 *  fires only when the drone is meaningfully out of combat range. */
const ENGAGE_DISTANCE_RATIO = 1.5;
/** Multiplier applied to forward thrust when the drone is engaging from
 *  beyond `ENGAGE_DISTANCE_RATIO * DRONE_FIRE_RANGE`. Rapier damping +
 *  per-kind `maxSpeed` keep this from running away. */
const ENGAGE_BOOST = 1.6;
/** Estimated muzzle speed used for lead-aim time-to-target. Hitscan is
 *  effectively instantaneous; this constant approximates "how far ahead
 *  to aim per unit of distance" — picking a finite speed works for both
 *  hitscan (small `t`) and the slower projectile fallback. */
const LEAD_AIM_MUZZLE_SPEED = 800;
/** Damping coefficient on the P-controller's angvel term. Tuned so the drone
 *  doesn't oscillate around its bearing — independent of ship kind. */
const ANGVEL_DAMPING = 1.5;
/** Forget a hostile player after this many ticks of no fresh damage from
 *  them. 1800 ticks @ 60 Hz = 30 s. Mirrors the player's own intuition that
 *  if they've been clean for half a minute, the drone has lost interest. */
const FORGET_TICKS = 1800;
/** Target orbit radius for IDLE patrol. Players spawn near the origin so
 *  this is comfortably outside the spawn zone without being so far that
 *  drones are off-screen most of the session. */
const PATROL_RADIUS = 1800;
/** Patrol thrust scaler. Drones cruise at 50 % of combat thrust when
 *  idle so the orbit stays slow and readable, and so they don't burn
 *  ahead of the inward bias when they need to spiral back. */
const PATROL_THRUST_SCALE = 0.5;
/** Strength of the inward bias applied when the drone is outside
 *  `PATROL_RADIUS`. Blends from 0 at the radius to 1 at 2 × radius. */
const PATROL_INWARD_GAIN = 1.0;

/**
 * Hostile drone: steers toward nearest player and fires hitscan when in range
 * and roughly aimed. Cooldown matches the player weapon (10 ticks @ 60 Hz).
 *
 * Per-kind tuning (`thrust`, `turnKp`, `maxTorque`) is read from the
 * `ShipKind.ai` block of the kind the drone spawned with — each drone in a
 * sector can be a different kind and steer with that kind's character. The
 * forward-vector convention matches `World.applyInput`: nose points
 * `(-sin θ, cos θ)` at angle θ.
 */
/** Phase 1 state machine: drones either patrol idle (orbit origin) or
 *  pursue & shoot a hostile player. Future phases may add more states
 *  (FLEE, REGROUP, etc.) — the structure is intentionally minimal here. */
export type DroneState = 'IDLE' | 'COMBAT';

export class HostileDroneBehaviour implements IAiBehaviour {
  private lastFireTick = -1_000_000;
  private readonly kind: ShipKind;

  // ── Phase 1: hostility / state machine ────────────────────────────────
  /** Behaviour state. Driven by `markHostile`/`purgeHostility` external
   *  events and the time-based forget at the top of `tick()`. */
  private state: DroneState = 'IDLE';
  /** Set of player ids the drone is actively hostile toward. Populated
   *  via `markHostile(shooterId, atTick)` from damage events both sides
   *  receive (server `applyDamage`, client `handleDamage`). */
  private readonly hostileTo = new Set<string>();
  /** Last server-tick at which each hostile player damaged this drone.
   *  Used to time-decay hostility when a player has been clean for
   *  `FORGET_TICKS` ticks. */
  private readonly lastHitByPlayer = new Map<string, number>();

  constructor(kind?: ShipKind | string) {
    // Accept the kind as either a `ShipKind` record or a kind id (string), so
    // tests that don't care about kind tuning can still construct with no
    // arg (`new HostileDroneBehaviour()` falls back to the catalogue default).
    this.kind = typeof kind === 'object' && kind !== null
      ? kind
      : getShipKind(typeof kind === 'string' ? kind : null);
  }

  /** Test-visible peek at the current state. */
  getState(): DroneState {
    return this.state;
  }

  /**
   * External event: a player just damaged this drone. Records the player
   * in `hostileTo` and bumps `lastHitByPlayer`. Flips state to COMBAT.
   * Called from both server (`SectorRoom.applyDamage`) and client
   * (`ColyseusClient.handleDamage`) so the per-instance state stays
   * lockstep-consistent without a wire-format bump.
   */
  markHostile(shooterId: string, atTick: number): void {
    if (!shooterId) return;
    this.hostileTo.add(shooterId);
    this.lastHitByPlayer.set(shooterId, atTick);
    this.state = 'COMBAT';
  }

  /**
   * External event: a player left the sector (transit out, disconnect).
   * Drops them from the hostile set; if no hostile remain, return to
   * IDLE so the drone resumes patrolling.
   */
  purgeHostility(playerId: string): void {
    if (!playerId) return;
    this.hostileTo.delete(playerId);
    this.lastHitByPlayer.delete(playerId);
    if (this.hostileTo.size === 0) this.state = 'IDLE';
  }

  tick(self: AiEntity, view: AiWorldView): AiIntent {
    // 1) Time-decay: drop hostiles whose last hit aged past FORGET_TICKS.
    //    `view.tick` is `serverTick` on the server and `inputTick` on the
    //    client; same tolerance as the existing `lastFireTick` cooldown.
    if (this.hostileTo.size > 0) {
      for (const [pid, lastHit] of this.lastHitByPlayer) {
        if (view.tick - lastHit > FORGET_TICKS) {
          this.lastHitByPlayer.delete(pid);
          this.hostileTo.delete(pid);
        }
      }
      if (this.hostileTo.size === 0) this.state = 'IDLE';
    }

    // 2) IDLE → patrol. Behaviour returns deterministic intent purely from
    //    `self`, so server and client AI controllers produce identical
    //    outputs when given the same drone pose (lockstep-safe).
    if (this.state === 'IDLE') return this.tickPatrol(self);

    // 3) COMBAT — pick the nearest *hostile* player. Non-hostile players
    //    are invisible to a drone in combat (so a bystander flying through
    //    a fight isn't suddenly targeted). When no hostile is in view this
    //    frame, fall back to patrol motion but stay in COMBAT state until
    //    the time-decay above clears the set.
    const target = this.nearestHostile(view, self.x, self.y);
    if (target === null) return this.tickPatrol(self);

    return this.tickCombat(self, view, target);
  }

  // ── Patrol ──────────────────────────────────────────────────────────
  /**
   * Idle behaviour: orbit the sector centre (0, 0) counter-clockwise at
   * `PATROL_RADIUS`. When the drone is outside the radius we blend an
   * inward bias into the desired heading so drones spiral back toward the
   * orbit instead of diverging — this is also the structural fix for the
   * "drone drifted to (4 133 782, -1 093 669) over a long session" bug.
   */
  private tickPatrol(self: AiEntity): AiIntent {
    const r = Math.hypot(self.x, self.y);
    const safeR = Math.max(r, 1);

    // Tangent to the circle around origin (counter-clockwise: rotate the
    // outward-radial vector by +90°). At (x, y), the unit radial is
    // (x, y)/r and its CCW perpendicular is (-y, x)/r.
    let dirX = -self.y / safeR;
    let dirY = self.x / safeR;

    // Inward bias: outside the radius, blend the heading toward the origin
    // so the drone spirals back. Clamped to [0, 1] at 2× the patrol radius.
    if (r > PATROL_RADIUS) {
      const overshoot = (r - PATROL_RADIUS) / PATROL_RADIUS;
      const bias = Math.min(1, overshoot * PATROL_INWARD_GAIN);
      dirX = dirX * (1 - bias) + (-self.x / safeR) * bias;
      dirY = dirY * (1 - bias) + (-self.y / safeR) * bias;
      const len = Math.hypot(dirX, dirY);
      if (len > 1e-6) { dirX /= len; dirY /= len; }
    }

    // Desired facing: forward = (-sin θ, cos θ), so the angle whose forward
    // points at (dirX, dirY) is atan2(-dirX, dirY).
    const desiredAngle = Math.atan2(-dirX, dirY);
    const bearingError = wrapPi(desiredAngle - self.angle);

    const maxTorque = this.kind.ai.maxTorque;
    let torque = this.kind.ai.turnKp * bearingError - ANGVEL_DAMPING * self.angvel;
    if (torque > maxTorque) torque = maxTorque;
    else if (torque < -maxTorque) torque = -maxTorque;

    // Gentle forward thrust along current facing — once the heading has
    // settled, this drives the orbital motion.
    const fwdX = -Math.sin(self.angle);
    const fwdY = Math.cos(self.angle);
    const thrustMag = this.kind.ai.thrust * PATROL_THRUST_SCALE;
    return { fx: fwdX * thrustMag, fy: fwdY * thrustMag, torque };
  }

  // ── Combat ──────────────────────────────────────────────────────────
  /**
   * Existing pursue-and-fire behaviour. Refactored out of `tick` so that
   * Step 3 of the AI plan can layer lead-aim, distance-based boost, and
   * a wider point-blank fire arc on top without mangling the IDLE branch.
   */
  private tickCombat(self: AiEntity, view: AiWorldView, target: AiPlayerView): AiIntent {
    // Raw geometry to the live target — used for distance-based gating.
    const rawDx = target.x - self.x;
    const rawDy = target.y - self.y;
    const dist = Math.hypot(rawDx, rawDy);
    if (dist < 1e-3) {
      return { fx: 0, fy: 0, torque: 0 };
    }

    // Lead-aim: estimate where the target will be when our shot lands.
    // For hitscan `t` is tiny so this barely shifts the aim; for moving
    // targets it lets the drone aim ahead of them. Using a constant
    // muzzle speed (rather than per-weapon) so the same code path covers
    // both projectile and hitscan modes — the worst case is a small
    // over-lead on hitscan, well within the aim tolerance.
    const t = dist / LEAD_AIM_MUZZLE_SPEED;
    const aimX = target.x + target.vx * t;
    const aimY = target.y + target.vy * t;
    const aimDx = aimX - self.x;
    const aimDy = aimY - self.y;

    // Bearing toward the lead-aim point, not the target's current pose.
    const desiredAngle = Math.atan2(-aimDx, aimDy);
    const bearingError = wrapPi(desiredAngle - self.angle);

    const maxTorque = this.kind.ai.maxTorque;
    let torque = this.kind.ai.turnKp * bearingError - ANGVEL_DAMPING * self.angvel;
    if (torque > maxTorque) torque = maxTorque;
    else if (torque < -maxTorque) torque = -maxTorque;

    // Distance-based boost: when the target is far the drone gets a kick
    // to close engagement; per-kind `maxSpeed` (enforced by physics drag)
    // still bounds the cruise velocity so the boost can't run away.
    const baseThrust = this.kind.ai.thrust;
    const thrustMag = dist > DRONE_FIRE_RANGE * ENGAGE_DISTANCE_RATIO
      ? baseThrust * ENGAGE_BOOST
      : baseThrust;

    const fwdX = -Math.sin(self.angle);
    const fwdY = Math.cos(self.angle);
    const fx = fwdX * thrustMag;
    const fy = fwdY * thrustMag;

    // Fire gating: standard 14° cone at normal distance widens to 26° at
    // point-blank so brawls actually trade fire instead of dancing
    // around each other waiting for a perfect line-up.
    const aimTolerance = dist < DRONE_FIRE_RANGE * POINT_BLANK_RATIO
      ? DRONE_AIM_TOLERANCE_CLOSE
      : DRONE_AIM_TOLERANCE;

    let fire: { dirX: number; dirY: number } | undefined;
    const aimed = Math.abs(bearingError) <= aimTolerance;
    const inRange = dist <= DRONE_FIRE_RANGE;
    const offCooldown = view.tick - this.lastFireTick >= WEAPON_COOLDOWN_TICKS;
    if (aimed && inRange && offCooldown) {
      fire = { dirX: fwdX, dirY: fwdY };
      this.lastFireTick = view.tick;
    }

    return fire ? { fx, fy, torque, fire } : { fx, fy, torque };
  }

  /** Nearest player from `view.players` that's in the hostile set. */
  private nearestHostile(view: AiWorldView, x: number, y: number): AiPlayerView | null {
    if (this.hostileTo.size === 0) return null;
    let best: AiPlayerView | null = null;
    let bestD2 = Infinity;
    for (const p of view.players) {
      if (!this.hostileTo.has(p.id)) continue;
      const dpx = p.x - x;
      const dpy = p.y - y;
      const d2 = dpx * dpx + dpy * dpy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = p;
      }
    }
    return best;
  }
}

/** Wrap an angle into [-π, π]. Standalone so both `tickPatrol` and
 *  `tickCombat` can share the same wrapping logic without each
 *  open-coding the while-loops. */
function wrapPi(rad: number): number {
  let r = rad;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r < -Math.PI) r += 2 * Math.PI;
  return r;
}
