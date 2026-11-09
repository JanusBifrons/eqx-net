/**
 * Manual aim for FIXED-gun ships (exp/hud-mobile-first): the guns can't slew,
 * so aiming turns the hull toward the aim bearing, and the move stick only
 * supplies forward thrust (any push direction → thrust, past a threshold).
 *
 * Same hysteresis style as `joystickToInput` (turn engages above TURN_ON,
 * releases below TURN_OFF; thrust engages above ON_MAG, releases below
 * OFF_MAG) so the turn/thrust BITS stay stable — rapid bit toggling is what
 * caused the 2026-05-20 prediction-correction spiral.
 *
 * Pure + alloc-free: mutates the caller-owned `state` in place.
 */
export interface AimSteerState {
  turnLeft: boolean;
  turnRight: boolean;
  thrust: boolean;
}

export const AIM_TURN_ON_RAD = 0.1;
export const AIM_TURN_OFF_RAD = 0.04;
export const AIM_THRUST_ON_MAG = 0.42;
export const AIM_THRUST_OFF_MAG = 0.3;

export function makeAimSteerState(): AimSteerState {
  return { turnLeft: false, turnRight: false, thrust: false };
}

export function resetAimSteer(s: AimSteerState): void {
  s.turnLeft = false;
  s.turnRight = false;
  s.thrust = false;
}

/**
 * @param aimBearing world bearing to face (ship-angle convention)
 * @param shipAngle  current (predicted) ship angle
 * @param moveMag    move-stick magnitude 0..1 (0 when idle)
 */
export function resolveAimSteer(
  aimBearing: number,
  shipAngle: number,
  moveMag: number,
  state: AimSteerState,
): AimSteerState {
  let delta = aimBearing - shipAngle;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const abs = Math.abs(delta);
  const wasTurning = state.turnLeft || state.turnRight;
  const turning = wasTurning ? abs > AIM_TURN_OFF_RAD : abs > AIM_TURN_ON_RAD;
  state.turnLeft = turning && delta > 0;
  state.turnRight = turning && delta <= 0;
  state.thrust = state.thrust ? moveMag > AIM_THRUST_OFF_MAG : moveMag > AIM_THRUST_ON_MAG;
  return state;
}
