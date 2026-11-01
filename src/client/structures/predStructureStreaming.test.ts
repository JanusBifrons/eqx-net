import { describe, expect, it } from 'vitest';
import { pointSegmentDistance, wantPredBody } from './predStructureStreaming.js';
import { PREDWORLD_STRUCTURE_HYSTERESIS, PREDWORLD_STRUCTURE_RADIUS } from '../../shared-types/structureBudgets.js';

describe('prediction world streaming (A3)', () => {
  it('streams a body in within the radius and keeps it until past the hysteresis band', () => {
    const R = PREDWORLD_STRUCTURE_RADIUS;
    const H = PREDWORLD_STRUCTURE_HYSTERESIS;
    expect(wantPredBody(false, R - 1)).toBe(true);
    expect(wantPredBody(false, R + 1)).toBe(false);
    expect(wantPredBody(true, R + H - 1)).toBe(true); // already in: kept a bit further out
    expect(wantPredBody(true, R + H + 1)).toBe(false);
  });

  it('measures distance to a wall segment, not just its ends', () => {
    expect(pointSegmentDistance(0, 100, -500, 0, 500, 0)).toBeCloseTo(100);
    expect(pointSegmentDistance(800, 0, -500, 0, 500, 0)).toBeCloseTo(300);
    expect(pointSegmentDistance(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
  });
});
