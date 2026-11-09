import { describe, it, expect } from 'vitest';
import { AimInput, AIM_STICK_DEADZONE } from './AimInput';
import { cursorBearing } from './MouseAim';
import { hullArcColor, statusArcAlpha } from '../render/AimFeedbackRenderer';

describe('AimInput', () => {
  it('a stick inside the dead zone is touching but not aiming', () => {
    const a = new AimInput();
    a.setStick(AIM_STICK_DEADZONE * 0.5, 0);
    expect(a.isTouching()).toBe(true);
    expect(a.isAiming()).toBe(false);
    a.setStick(0, -1); // up
    expect(a.isAiming()).toBe(true);
    expect(a.getBearing()).toBeCloseTo(0);
    a.clear();
    expect(a.isAiming()).toBe(false);
    expect(a.isTouching()).toBe(false);
  });

  it('disabling drops aim and boost and masks setters', () => {
    const a = new AimInput();
    a.setWorldBearing(1);
    a.setBoostHeld(true);
    a.setEnabled(false);
    expect(a.isAiming()).toBe(false);
    expect(a.getBoostHeld()).toBe(false);
    a.setWorldBearing(1);
    expect(a.isAiming()).toBe(false);
    a.setEnabled(true);
    expect(a.isAiming()).toBe(false);
  });
});

describe('MouseAim cursorBearing', () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 };
  it('is the bearing from the surface centre (the pilot camera centre)', () => {
    expect(cursorBearing(100, 0, rect)).toBeCloseTo(0); // straight up
    expect(cursorBearing(200, 50, rect)).toBeCloseTo(-Math.PI / 2); // right
    expect(Math.abs(cursorBearing(100, 100, rect))).toBeCloseTo(Math.PI); // down
  });
});

describe('aim feedback helpers', () => {
  it('hull arc colour bands match ShieldHullBar', () => {
    expect(hullArcColor(0.9)).toBe(0x4cff7a);
    expect(hullArcColor(0.4)).toBe(0xffb020);
    expect(hullArcColor(0.1)).toBe(0xff4040);
  });
  it('arcs dim only when every pool is full', () => {
    expect(statusArcAlpha(1, 1, 1)).toBeLessThan(0.2);
    expect(statusArcAlpha(1, 1, 0.5)).toBeGreaterThan(0.5);
  });
});
