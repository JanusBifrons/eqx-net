import { describe, it, expect } from 'vitest';
import { DOUBLE_TAP_MS, DOUBLE_TAP_SLOP_PX, DoubleTapTracker } from './doubleTap.js';

describe('DoubleTapTracker (RTS slice 10: double-click own ship = take the controls)', () => {
  it('two taps on the same ship, close in time and space, are a double tap', () => {
    const d = new DoubleTapTracker();
    expect(d.tap('hull-1', 1000, 100, 100)).toBe(false);
    expect(d.tap('hull-1', 1000 + DOUBLE_TAP_MS - 1, 104, 98)).toBe(true);
  });

  it('a completed double tap resets: a third tap starts a new pair', () => {
    const d = new DoubleTapTracker();
    d.tap('hull-1', 0, 0, 0);
    expect(d.tap('hull-1', 100, 0, 0)).toBe(true);
    expect(d.tap('hull-1', 200, 0, 0)).toBe(false);
    expect(d.tap('hull-1', 300, 0, 0)).toBe(true);
  });

  it('too slow is two single taps', () => {
    const d = new DoubleTapTracker();
    d.tap('hull-1', 0, 0, 0);
    expect(d.tap('hull-1', DOUBLE_TAP_MS + 1, 0, 0)).toBe(false);
  });

  it('a different ship, or too far away, is not a double tap', () => {
    const d = new DoubleTapTracker();
    d.tap('hull-1', 0, 0, 0);
    expect(d.tap('hull-2', 50, 0, 0)).toBe(false);
    const e = new DoubleTapTracker();
    e.tap('hull-1', 0, 0, 0);
    expect(e.tap('hull-1', 50, DOUBLE_TAP_SLOP_PX + 1, 0)).toBe(false);
  });

  it('a tap off any own ship in between breaks the pair', () => {
    const d = new DoubleTapTracker();
    d.tap('hull-1', 0, 0, 0);
    d.tap(null, 50, 0, 0);
    expect(d.tap('hull-1', 100, 0, 0)).toBe(false);
  });
});
