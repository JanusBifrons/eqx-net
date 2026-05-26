import { describe, it, expect } from 'vitest';
import { classifyTap } from './tapVsDrag.js';

const THRESH = { tapThresholdPx: 6, tapThresholdMs: 250 };

describe('classifyTap', () => {
  it('zero movement, short duration → tap', () => {
    const r = classifyTap(100, 100, 100, 100, 1000, 1100, THRESH);
    expect(r.isTap).toBe(true);
    expect(r.distancePx).toBe(0);
    expect(r.elapsedMs).toBe(100);
  });

  it('distance >= threshold → not a tap', () => {
    const r = classifyTap(100, 100, 110, 100, 1000, 1100, THRESH);
    expect(r.isTap).toBe(false);
    expect(r.distancePx).toBe(10);
  });

  it('distance just under threshold → tap', () => {
    const r = classifyTap(100, 100, 105, 100, 1000, 1100, THRESH);
    expect(r.isTap).toBe(true);
    expect(r.distancePx).toBe(5);
  });

  it('duration >= threshold → not a tap (even at zero distance)', () => {
    const r = classifyTap(100, 100, 100, 100, 1000, 1300, THRESH);
    expect(r.isTap).toBe(false);
    expect(r.elapsedMs).toBe(300);
  });

  it('diagonal distance counted via hypot', () => {
    const r = classifyTap(100, 100, 103, 104, 1000, 1100, THRESH);
    expect(r.isTap).toBe(true);
    expect(r.distancePx).toBe(5); // 3,4,5 triangle
  });

  it('threshold boundary (exactly at limit) → not a tap', () => {
    const r1 = classifyTap(0, 0, 6, 0, 0, 100, THRESH);
    expect(r1.isTap).toBe(false); // distance === threshold → not strict less
    const r2 = classifyTap(0, 0, 0, 0, 0, 250, THRESH);
    expect(r2.isTap).toBe(false); // elapsed === threshold → not strict less
  });
});
