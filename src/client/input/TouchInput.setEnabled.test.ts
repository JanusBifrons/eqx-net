/**
 * Plan: crispy-kazoo, Commit 4 — pause-boundary lock for the TouchInput
 * input gate.
 *
 *   - All setters are masked while disabled.
 *   - All getters return idle while disabled.
 *   - On disable, the in-flight joystick vector + held button bools are
 *     zeroed (no auto-thrust / auto-fire on resume).
 *   - Idempotent: second `setEnabled(false)` is a no-op.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TouchInput } from './TouchInput.js';

let t: TouchInput;

beforeEach(() => {
  t = new TouchInput();
});

describe('TouchInput — pause boundary (setEnabled)', () => {
  it('all getters return idle when disabled', () => {
    t.setJoystick({ x: 0.5, y: 0.5 });
    t.setFireHeld(true);
    t.setBoostHeld(true);

    t.setEnabled(false);

    expect(t.getJoystickVector()).toBeNull();
    expect(t.getFireHeld()).toBe(false);
    expect(t.getBoostHeld()).toBe(false);
  });

  it('zeroes held state on disable so resume does NOT auto-act', () => {
    t.setJoystick({ x: 0.7, y: -0.4 });
    t.setFireHeld(true);
    t.setBoostHeld(true);

    t.setEnabled(false);
    t.setEnabled(true);

    // Even though we re-enabled, no fresh input has been posted so the
    // state must be idle.
    expect(t.getJoystickVector()).toBeNull();
    expect(t.getFireHeld()).toBe(false);
    expect(t.getBoostHeld()).toBe(false);

    // Fresh setter post-enable flows through.
    t.setJoystick({ x: 0.1, y: 0.2 });
    expect(t.getJoystickVector()).toEqual({ x: 0.1, y: 0.2 });
  });

  it('setters are masked while disabled', () => {
    t.setEnabled(false);
    t.setJoystick({ x: 0.5, y: 0 });
    t.setFireHeld(true);
    t.setBoostHeld(true);
    expect(t.getJoystickVector()).toBeNull();
    expect(t.getFireHeld()).toBe(false);
    expect(t.getBoostHeld()).toBe(false);
  });

  it('idempotent setEnabled — second false is a no-op', () => {
    t.setJoystick({ x: 1, y: 0 });
    expect(t.getJoystickVector()).toEqual({ x: 1, y: 0 });
    t.setEnabled(false);
    expect(t.getJoystickVector()).toBeNull();
    t.setEnabled(false);
    expect(t.getJoystickVector()).toBeNull();
  });

  it('setJoystickIdle is also masked while disabled', () => {
    t.setJoystick({ x: 1, y: 0 });
    t.setEnabled(false);
    // Calling setJoystickIdle while disabled is a no-op (state is
    // already null from the zero-on-disable step).
    t.setJoystickIdle();
    expect(t.getJoystickVector()).toBeNull();
  });
});
