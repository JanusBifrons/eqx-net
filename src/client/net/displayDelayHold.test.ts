import { describe, expect, it } from 'vitest';
import {
  createDisplayDelayHoldState, holdDisplayDelay, resetDisplayDelayHold, slewDisplayDelay,
} from './displayDelayHold.js';

const FRAME_MS = 16;
const GLIDE_MS = 50;

describe('displayDelayHold steadyMs (S5-6a)', () => {
  it('the hold grows delayMs and leaves steadyMs alone', () => {
    const s = createDisplayDelayHoldState(100);
    // Newest stamp 300 ms ago: the read point (now − 100) would pass newest + glide.
    holdDisplayDelay(s, 1000, 700, GLIDE_MS, 1);
    expect(s.holdActive).toBe(true);
    expect(s.delayMs).toBe(250);
    expect(s.steadyMs).toBe(100);
  });

  it('the slew moves steadyMs toward the target, independent of a held delayMs', () => {
    const s = createDisplayDelayHoldState(100);
    holdDisplayDelay(s, 1000, 700, GLIDE_MS, 1);
    s.targetMs = 150;
    slewDisplayDelay(s, FRAME_MS, 1);
    expect(s.steadyMs).toBeGreaterThan(100);
    expect(s.steadyMs).toBeLessThan(150);
    expect(s.delayMs).toBeLessThan(250);
  });

  it('reset puts steadyMs at the value', () => {
    const s = createDisplayDelayHoldState(100);
    s.steadyMs = 42;
    resetDisplayDelayHold(s, 120);
    expect(s.steadyMs).toBe(120);
  });
});
