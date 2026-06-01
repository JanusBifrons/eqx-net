/**
 * Pure joystick→boolean-input resolver with HYSTERESIS bands.
 *
 * **Why this module exists** (2026-05-20 mobile-spiral triage): the
 * inline conversion at `ColyseusClient.tickPhysics()` (~L2766) had NO
 * hysteresis. As the ship rotates toward the stick target, `delta =
 * targetAngle - shipAngle` crosses the `TOUCH_TURN_TOLERANCE` (0.08
 * rad) threshold — turnLeft/turnRight toggles. Analog stick noise
 * nudges delta back across — toggle again. Empirical 10 Hz state-change
 * rate under steady stick use. Each toggle drives a fresh input
 * message + reconcile-replay event on the server, producing a 3-second
 * drift transient per toggle (`spiral-in-pack-density.spec.ts` shows
 * 8-27 corrections in the first 3s of held W). Repeated state-changes
 * at 10 Hz keep the prediction state perpetually un-converged.
 *
 * **The fix shape**: separate ON and OFF thresholds for each control:
 *
 *   - Turn: enabled when |delta| > TURN_ON_THRESHOLD; disabled when
 *     |delta| < TURN_OFF_THRESHOLD. Until delta climbs back above
 *     TURN_ON, the previous turn state is held.
 *   - Thrust: enabled when |delta| < THRUST_ON_CONE AND mag >
 *     THRUST_ON_MAG; disabled when |delta| > THRUST_OFF_CONE OR mag <
 *     THRUST_OFF_MAG. Same kind of band.
 *   - Stick presence: enabled when mag > DEADZONE_ON; disabled when
 *     mag < DEADZONE_OFF (so a finger micro-release doesn't drop
 *     everything to zero then re-engage).
 *
 * Pure module: zero state hidden inside; the caller (tickPhysics)
 * passes in the previous boolean output and gets the new one. Two
 * benefits: trivially unit-testable, and the boolean state survives
 * the kind of mid-loop ColyseusGameClient refactors that have
 * historically broken implicit state machines.
 */

/** Stick magnitude threshold to engage ANY input. Wider band than the
 *  previous single TOUCH_DEADZONE=0.2 so a finger micro-release doesn't
 *  cycle the whole input off and back on. */
export const DEADZONE_ON = 0.22;
export const DEADZONE_OFF = 0.15;

/** Turn threshold band (radians). |delta| > TURN_ON enables turn;
 *  < TURN_OFF disables. Previous TOUCH_TURN_TOLERANCE was 0.08 with no
 *  hysteresis ⇒ flicker. The ON value is bumped slightly so the band
 *  is meaningful while still feeling responsive. */
export const TURN_ON_RAD = 0.10;
export const TURN_OFF_RAD = 0.04;

/** Thrust ON/OFF cone band — thrust fires when ship faces close to
 *  target. Tighter ON than previous TOUCH_THRUST_CONE=π/3 so thrust
 *  doesn't engage while the ship is still aggressively turning. */
export const THRUST_ON_CONE_RAD = Math.PI / 3; // 60°
export const THRUST_OFF_CONE_RAD = Math.PI / 2; // 90°
export const THRUST_ON_MAG = 0.42;
export const THRUST_OFF_MAG = 0.30;

export interface JoystickInputState {
  /** Whether the ship is presently considered "engaged" with the
   *  joystick (mag > deadzone). Hysteresis on the DEADZONE band. */
  engaged: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  thrust: boolean;
}

export const IDLE_INPUT_STATE: JoystickInputState = {
  engaged: false,
  turnLeft: false,
  turnRight: false,
  thrust: false,
};

/**
 * Module-level scratch for engaged-state returns (plan: melodic-
 * engelbart, Step 4 follow-on — phone-overwhelmed hypothesis,
 * 2026-05-30). Pre-pool, every engaged return allocated a fresh
 * {engaged, turnLeft, turnRight, thrust} literal — at 60 Hz with the
 * joystick held, that's 4.8 KB/sec of phone-side allocation (touch-
 * only; desktop branch in tickPhysics never enters this code).
 *
 * The caller stores the returned ref as `this._joystickInputState`
 * across ticks. Reusing the same scratch is safe because each
 * engaged return fully overwrites all four fields. The IDLE return
 * path (separate singleton) handles release/dead-zone transitions.
 */
const _ENGAGED_SCRATCH: JoystickInputState = {
  engaged: true,
  turnLeft: false,
  turnRight: false,
  thrust: false,
};

/**
 * Compute the next joystick boolean state given the raw stick vector,
 * the ship's current angle (radians), and the previous boolean state.
 * Pure function: same args → same result.
 *
 * @param vector nipplejs raw vector, axis -1..1 each. y > 0 = stick UP
 *               (nipplejs's own convention is already screen-inverted).
 *               Pass `null` when the user has released the stick.
 * @param shipAngle ship's current heading in radians (Y-up world).
 * @param prev previous boolean state for hysteresis. Pass
 *             `IDLE_INPUT_STATE` on first invocation / after stick release.
 */
export function joystickToInput(
  vector: { x: number; y: number } | null,
  shipAngle: number,
  prev: JoystickInputState,
): JoystickInputState {
  if (vector === null) return IDLE_INPUT_STATE;

  const mag = Math.hypot(vector.x, vector.y);

  // Engagement band — once engaged, stay engaged until mag drops below
  // DEADZONE_OFF. Prevents flicker when stick hovers around 0.2.
  let engaged: boolean;
  if (prev.engaged) {
    engaged = mag > DEADZONE_OFF;
  } else {
    engaged = mag > DEADZONE_ON;
  }
  if (!engaged) return IDLE_INPUT_STATE;

  // Physics-to-stick angle mapping: ship at angle θ has forward =
  // (-sin θ, cos θ). Stick UP (v=(0,1)) → forward=(0,1) → θ=0.
  // Stick RIGHT (v=(1,0)) → forward=(1,0) → θ=-π/2.
  const targetAngle = Math.atan2(-vector.x, vector.y);
  let delta = targetAngle - shipAngle;
  // Wrap to [-π, π] so the ship turns the short way around.
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const absDelta = Math.abs(delta);

  // Turn — hysteresis on |delta|. Previous turn direction is preserved
  // until |delta| drops below TURN_OFF_RAD; new turn engages only when
  // |delta| crosses TURN_ON_RAD.
  let turnLeft = false;
  let turnRight = false;
  const wasTurning = prev.turnLeft || prev.turnRight;
  if (wasTurning) {
    // Stay turning until absDelta drops below TURN_OFF_RAD.
    if (absDelta > TURN_OFF_RAD) {
      // Decide direction by current sign — the user may have swept the
      // stick across centre while ship was still rotating. Sign of delta
      // is authoritative; previous direction is just the engagement gate.
      if (delta > 0) turnLeft = true;
      else turnRight = true;
    }
  } else {
    // Need to cross the higher TURN_ON threshold to engage.
    if (absDelta > TURN_ON_RAD) {
      if (delta > 0) turnLeft = true;
      else turnRight = true;
    }
  }

  // Thrust — hysteresis on cone (|delta| being small) AND on mag.
  // Thrust stays ON until cone OR mag falls below their OFF thresholds.
  let thrust: boolean;
  if (prev.thrust) {
    thrust = absDelta < THRUST_OFF_CONE_RAD && mag > THRUST_OFF_MAG;
  } else {
    thrust = absDelta < THRUST_ON_CONE_RAD && mag > THRUST_ON_MAG;
  }

  // Mutate the pooled scratch — caller stores the ref as
  // `this._joystickInputState` which IS this scratch, so subsequent
  // reads of `prev.engaged/turnLeft/etc.` see the previous tick's
  // computed values (we fully overwrite all fields each engaged
  // return, so there's no stale-field leak).
  _ENGAGED_SCRATCH.turnLeft = turnLeft;
  _ENGAGED_SCRATCH.turnRight = turnRight;
  _ENGAGED_SCRATCH.thrust = thrust;
  return _ENGAGED_SCRATCH;
}
