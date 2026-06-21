// @vitest-environment jsdom
/**
 * Phase 5 — WASD free-pan for spectator. Locks: emits velocity ONLY while
 * enabled (the gameplay Keyboard is disabled in spectator, so this is the only
 * camera driver and must NOT fire while piloting); the WASD→velocity convention
 * (A left / D right / W up / S down, matching the drag-pan sign); diagonal
 * normalisation; and a (0,0) stop on disable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpectatorPanInput, SPECTATOR_PAN_SPEED } from './SpectatorPanInput.js';

function keydown(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code }));
}
function keyup(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { code }));
}

describe('SpectatorPanInput (Phase 5 WASD pan)', () => {
  let onChange: ReturnType<typeof vi.fn>;
  let pan: SpectatorPanInput;

  beforeEach(() => {
    onChange = vi.fn();
    pan = new SpectatorPanInput(onChange as unknown as (vx: number, vy: number) => void);
  });

  it('emits NOTHING while disabled (piloting) — never drives the camera then', () => {
    keydown('KeyW');
    keydown('KeyD');
    expect(onChange).not.toHaveBeenCalled();
    pan.dispose();
  });

  it('W pans the view UP (+vy); the drag-pan sign convention', () => {
    pan.setEnabled(true);
    onChange.mockClear(); // setEnabled(true) emits the initial (0,0)
    keydown('KeyW');
    expect(onChange).toHaveBeenLastCalledWith(0, SPECTATOR_PAN_SPEED);
    pan.dispose();
  });

  it('A→left (+vx), D→right (−vx), S→down (−vy)', () => {
    pan.setEnabled(true);
    onChange.mockClear();
    keydown('KeyA');
    expect(onChange).toHaveBeenLastCalledWith(SPECTATOR_PAN_SPEED, 0);
    keyup('KeyA');
    keydown('KeyD');
    expect(onChange).toHaveBeenLastCalledWith(-SPECTATOR_PAN_SPEED, 0);
    keyup('KeyD');
    keydown('KeyS');
    expect(onChange).toHaveBeenLastCalledWith(0, -SPECTATOR_PAN_SPEED);
    pan.dispose();
  });

  it('normalises a diagonal so it is not √2 faster than a single axis', () => {
    pan.setEnabled(true);
    onChange.mockClear();
    keydown('KeyW');
    keydown('KeyD'); // up + right
    const [vx, vy] = onChange.mock.calls.at(-1)!;
    expect(Math.hypot(vx as number, vy as number)).toBeCloseTo(SPECTATOR_PAN_SPEED, 3);
    pan.dispose();
  });

  it('disabling emits a (0,0) stop so the camera does not keep drifting', () => {
    pan.setEnabled(true);
    keydown('KeyW');
    onChange.mockClear();
    pan.setEnabled(false);
    expect(onChange).toHaveBeenLastCalledWith(0, 0);
    pan.dispose();
  });
});
