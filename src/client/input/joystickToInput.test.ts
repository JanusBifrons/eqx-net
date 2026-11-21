/**
 * Unit lock for `joystickToInput` (2026-05-20 mobile-spiral fix). Pure
 * helper; deterministic over synthetic inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  joystickToInput,
  IDLE_INPUT_STATE,
  DEADZONE_ON,
  TURN_ON_RAD,
  type JoystickInputState,
} from './joystickToInput.js';
import { getShipKind } from '@shared-types/shipKinds';
import { maxTurnPerTick } from '@core/physics/applyShipInput';
import { STAT_POINT_FRAC } from '@core/leveling/shipStats';

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

// Owner phone smoke test: flying forward on the stick, the ship "would quite
// often jitter from left to right". The arcade handling pass (`turn` x 4.2)
// made a light hull turn ~0.14-0.21 rad per 60 Hz tick, wider than the whole
// TURN_OFF band (+-0.04): a ship 0.07 rad off the stick lands 0.07 rad off the
// other side, still outside TURN_OFF, flips direction, and repeats every tick.
// Closed loop over the real catalogue turn rate: a snap-turn hull (no
// `turnTorque`) rotates exactly +-maxAngvel/60 per tick while a turn bit is
// held and stops dead when released (`applyShipInput`).
describe('joystickToInput — closed loop at the real per-tick turn step', () => {
  // [kind, turnRate upgrade points]: scout/interceptor overshoot stock; the
  // default fighter crosses over at 3 turn points (1.15x).
  const cases: Array<[string, number]> = [['scout', 0], ['interceptor', 0], ['fighter', 0], ['fighter', 4]];
  for (const [kindId, points] of cases) {
    it(`${kindId} +${points} turn: a held stick settles, never flips left/right every tick`, () => {
      const kind = getShipKind(kindId);
      expect(kind.turnTorque).toBeUndefined();
      const step = maxTurnPerTick(kind, { topSpeed: 1, turnRate: 1 + points * STAT_POINT_FRAC });
      const stick = { x: 0, y: 1 }; // fly straight "up": target angle 0
      for (let i = 0; i < 200; i++) {
        const start = -1.2 + (2.4 * i) / 199;
        let angle = start;
        let prev: JoystickInputState = IDLE_INPUT_STATE;
        let flips = 0;
        let lastDir = 0;
        for (let t = 0; t < 120; t++) {
          const out = joystickToInput(stick, angle, prev, step);
          const dir = (out.turnLeft ? 1 : 0) - (out.turnRight ? 1 : 0);
          if (t >= 60 && dir !== 0 && lastDir !== 0 && dir !== lastDir) flips++;
          lastDir = dir;
          angle += dir * step;
          prev = { ...out };
        }
        expect(flips, `start offset ${start.toFixed(3)}`).toBe(0);
        expect(Math.abs(angle), `start offset ${start.toFixed(3)}`).toBeLessThanOrEqual(Math.max(TURN_ON_RAD, step / 2) + 1e-9);
      }
    });
  }
});
