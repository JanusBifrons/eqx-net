import { describe, it, expect } from 'vitest';
import { AimInput } from './AimInput';
import { cursorBearing } from './MouseLock';

describe('AimInput (desktop RMB boost)', () => {
  it('holds boost while enabled', () => {
    const a = new AimInput();
    a.setBoostHeld(true);
    expect(a.getBoostHeld()).toBe(true);
    a.setBoostHeld(false);
    expect(a.getBoostHeld()).toBe(false);
  });

  it('disabling drops boost and masks the setter', () => {
    const a = new AimInput();
    a.setBoostHeld(true);
    a.setEnabled(false);
    expect(a.getBoostHeld()).toBe(false);
    a.setBoostHeld(true);
    expect(a.getBoostHeld()).toBe(false);
    a.setEnabled(true);
    expect(a.getBoostHeld()).toBe(false);
  });
});

describe('MouseLock cursorBearing', () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 };
  it('is the bearing from the surface centre (the pilot camera centre)', () => {
    expect(cursorBearing(100, 0, rect)).toBeCloseTo(0); // straight up
    expect(cursorBearing(200, 50, rect)).toBeCloseTo(-Math.PI / 2); // right
    expect(Math.abs(cursorBearing(100, 100, rect))).toBeCloseTo(Math.PI); // down
  });
});
