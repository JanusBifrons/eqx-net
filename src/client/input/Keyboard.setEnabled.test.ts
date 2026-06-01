/**
 * @vitest-environment jsdom
 *
 * Plan: crispy-kazoo, Commit 4 — pause-boundary lock for the Keyboard
 * input gate.
 *
 *   - `read()` returns IDLE when disabled, regardless of held keys.
 *   - `setEnabled(false)` zeroes held bools (no auto-thrust on resume).
 *   - DOM listeners stay attached when disabled (presses captured + masked).
 *   - User must re-press a key after `setEnabled(true)` for it to act.
 *
 * The keyboard is wired in App.tsx GameSurface via a useEffect on
 * `useIsLoadingActive`. This spec locks the Keyboard surface in
 * isolation; the integration is exercised by the gameRafLoop pause
 * spec and the E2E loading-screen test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keyboard } from './Keyboard.js';

let kb: Keyboard;

function press(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code }));
}
function release(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { code }));
}

describe('Keyboard — pause boundary (setEnabled)', () => {
  beforeEach(() => {
    kb = new Keyboard();
  });
  afterEach(() => {
    kb.dispose();
  });

  it('read() returns idle state when disabled', () => {
    press('KeyW');
    expect(kb.read().thrust).toBe(true);
    kb.setEnabled(false);
    const r = kb.read();
    expect(r.thrust).toBe(false);
    expect(r.turnLeft).toBe(false);
    expect(r.turnRight).toBe(false);
    expect(r.fireHeld).toBe(false);
    expect(r.boost).toBe(false);
    expect(r.reverse).toBe(false);
  });

  it('zeroes held bools on disable (no auto-thrust on resume)', () => {
    press('KeyW');
    press('ShiftLeft');
    press('Space');
    expect(kb.thrust).toBe(true);
    expect(kb.boost).toBe(true);

    kb.setEnabled(false);
    expect(kb.thrust).toBe(false);
    expect(kb.boost).toBe(false);
    expect(kb.reverse).toBe(false);

    // Re-enable: held bools stay zero until a fresh press.
    kb.setEnabled(true);
    expect(kb.read().thrust).toBe(false);
    expect(kb.read().boost).toBe(false);
    expect(kb.read().fireHeld).toBe(false);

    // Fresh press after enable → input flows again.
    press('KeyW');
    expect(kb.read().thrust).toBe(true);
  });

  it('keydown/keyup are masked while disabled — DOM listeners stay attached', () => {
    kb.setEnabled(false);
    // Press a key while disabled — should NOT register.
    press('KeyW');
    expect(kb.thrust).toBe(false);
    // Releases while disabled — should NOT crash or flip a "lingering true".
    release('KeyW');
    expect(kb.thrust).toBe(false);

    // Verify the DOM listener is still attached by re-enabling and
    // confirming a fresh press registers (would fail if listener torn down).
    kb.setEnabled(true);
    press('KeyD');
    expect(kb.turnRight).toBe(true);
  });

  it('idempotent setEnabled — second false is a no-op', () => {
    press('KeyA');
    expect(kb.turnLeft).toBe(true);
    kb.setEnabled(false);
    expect(kb.turnLeft).toBe(false);
    // Re-disable shouldn't blow up or re-zero something.
    kb.setEnabled(false);
    expect(kb.turnLeft).toBe(false);
  });

  it('dispose still tears down listeners (sanity)', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    kb.dispose();
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('keyup', expect.any(Function));
    removeSpy.mockRestore();
  });
});
