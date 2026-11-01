import { describe, expect, it } from 'vitest';
import {
  CLAIM_AT,
  RELEASE_AT,
  freshControl,
  isContested,
  stepControl,
  targetPressure,
  type ControlInputs,
} from './sectorControl.js';

const NONE: ControlInputs = { robots: 0, nexus: false, playerStructures: 0, players: 0 };

function run(s: ReturnType<typeof freshControl>, i: ControlInputs, seconds: number): number {
  let flips = 0;
  for (let t = 0; t < seconds; t++) if (stepControl(s, i, 1000)) flips++;
  return flips;
}

describe('sector control', () => {
  it('robots present push pressure up; players and bases push it down', () => {
    expect(targetPressure({ ...NONE, robots: 4 })).toBeGreaterThan(0);
    expect(targetPressure({ ...NONE, players: 2, playerStructures: 6 })).toBeLessThan(0);
    expect(targetPressure({ ...NONE, nexus: true, robots: 100 })).toBe(100); // clamped
  });

  it('a passing squad does not flip a sector instantly — pressure moves at a bounded rate', () => {
    const s = freshControl();
    stepControl(s, { ...NONE, robots: 6 }, 1000);
    expect(s.robotHeld).toBe(false);
    expect(s.pressure).toBeLessThan(CLAIM_AT);
  });

  it('a nexus sector is claimed, and stays claimed through a brief dip (hysteresis)', () => {
    const s = freshControl();
    run(s, { ...NONE, nexus: true }, 120);
    expect(s.robotHeld).toBe(true);
    // Players push back a little: pressure falls but stays above RELEASE_AT.
    const flips = run(s, { ...NONE, nexus: true, players: 2 }, 60);
    expect(flips).toBe(0);
    expect(s.pressure).toBeGreaterThan(RELEASE_AT);
    expect(s.robotHeld).toBe(true);
  });

  it('robots lose a sector once the pressure falls to RELEASE_AT', () => {
    const s = freshControl();
    run(s, { ...NONE, nexus: true }, 120);
    run(s, { ...NONE, players: 3, playerStructures: 5 }, 200);
    expect(s.robotHeld).toBe(false);
  });

  it('contested = robot-held with players or their bases present', () => {
    const s = freshControl();
    run(s, { ...NONE, nexus: true }, 120);
    expect(isContested(s, { ...NONE, nexus: true })).toBe(false);
    expect(isContested(s, { ...NONE, nexus: true, players: 1 })).toBe(true);
  });
});
