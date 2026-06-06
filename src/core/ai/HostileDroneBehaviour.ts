import {
  type AiEntity,
  type AiIntent,
  type AiPlayerView,
  type AiWorldView,
  type IAiBehaviour,
} from '../contracts/IAiBehaviour.js';
import { getWeapon, type WeaponMode } from '../combat/WeaponCatalogue.js';
import { getShipKind, type ShipKind } from '../../shared-types/shipKinds.js';
import { pickTarget } from './WeaponMountController.js';

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
/** Bearing-error magnitude (radians) below which the drone snaps to
 *  zero angular velocity instead of pegging at `±maxAngvel`. ~3° dead
 *  zone — wide enough that a finished turn doesn't oscillate around
 *  zero, narrow enough that fine aim corrections still land. */
const TURN_DEADZONE = 0.05;
/** Window (radians) over which the AI ramps its target angvel from 0 to
 *  `maxAngvel` linearly. Outside this window the drone turns at full
 *  speed; inside, it slows in so it doesn't blow through the bearing
 *  and immediately reverse. Wider = smoother, narrower = sharper.
 *  ~0.25 rad ≈ 14° feels both decisive and clean. */
const TURN_RAMP_WINDOW = 0.25;
/** Forget a hostile player after this many ticks of no fresh damage from
 *  them. 1800 ticks @ 60 Hz = 30 s. Mirrors the player's own intuition that
 *  if they've been clean for half a minute, the drone has lost interest. */
const FORGET_TICKS = 1800;
/** Part C — bias the drone's target pick toward the lowest-health hostile
 *  ("gang up on the wounded one") instead of pure nearest. Moderate so a
 *  far-but-wounded player doesn't pull a drone across the sector past a
 *  point-blank threat — distance² still dominates at large gaps. No effect when
 *  the player view carries no health (e.g. older tests). */
const DRONE_TARGET_HEALTH_WEIGHT = 1.5;
/** Part C — hard switch-DELAY: once a drone commits to a target it holds it for
 *  this many ticks before re-evaluating, so a pack doesn't all flip targets in
 *  unison every tick as ranges cross. ~0.5 s at 60 Hz. Server-only (deterministic
 *  server tick; the client never ticks the drone brain). */
const DRONE_TARGET_DWELL_TICKS = 30;
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
  /** Previously-picked target id, used by `pickTarget` to apply sticky
   *  hysteresis (Phase 4a). Pre-refactor the drone re-picked nearest hostile
   *  every tick, which oscillated between two near-equidistant players. Per-
   *  instance so it's lockstep-safe in the same way `lastFireTick` is —
   *  reset purely by `markHostile`/`purgeHostility`/time-decay, both of
   *  which fire symmetrically on server and client. */
  private prevTargetId: string | null = null;
  /** Server tick at which `prevTargetId` was last (re)acquired — drives the
   *  `DRONE_TARGET_DWELL_TICKS` switch-delay in the body target pick. */
  private prevTargetSinceTick = 0;
  /** Phase 4c (2026-05-11) — half-arc of the widest rotating mount in
   *  this kind's primary slot, used to widen the body-aim fire gate so
   *  drones with turrets fire even when the body is off-aim by less than
   *  the mount's reach. For single-mount legacy kinds (zero arc) this is
   *  0 and the gate collapses to the pre-4c body-only tolerance. */
  private readonly maxTurretHalfArc: number;

  // ── Weapon-aware engagement (weapons/energy/AI overhaul §4) ───────────
  // Computed once in the constructor from this drone's bound weapon (no
  // per-tick allocation, no wire divergence — all derived from `this.kind`).
  /** Mode of the drone's bound weapon (first mount). Drives the steering
   *  branch in tickCombat. */
  private readonly weaponMode: WeaponMode;
  /** Distance (world units) at/under which the drone fires. Beam → very
   *  close (~225); bolt → medium (~560); missile → long (~1400). */
  private readonly fireRange: number;
  /** Cooldown of the bound weapon in ticks (beam/bolt 10, missile 90).
   *  Replaces the global WEAPON_COOLDOWN_TICKS so missile drones don't
   *  spam at the hitscan rate. */
  private readonly fireCooldownTicks: number;
  /** STOP_DIST = fireRange × this. Beam bores in (0.5); bolt dogfights
   *  (0.6); missile kites far (0.9). */
  private readonly stopDistFactor: number;
  /** Missile only: actively thrust AWAY when the target closes inside
   *  fireRange × this (artillery "stay away when engaging"). 0 for
   *  beam/bolt. */
  private readonly backoffInsideFactor: number;
  /** Muzzle speed used for the lead-aim time-to-target (`t = dist /
   *  leadMuzzleSpeed`). The bound weapon's REAL projectile speed for
   *  bolts/missiles (so the bolt is actually aimed at the intercept
   *  point); a huge value for hitscan so `t ≈ 0` (instantaneous beams
   *  need no lead). 2026-06-03 — replaces the single hardcoded
   *  LEAD_AIM_MUZZLE_SPEED, which 2×-over-led the 1600 u/s bolt. */
  private readonly leadMuzzleSpeed: number;

  /** 2026-05-31 — pooled per-instance scratches (Invariant #14). Pre-fix
   *  this class returned a fresh AiIntent literal per tick (~15 drones ×
   *  60 Hz = 900 allocs/sec from the AI brain alone); combined with the
   *  parallel `swarmEntitySnapshot` literal, V8 was running major GC
   *  every ~1 s for 100-334 ms stop-the-world pauses, blocking the
   *  server's `update()` loop → user-reported `recv_gap_long` 227-461 ms.
   *  Capture `hlqxy6` + `tests/diag/server-dispatch-gap-probe.ts`.
   *  Caller (AiController.runEntity) reads fields immediately + does not
   *  retain the reference, so mutating a single per-instance scratch
   *  across every `tick` call is safe. `fire` sub-object is its own
   *  pooled slot; we re-attach by reference each tick when firing. */
  private readonly _intentScratch: AiIntent = {
    fx: 0, fy: 0, torque: 0, setAngvel: undefined, fire: undefined,
  };
  private readonly _fireScratch: { dirX: number; dirY: number } = { dirX: 0, dirY: 0 };

  constructor(kind?: ShipKind | string) {
    // Accept the kind as either a `ShipKind` record or a kind id (string), so
    // tests that don't care about kind tuning can still construct with no
    // arg (`new HostileDroneBehaviour()` falls back to the catalogue default).
    this.kind = typeof kind === 'object' && kind !== null
      ? kind
      : getShipKind(typeof kind === 'string' ? kind : null);
    // Compute the half-arc of the widest rotating mount across the kind's
    // mounts. `arcMax - arcMin` is the FULL arc; halving it gives the
    // distance the mount can swing from `baseAngle` in either direction.
    // For interceptor wings (±π/6), this is π/6 ≈ 30°. For gunship rear
    // (±π/2), this is π/2 ≈ 90°. Multi-mount kinds use the maximum across
    // their mounts (e.g. gunship's rear dominates over the forward's ±π/4).
    let maxHalf = 0;
    for (const m of this.kind.mounts ?? []) {
      if (m.rotationSpeed <= 0) continue;
      const half = (m.arcMax - m.arcMin) / 2;
      if (half > maxHalf) maxHalf = half;
    }
    this.maxTurretHalfArc = maxHalf;

    // Weapon-aware engagement profile (weapons/energy/AI overhaul §4).
    const firstWeapon = getWeapon(this.kind.mounts?.[0]?.weaponId ?? 'hitscan');
    this.weaponMode = firstWeapon.mode;
    this.fireCooldownTicks = firstWeapon.cooldownTicks;
    // Lead-aim muzzle speed: real projectile speed for bolts/missiles,
    // ~instant for hitscan (no lead). Drives the intercept in tickCombat.
    this.leadMuzzleSpeed = firstWeapon.mode === 'hitscan' ? 1e6 : firstWeapon.speed;
    if (firstWeapon.mode === 'hitscan') {
      // Beam: very close range — bore in to ~90 % of the beam's reach.
      this.fireRange = firstWeapon.range * 0.9;
      this.stopDistFactor = 0.5;
      this.backoffInsideFactor = 0;
    } else if (firstWeapon.mode === 'projectile') {
      // Bolt: medium dogfight range ≈ half the projectile's max travel.
      this.fireRange = (firstWeapon.speed * firstWeapon.maxTicks / 60) * 0.5;
      this.stopDistFactor = 0.6;
      this.backoffInsideFactor = 0;
    } else {
      // Missile: long-range artillery; kite the target, fire from afar.
      this.fireRange = 1400;
      this.stopDistFactor = 0.9;
      this.backoffInsideFactor = 0.4;
    }
  }

  /** Test-visible engagement profile. */
  getFireRange(): number { return this.fireRange; }
  getWeaponMode(): WeaponMode { return this.weaponMode; }

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

  /** Render-side query: is this drone currently treating `playerId` as
   *  a hostile target? Pure, side-effect-free — safe to poll every frame. */
  isHostileToPlayer(playerId: string): boolean {
    return this.hostileTo.has(playerId);
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
    // If the purged player was the sticky target, drop the sticky pin so
    // the next `pickTarget` call doesn't try to keep them.
    if (this.prevTargetId === playerId) this.prevTargetId = null;
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
          // Drop the sticky pin if the decayed player was our target.
          if (this.prevTargetId === pid) this.prevTargetId = null;
        }
      }
      if (this.hostileTo.size === 0) this.state = 'IDLE';
    }

    // 2) IDLE → patrol. Behaviour returns deterministic intent purely from
    //    `self`, so server and client AI controllers produce identical
    //    outputs when given the same drone pose (lockstep-safe).
    if (this.state === 'IDLE') return this.tickPatrol(self);

    // 3) COMBAT — pick the *hostile* player to engage. Non-hostile players
    //    are invisible to a drone in combat (so a bystander flying through
    //    a fight isn't suddenly targeted). Phase 4a (2026-05-11): delegate
    //    to the shared `WeaponMountController.pickTarget`, which adds sticky
    //    hysteresis so the drone doesn't flap between two near-equidistant
    //    targets every tick. The same module powers the player-turret AI
    //    coming in Phase 4b — single ownership site for the targeting
    //    policy. When no hostile is in view this frame, fall back to patrol
    //    motion but stay in COMBAT state until the time-decay clears the set.
    // Part C — smarter selection: bias toward the lowest-health hostile and
    // hold the choice for DRONE_TARGET_DWELL_TICKS before re-evaluating (so a
    // pack focus-fires the wounded instead of all flipping targets per tick).
    const target = pickTarget(
      self.x, self.y, view.players, this.prevTargetId, (id) => this.hostileTo.has(id),
      {
        healthWeight: DRONE_TARGET_HEALTH_WEIGHT,
        dwellTicks: DRONE_TARGET_DWELL_TICKS,
        ticksSincePrevTarget: view.tick - this.prevTargetSinceTick,
      },
    );
    const newId = target?.id ?? null;
    if (newId !== this.prevTargetId) this.prevTargetSinceTick = view.tick;
    this.prevTargetId = newId;
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

    const desiredAngle = Math.atan2(-dirX, dirY);
    const setAngvel = this.angvelTarget(desiredAngle - self.angle);

    // Gentle forward thrust along current facing — once the heading has
    // settled, this drives the orbital motion.
    const fwdX = -Math.sin(self.angle);
    const fwdY = Math.cos(self.angle);
    const thrustMag = this.kind.ai.thrust * PATROL_THRUST_SCALE;
    const out = this._intentScratch;
    out.fx = fwdX * thrustMag;
    out.fy = fwdY * thrustMag;
    out.torque = 0;
    out.setAngvel = setAngvel;
    out.fire = undefined;
    return out;
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
      const zero = this._intentScratch;
      zero.fx = 0;
      zero.fy = 0;
      zero.torque = 0;
      zero.setAngvel = undefined;
      zero.fire = undefined;
      return zero;
    }

    // Lead-aim: estimate where the target will be when our shot lands.
    // For hitscan `t` is tiny so this barely shifts the aim; for moving
    // targets it lets the drone aim ahead of them. Using a constant
    // muzzle speed (rather than per-weapon) so the same code path covers
    // both projectile and hitscan modes — the worst case is a small
    // over-lead on hitscan, well within the aim tolerance.
    // First-order intercept in the SHOOTER's frame. The bolt inherits the
    // shooter's velocity at spawn (self.v + dir·speed), so the lead must
    // use the target's velocity RELATIVE to the shooter and the weapon's
    // real muzzle speed (hitscan → leadMuzzleSpeed huge → t≈0 → no lead).
    const t = dist / this.leadMuzzleSpeed;
    const aimX = target.x + (target.vx - self.vx) * t;
    const aimY = target.y + (target.vy - self.vy) * t;
    const aimDx = aimX - self.x;
    const aimDy = aimY - self.y;

    // Bearing toward the lead-aim point, not the target's current pose.
    const desiredAngle = Math.atan2(-aimDx, aimDy);
    const bearingError = wrapPi(desiredAngle - self.angle);

    // Player-equivalent snap turn: target angvel = ±maxAngvel (or zero
    // inside the dead zone), to be applied via `body.setAngvel` rather
    // than fought with damping. See `angvelTarget` for the ramp.
    const setAngvel = this.angvelTarget(bearingError);

    // 2026-06-01 — arrival-style standoff. Before this change, the drone
    // thrusted forward at `baseThrust` whenever it was within fire range,
    // which meant a fast-closing drone would sail through the target and
    // overshoot by hundreds of units before turning around — the
    // user-reported "flies past way too quickly… never approaches"
    // behaviour. The drone now targets a stopping distance of ~60 % of
    // fire range and BRAKES (reverse thrust along its forward axis) when
    // it's closing too fast for that distance. Inside the stopping
    // distance, it idles or backpedals to maintain spacing.
    //
    // The closing speed = (self.vel · dir_to_target). Positive = drone
    // is approaching; the cap scales with remaining distance so the
    // drone arrives at near-zero relative speed.
    // Weapon-aware standoff (weapons/energy/AI overhaul §4). STOP_DIST and
    // the engagement profile are derived per-weapon in the constructor:
    // beam bores to ~50 % of its (short) fire range, bolt keeps the mid-range
    // dogfight, missile kites at ~90 % of its (long) fire range and actively
    // backs off if the target closes inside `fireRange × backoffInsideFactor`.
    const baseThrust = this.kind.ai.thrust;
    const STOP_DIST = this.fireRange * this.stopDistFactor;
    const closingSpeed = (self.vx * rawDx + self.vy * rawDy) / dist;

    let thrustMag: number;
    if (this.backoffInsideFactor > 0 && dist < this.fireRange * this.backoffInsideFactor) {
      // Missile kite — the target is too close for comfortable artillery
      // fire; thrust AWAY (reverse along the forward axis, which currently
      // points at the target) to re-open the gap.
      thrustMag = -baseThrust;
    } else if (dist > this.fireRange * ENGAGE_DISTANCE_RATIO) {
      // Far engagement — boost in.
      thrustMag = baseThrust * ENGAGE_BOOST;
    } else if (dist > STOP_DIST) {
      // Approach window. Cap closing speed so we can arrive at near-
      // zero relative velocity. The cap grows linearly with the gap to
      // the stopping distance; 1.5× the gap (units/sec per unit) gives
      // ~1 s to bleed off speed for typical maxSpeed values.
      const maxClosing = Math.min(120, (dist - STOP_DIST) * 1.5 + 20);
      thrustMag = closingSpeed > maxClosing ? -baseThrust * 0.7 : baseThrust;
    } else {
      // Inside stopping distance — actively decelerate. If we're still
      // closing, hard brake; otherwise hover (let damping settle).
      thrustMag = closingSpeed > 5 ? -baseThrust : 0;
    }

    const fwdX = -Math.sin(self.angle);
    const fwdY = Math.cos(self.angle);
    const fx = fwdX * thrustMag;
    const fy = fwdY * thrustMag;

    // Fire gating: standard 14° cone at normal distance widens to 26° at
    // point-blank so brawls actually trade fire instead of dancing
    // around each other waiting for a perfect line-up.
    //
    // Phase 4c (2026-05-11): kinds with rotating mounts add the widest
    // mount's half-arc to the body-aim tolerance, so a drone fires when
    // a turret can reach the target even when the body itself is off.
    // Interceptor wings (±π/6 = ±30°) → tolerance ~44°. Gunship rear
    // (±π/2 = ±90°) → tolerance ~104° (drone fires even when target is
    // almost directly behind). Without this, the drone's body-aim gate
    // suppressed fires that the turret AI would otherwise resolve as
    // hits — the "AI doesn't shoot sometimes when I'm in range" symptom.
    const baseTolerance = dist < this.fireRange * POINT_BLANK_RATIO
      ? DRONE_AIM_TOLERANCE_CLOSE
      : DRONE_AIM_TOLERANCE;
    const aimTolerance = baseTolerance + this.maxTurretHalfArc;

    const aimed = Math.abs(bearingError) <= aimTolerance;
    const inRange = dist <= this.fireRange;
    const offCooldown = view.tick - this.lastFireTick >= this.fireCooldownTicks;
    const willFire = aimed && inRange && offCooldown;
    if (willFire) this.lastFireTick = view.tick;

    const intent = this._intentScratch;
    intent.fx = fx;
    intent.fy = fy;
    intent.torque = 0;
    intent.setAngvel = setAngvel;
    if (willFire) {
      const f = this._fireScratch;
      // Fire along the EXACT lead vector, NOT the body-forward axis. The
      // body only turns toward the lead at a rate-limited angvel and is
      // allowed to fire anywhere inside the (wide) aim cone, so body-forward
      // ≈ lead but off by up to the tolerance — enough to miss a moving
      // target at range. Aiming the shot itself at the intercept point
      // decouples accuracy from the imperfect body aim. The fix that makes
      // bolts actually connect (2026-06-03). Hitscan: leadMuzzleSpeed huge
      // → aim ≈ straight at the target, so beams are unchanged.
      const aimLen = Math.hypot(aimDx, aimDy);
      if (aimLen > 1e-6) {
        f.dirX = aimDx / aimLen;
        f.dirY = aimDy / aimLen;
      } else {
        f.dirX = fwdX;
        f.dirY = fwdY;
      }
      intent.fire = f;
    } else {
      intent.fire = undefined;
    }
    return intent;
  }

  /**
   * Map a (wrapped) bearing-error to the angular velocity the drone
   * wants this tick. Mirrors the player's input behaviour: snap to
   * `±kind.maxAngvel` while turning, snap to zero when aimed.
   * Linear ramp inside `±TURN_RAMP_WINDOW` so the drone slows into
   * the bearing instead of overshooting.
   */
  private angvelTarget(rawError: number): number {
    const err = wrapPi(rawError);
    if (Math.abs(err) <= TURN_DEADZONE) return 0;
    const sign = err > 0 ? 1 : -1;
    const ramp = Math.min(1, Math.abs(err) / TURN_RAMP_WINDOW);
    return sign * ramp * this.kind.maxAngvel;
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
