import { describe, it, expect, vi, afterEach } from 'vitest';
import { TouchInput, isTouchDevice } from './TouchInput';

describe('TouchInput', () => {
  it('starts idle (vector null, fireHeld false)', () => {
    const input = new TouchInput();
    expect(input.getJoystickVector()).toBeNull();
    expect(input.getFireHeld()).toBe(false);
  });

  it('setJoystick stores the raw vector', () => {
    const input = new TouchInput();
    input.setJoystick({ x: 0.4, y: -0.7 });
    expect(input.getJoystickVector()).toEqual({ x: 0.4, y: -0.7 });
  });

  it('setJoystickIdle clears the vector', () => {
    const input = new TouchInput();
    input.setJoystick({ x: 0.5, y: -0.5 });
    input.setJoystickIdle();
    expect(input.getJoystickVector()).toBeNull();
  });

  it('setFireHeld toggles fireHeld', () => {
    const input = new TouchInput();
    input.setFireHeld(true);
    expect(input.getFireHeld()).toBe(true);
    input.setFireHeld(false);
    expect(input.getFireHeld()).toBe(false);
  });

  it('fireHeld and joystick are independent', () => {
    const input = new TouchInput();
    input.setFireHeld(true);
    input.setJoystick({ x: 0.5, y: -0.5 });
    expect(input.getFireHeld()).toBe(true);
    expect(input.getJoystickVector()).toEqual({ x: 0.5, y: -0.5 });
    input.setJoystickIdle();
    expect(input.getFireHeld()).toBe(true);
  });
});

describe('isTouchDevice', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when matchMedia coarse=false and maxTouchPoints=0', () => {
    vi.stubGlobal('window', { matchMedia: vi.fn().mockReturnValue({ matches: false }) });
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    expect(isTouchDevice()).toBe(false);
  });

  it('returns true when matchMedia reports coarse pointer', () => {
    vi.stubGlobal('window', { matchMedia: vi.fn().mockReturnValue({ matches: true }) });
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    expect(isTouchDevice()).toBe(true);
  });

  it('returns true when maxTouchPoints > 0', () => {
    vi.stubGlobal('window', { matchMedia: vi.fn().mockReturnValue({ matches: false }) });
    vi.stubGlobal('navigator', { maxTouchPoints: 5 });
    expect(isTouchDevice()).toBe(true);
  });
});
