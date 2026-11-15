import { describe, it, expect } from 'vitest';
import { ANGLE_STEPS, unitDirFromSteps } from './unitDir.js';

describe('unitDirFromSteps (arithmetic-only directions)', () => {
  it('matches cos/sin to 1e-12 at every u16 step, and is a unit vector', () => {
    let worst = 0;
    const out = { x: 0, y: 0 };
    for (let a = 0; a < ANGLE_STEPS; a++) {
      unitDirFromSteps(a, out);
      const t = (a / ANGLE_STEPS) * Math.PI * 2;
      worst = Math.max(worst, Math.abs(out.x - Math.cos(t)), Math.abs(out.y - Math.sin(t)));
    }
    expect(worst).toBeLessThan(1e-12);
    const d = unitDirFromSteps(12345.4);
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 12);
  });

  it('wraps whole turns and negative angles', () => {
    expect(unitDirFromSteps(-16384)).toEqual(unitDirFromSteps(3 * 16384));
    expect(unitDirFromSteps(ANGLE_STEPS + 100)).toEqual(unitDirFromSteps(100));
  });
});
