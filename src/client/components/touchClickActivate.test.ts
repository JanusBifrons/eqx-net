/**
 * Shared touch/click activator — suppress-window logic (playtest 2026-06-10
 * Issue 1). Locks the pure predicate that drops the browser's trailing
 * synthesized click after a handled `onTouchStart`, so a touch toggle does not
 * double-fire (the AutoFireToggleButton flip-straight-back-ON trap).
 */
import { describe, it, expect } from 'vitest';
import { isClickSuppressed, TOUCH_CLICK_SUPPRESS_MS } from './touchClickActivate.js';

describe('isClickSuppressed', () => {
  it('suppresses a click that lands immediately after a touch', () => {
    expect(isClickSuppressed(1000, 1000)).toBe(true);
  });

  it('suppresses a click inside the window', () => {
    expect(isClickSuppressed(1000, 1000 + TOUCH_CLICK_SUPPRESS_MS - 1)).toBe(true);
  });

  it('allows a click exactly at the window boundary', () => {
    expect(isClickSuppressed(1000, 1000 + TOUCH_CLICK_SUPPRESS_MS)).toBe(false);
  });

  it('allows a deliberate later (desktop) click well past the window', () => {
    expect(isClickSuppressed(1000, 1000 + TOUCH_CLICK_SUPPRESS_MS + 5000)).toBe(false);
  });

  it('allows a click when no touch has ever fired (lastTouchMs=0)', () => {
    // A pure desktop session: lastTouchMs stays 0, now is large → never suppressed.
    expect(isClickSuppressed(0, 10_000)).toBe(false);
  });
});
