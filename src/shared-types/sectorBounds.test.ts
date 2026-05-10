import { describe, it, expect } from 'vitest';
import { SECTOR_PLAYABLE_HALF_EXTENT, clampToSectorBounds } from './sectorBounds.js';

describe('clampToSectorBounds', () => {
  it('passes through values inside the bounds', () => {
    const r = clampToSectorBounds(123, -456);
    expect(r.x).toBe(123);
    expect(r.y).toBe(-456);
    expect(r.clamped).toBe(false);
  });

  it('clamps positive overshoot to +half-extent', () => {
    const r = clampToSectorBounds(999_999, 999_999);
    expect(r.x).toBe(SECTOR_PLAYABLE_HALF_EXTENT);
    expect(r.y).toBe(SECTOR_PLAYABLE_HALF_EXTENT);
    expect(r.clamped).toBe(true);
  });

  it('clamps negative overshoot to -half-extent', () => {
    const r = clampToSectorBounds(-999_999, -999_999);
    expect(r.x).toBe(-SECTOR_PLAYABLE_HALF_EXTENT);
    expect(r.y).toBe(-SECTOR_PLAYABLE_HALF_EXTENT);
    expect(r.clamped).toBe(true);
  });

  it('clamps only the axis that overshoots', () => {
    const r = clampToSectorBounds(50, 999_999);
    expect(r.x).toBe(50);
    expect(r.y).toBe(SECTOR_PLAYABLE_HALF_EXTENT);
    expect(r.clamped).toBe(true);
  });

  it('treats the boundary as in-bounds (not clamped)', () => {
    const r = clampToSectorBounds(SECTOR_PLAYABLE_HALF_EXTENT, -SECTOR_PLAYABLE_HALF_EXTENT);
    expect(r.x).toBe(SECTOR_PLAYABLE_HALF_EXTENT);
    expect(r.y).toBe(-SECTOR_PLAYABLE_HALF_EXTENT);
    expect(r.clamped).toBe(false);
  });
});
