/**
 * Aim bearings — the wire encoding (`encodeAim` / `decodeAim`, used by fire
 * control's `lock_track.b`) and the screen-stick / vector → world-bearing
 * helpers. Manual aim is retired (fire control is universal: every weapon
 * group aims + fires at its lock), and the input `aim` field was dropped from
 * the wire. Fails when:
 *  - the wire encoding stops round-tripping,
 *  - the bearing helpers leave the ship-angle convention,
 *  - the strict input schema starts accepting the retired `aim` field again.
 */
import { describe, it, expect } from 'vitest';
import {
  AIM_STEPS, encodeAim, decodeAim,
  stickToWorldBearing, vectorToWorldBearing,
} from '../../src/core/combat/manualAim.js';
import { wrapPi } from '../../src/core/ai/WeaponMountController.js';
import { InputMessageSchema } from '../../src/shared-types/messages.js';

describe('aim bearing wire encoding', () => {
  it('round-trips within one quantisation step', () => {
    const step = (2 * Math.PI) / AIM_STEPS;
    for (const b of [0, 0.5, -0.5, Math.PI - 1e-6, -Math.PI + 1e-6, 3, -3, 7.1, -9.4]) {
      const q = encodeAim(b);
      expect(Number.isInteger(q)).toBe(true);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThan(AIM_STEPS);
      expect(Math.abs(wrapPi(decodeAim(q) - b))).toBeLessThanOrEqual(step / 2 + 1e-9);
    }
  });

  it('screen stick + world vector use the ship-angle convention', () => {
    // Stick UP (y down negative) = bearing 0 = game +y.
    expect(stickToWorldBearing(0, -1)).toBeCloseTo(0);
    expect(vectorToWorldBearing(0, 1)).toBeCloseTo(0);
    // Stick RIGHT = -π/2 (same as joystickToInput's mapping).
    expect(stickToWorldBearing(1, 0)).toBeCloseTo(-Math.PI / 2);
    expect(vectorToWorldBearing(1, 0)).toBeCloseTo(-Math.PI / 2);
  });
});

describe('input schema', () => {
  const base = { type: 'input', tick: 1, thrust: false, turnLeft: false, turnRight: false };
  it('rejects the retired manual-aim field (strict schema)', () => {
    expect(InputMessageSchema.safeParse(base).success).toBe(true);
    expect(InputMessageSchema.safeParse({ ...base, aim: 0 }).success).toBe(false);
  });
});
