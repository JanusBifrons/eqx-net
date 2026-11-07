/**
 * Phone report 2026-11-07 (sector trip): "whilst in warp the same star kept
 * flying past repeatedly in the same spot, there was little or no variety in
 * what scrolled past". Each speed line ran down one fixed lane and wrapped
 * every ~0.45 s, so the same streak passed the same spot over and over. Each
 * pass of a line must take a new lane.
 */
import { describe, it, expect } from 'vitest';
import { speedLineLane } from './WarpFx.js';

describe('warp speed lines vary between passes', () => {
  it('a line takes a different lane on each pass', () => {
    for (let i = 0; i < 28; i++) {
      const lanes = new Set<number>();
      for (let pass = 0; pass < 8; pass++) lanes.add(Math.round(speedLineLane(i, pass).lat * 100));
      expect(lanes.size).toBeGreaterThanOrEqual(6);
    }
  });

  it('lanes spread across the view and stay in range', () => {
    let min = 1, max = -1;
    for (let pass = 0; pass < 50; pass++) {
      const { lat, len } = speedLineLane(3, pass);
      expect(Math.abs(lat)).toBeLessThanOrEqual(1);
      expect(len).toBeGreaterThan(0);
      min = Math.min(min, lat); max = Math.max(max, lat);
    }
    expect(max - min).toBeGreaterThan(1.2);
  });

  it('is deterministic (same look every run)', () => {
    const a = { ...speedLineLane(5, 12) };
    expect({ ...speedLineLane(5, 12) }).toEqual(a);
  });
});
