/**
 * Unit lock for `joystickToInput` (2026-05-20 mobile-spiral fix). Pure
 * helper; deterministic over synthetic inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  joystickToInput,
  IDLE_INPUT_STATE,
  DEADZONE_ON,
  DEADZONE_OFF,
  TURN_ON_RAD,
  TURN_OFF_RAD,
  THRUST_ON_CONE_RAD,
  THRUST_ON_MAG,
  type JoystickInputState,
} from './joystickToInput.js';

describe('joystickToInput — null/idle', () => {
  it('returns IDLE when vector is null', () => {
    const out = joystickToInput(null, 0, IDLE_INPUT_STATE);
    expect(out).toEqual(IDLE_INPUT_STATE);
  });

  it('returns IDLE when stick magnitude < DEADZONE_ON and previously idle', () => {
    const out = joystickToInput({ x: 0.1, y: 0.1 }, 0, IDLE_INPUT_STATE);
    expect(out).toEqual(IDLE_INPUT_STATE);
  });
});

describe('joystickToInput — DEADZONE hysteresis', () => {
  it('engages only above DEADZONE_ON when previously idle', () => {
    const just_below = joystickToInput({ x: 0, y: DEADZONE_ON - 0.01 }, 0, IDLE_INPUT_STATE);
    expect(just_below.engaged).toBe(false);
    const just_above = joystickToInput({ x: 0, y: DEADZONE_ON + 0.01 }, 0, IDLE_INPUT_STATE);
    expect(just_above.engaged).toBe(true);
  });

  it('stays engaged down to DEADZONE_OFF when previously engaged', () => {
    const wasEngaged: JoystickInputState = { engaged: true, turnLeft: false, turnRight: false, thrust: false };
    // mag = 0.18 is between DEADZONE_OFF (0.15) and DEADZONE_ON (0.22).
    // Idle would say "not yet engaged"; engaged stays.
    const out = joystickToInput({ x: 0, y: 0.18 }, 0, wasEngaged);
    expect(out.engaged).toBe(true);
    // Drop to 0.10 — below DEADZONE_OFF.
    const released = joystickToInput({ x: 0, y: 0.10 }, 0, wasEngaged);
    expect(released.engaged).toBe(false);
  });
});

describe('joystickToInput — TURN hysteresis', () => {
  const stick = { x: 1, y: 0 }; // pointing RIGHT (mag=1) → targetAngle=-π/2

  it('does not engage turn when |delta| < TURN_ON_RAD and previously not turning', () => {
    // shipAngle = -π/2 + 0.05 → delta = -0.05 → |delta| = 0.05 < TURN_ON=0.10.
    const out = joystickToInput(stick, -Math.PI / 2 + 0.05, IDLE_INPUT_STATE);
    expect(out.turnLeft).toBe(false);
    expect(out.turnRight).toBe(false);
  });

  it('engages turn when |delta| > TURN_ON_RAD and previously not turning', () => {
    const out = joystickToInput(stick, -Math.PI / 2 + 0.15, IDLE_INPUT_STATE);
    // delta ≈ -0.15 → turnRight
    expect(out.turnRight).toBe(true);
    expect(out.turnLeft).toBe(false);
  });

  it('stays turning down to TURN_OFF_RAD when previously turning', () => {
    const wasTurning: JoystickInputState = { engaged: true, turnLeft: false, turnRight: true, thrust: false };
    // delta = -0.06 — below TURN_ON (0.10) but above TURN_OFF (0.04).
    const stillTurning = joystickToInput(stick, -Math.PI / 2 + 0.06, wasTurning);
    expect(stillTurning.turnRight).toBe(true);
    // delta = -0.02 — below TURN_OFF (0.04). Turn disengages.
    const stops = joystickToInput(stick, -Math.PI / 2 + 0.02, wasTurning);
    expect(stops.turnRight).toBe(false);
    expect(stops.turnLeft).toBe(false);
  });

  it('flips direction (left ↔ right) cleanly when delta sign changes', () => {
    const wasTurningRight: JoystickInputState = { engaged: true, turnLeft: false, turnRight: true, thrust: false };
    // Ship rotated PAST target — was turning right (CW), now ship is CCW of
    // target by 0.20 rad → delta = target - ship = -π/2 - (-π/2 + 0.20) = -0.20.
    // |delta| > TURN_ON, sign negative → turnRight. Wait — that's the
    // direction it was already going. Setup: ship overshot the target while
    // turning right; now needs to turn LEFT (CCW) to come back.
    // target = -π/2, ship = -π/2 - 0.20 (ship is CW of target by 0.20)
    // delta = -π/2 - (-π/2 - 0.20) = +0.20 → turnLeft.
    const out = joystickToInput(stick, -Math.PI / 2 - 0.20, wasTurningRight);
    expect(out.turnRight).toBe(false);
    expect(out.turnLeft).toBe(true);
  });

  it('does NOT toggle turn off when |delta| micro-fluctuates above TURN_OFF', () => {
    // The whole point of hysteresis. Simulate the analog noise crossing
    // TURN_ON_RAD repeatedly: previously turning, |delta| = 0.05 (between
    // TURN_OFF=0.04 and TURN_ON=0.10). Should stay turning.
    const wasTurning: JoystickInputState = { engaged: true, turnLeft: false, turnRight: true, thrust: false };
    for (let i = 0; i < 100; i++) {
      // delta wobbles between -0.05 and -0.08
      const wobble = -0.065 + Math.sin(i * 0.7) * 0.015;
      const out = joystickToInput(stick, -Math.PI / 2 + (-wobble), wasTurning);
      expect(out.turnRight, `iter ${i} wobble=${wobble.toFixed(3)}`).toBe(true);
    }
  });
});

describe('joystickToInput — THRUST hysteresis', () => {
  const stick = { x: 0, y: 1 }; // stick UP, mag=1 → targetAngle=0

  it('engages thrust when ship faces target and stick mag > THRUST_ON_MAG', () => {
    const out = joystickToInput(stick, 0, IDLE_INPUT_STATE);
    expect(out.thrust).toBe(true);
  });

  it('does not engage thrust below THRUST_ON_MAG when previously idle', () => {
    const out = joystickToInput({ x: 0, y: 0.38 }, 0, IDLE_INPUT_STATE);
    expect(out.thrust).toBe(false);
  });

  it('stays thrusting down to THRUST_OFF_MAG when previously thrusting', () => {
    const wasThrusting: JoystickInputState = { engaged: true, turnLeft: false, turnRight: false, thrust: true };
    // mag = 0.35 — between THRUST_OFF_MAG (0.30) and THRUST_ON_MAG (0.42).
    const still = joystickToInput({ x: 0, y: 0.35 }, 0, wasThrusting);
    expect(still.thrust).toBe(true);
    // mag = 0.25 — below OFF.
    const stops = joystickToInput({ x: 0, y: 0.25 }, 0, wasThrusting);
    expect(stops.thrust).toBe(false);
  });

  it('stays thrusting when |delta| exceeds THRUST_ON_CONE but stays under THRUST_OFF_CONE', () => {
    const wasThrusting: JoystickInputState = { engaged: true, turnLeft: false, turnRight: false, thrust: true };
    // delta = π/2 - 0.01 — between ON cone (π/3 ≈ 1.047) and OFF cone (π/2 ≈ 1.571).
    const stillTowardish = joystickToInput(stick, Math.PI / 2 - 0.01, wasThrusting);
    expect(stillTowardish.thrust).toBe(true);
    const facingAway = joystickToInput(stick, Math.PI - 0.01, wasThrusting);
    expect(facingAway.thrust).toBe(false);
  });
});

describe('joystickToInput — combined behaviour mirrors the legacy single-band logic on STEADY-STATE inputs', () => {
  it('stick UP, ship facing forward → thrust=true, no turn', () => {
    const out = joystickToInput({ x: 0, y: 1 }, 0, IDLE_INPUT_STATE);
    expect(out).toEqual({ engaged: true, turnLeft: false, turnRight: false, thrust: true });
  });

  it('stick to the side, ship facing forward → turn only (no thrust)', () => {
    // Stick LEFT → targetAngle = atan2(-(-1), 0) = π/2 → ship at 0, delta = π/2.
    // |delta| > THRUST_ON_CONE → thrust=false. delta > TURN_ON → turnLeft.
    const out = joystickToInput({ x: -1, y: 0 }, 0, IDLE_INPUT_STATE);
    expect(out.turnLeft).toBe(true);
    expect(out.turnRight).toBe(false);
    expect(out.thrust).toBe(false);
  });

  it('stick at 45°, ship aligned → both thrust and turn engaged', () => {
    // delta exactly π/4. |π/4| ≈ 0.785 < THRUST_ON_CONE (π/3 ≈ 1.047) → thrust.
    // |π/4| > TURN_ON (0.10) → turn.
    const out = joystickToInput({ x: -Math.sin(Math.PI / 4), y: Math.cos(Math.PI / 4) }, 0, IDLE_INPUT_STATE);
    expect(out.thrust).toBe(true);
    expect(out.turnLeft).toBe(true);
  });
});
