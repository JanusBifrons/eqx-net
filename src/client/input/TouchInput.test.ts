import { describe, it, expect, vi, afterEach } from 'vitest';
import { TouchInput, isTouchDevice } from './TouchInput';

describe('TouchInput', () => {
  it('starts with all inputs false', () => {
    const input = new TouchInput();
    expect(input.read()).toEqual({ thrust: false, turnLeft: false, turnRight: false, fireHeld: false });
  });

  it('stick up (y = -0.8) → thrust, no turn', () => {
    const input = new TouchInput();
    input.setJoystick({ x: 0, y: -0.8 });
    const s = input.read();
    expect(s.thrust).toBe(true);
    expect(s.turnLeft).toBe(false);
    expect(s.turnRight).toBe(false);
  });

  it('stick left (x = -0.9) → turnLeft', () => {
    const input = new TouchInput();
    input.setJoystick({ x: -0.9, y: 0 });
    const s = input.read();
    expect(s.turnLeft).toBe(true);
    expect(s.turnRight).toBe(false);
    expect(s.thrust).toBe(false);
  });

  it('stick right (x = 0.9) → turnRight', () => {
    const input = new TouchInput();
    input.setJoystick({ x: 0.9, y: 0 });
    const s = input.read();
    expect(s.turnRight).toBe(true);
    expect(s.turnLeft).toBe(false);
  });

  it('diagonal (x=0.7, y=-0.7) → thrust + turnRight', () => {
    const input = new TouchInput();
    input.setJoystick({ x: 0.7, y: -0.7 });
    const s = input.read();
    expect(s.thrust).toBe(true);
    expect(s.turnRight).toBe(true);
    expect(s.turnLeft).toBe(false);
  });

  it('sub-threshold values produce no input', () => {
    const input = new TouchInput();
    input.setJoystick({ x: 0.1, y: -0.2 });
    expect(input.read()).toEqual({ thrust: false, turnLeft: false, turnRight: false, fireHeld: false });
  });

  it('setJoystickIdle clears thrust and turns', () => {
    const input = new TouchInput();
    input.setJoystick({ x: 0.9, y: -0.9 });
    input.setJoystickIdle();
    const s = input.read();
    expect(s.thrust).toBe(false);
    expect(s.turnLeft).toBe(false);
    expect(s.turnRight).toBe(false);
  });

  it('setFireHeld toggles fireHeld', () => {
    const input = new TouchInput();
    input.setFireHeld(true);
    expect(input.read().fireHeld).toBe(true);
    input.setFireHeld(false);
    expect(input.read().fireHeld).toBe(false);
  });

  it('fireHeld survives joystick updates', () => {
    const input = new TouchInput();
    input.setFireHeld(true);
    input.setJoystick({ x: 0.5, y: -0.5 });
    expect(input.read().fireHeld).toBe(true);
  });
});

describe('isTouchDevice', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when matchMedia is coarse=false and maxTouchPoints=0', () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
    });
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    expect(isTouchDevice()).toBe(false);
  });

  it('returns true when matchMedia reports coarse pointer', () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn().mockReturnValue({ matches: true }),
    });
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    expect(isTouchDevice()).toBe(true);
  });

  it('returns true when maxTouchPoints > 0', () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn().mockReturnValue({ matches: false }),
    });
    vi.stubGlobal('navigator', { maxTouchPoints: 5 });
    expect(isTouchDevice()).toBe(true);
  });
});
