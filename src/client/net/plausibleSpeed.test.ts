import { describe, it, expect } from 'vitest';
import { TELEPORT_MAX_PLAUSIBLE_SPEED, TELEPORT_FLOOR_U, isImplausibleJump } from './plausibleSpeed.js';
import * as swarm from './swarmInterpolation.js';

describe('plausibleSpeed', () => {
  it('keeps the existing bound values', () => {
    expect(TELEPORT_MAX_PLAUSIBLE_SPEED).toBe(2500);
    expect(TELEPORT_FLOOR_U).toBe(64);
  });

  it('swarmInterpolation re-exports the same constants', () => {
    expect(swarm.TELEPORT_MAX_PLAUSIBLE_SPEED).toBe(TELEPORT_MAX_PLAUSIBLE_SPEED);
    expect(swarm.TELEPORT_FLOOR_U).toBe(TELEPORT_FLOOR_U);
  });

  it('is strict at the speed bound: exactly at it is plausible, just over is not', () => {
    // 100 ms at 2500 u/s = 250 u
    expect(isImplausibleJump(250, 100)).toBe(false);
    expect(isImplausibleJump(250.001, 100)).toBe(true);
  });

  it('uses the floor when speed x span underflows it', () => {
    // 10 ms at 2500 u/s = 25 u < 64 u floor
    expect(isImplausibleJump(64, 10)).toBe(false);
    expect(isImplausibleJump(64.001, 10)).toBe(true);
    expect(isImplausibleJump(64, 0)).toBe(false);
    expect(isImplausibleJump(65, 0)).toBe(true);
  });

  it('treats a negative span as zero (floor only)', () => {
    expect(isImplausibleJump(64, -500)).toBe(false);
    expect(isImplausibleJump(65, -500)).toBe(true);
  });
});
