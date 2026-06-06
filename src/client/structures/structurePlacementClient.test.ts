import { describe, it, expect } from 'vitest';
import { computePlacementPose, PLACEMENT_AHEAD_GAP } from './structurePlacementClient.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';

describe('computePlacementPose', () => {
  it('drops the structure straight ahead (+y) at angle 0', () => {
    const pos = computePlacementPose({ x: 0, y: 0, angle: 0 }, 'connector');
    const expectedDist = 12 + getStructureKind('connector').radius + PLACEMENT_AHEAD_GAP;
    expect(pos.x).toBeCloseTo(0, 5);
    expect(pos.y).toBeCloseTo(expectedDist, 5);
  });

  it('uses the (-sin, cos) forward convention — angle π/2 points -x', () => {
    const pos = computePlacementPose({ x: 100, y: 50, angle: Math.PI / 2 }, 'solar');
    const dist = 12 + getStructureKind('solar').radius + PLACEMENT_AHEAD_GAP;
    // forward = (-sin(π/2), cos(π/2)) = (-1, 0)
    expect(pos.x).toBeCloseTo(100 - dist, 5);
    expect(pos.y).toBeCloseTo(50, 5);
  });

  it('scales clearance with the kind radius (capital lands further out than a connector)', () => {
    const cap = computePlacementPose({ x: 0, y: 0, angle: 0 }, 'capital');
    const con = computePlacementPose({ x: 0, y: 0, angle: 0 }, 'connector');
    expect(cap.y).toBeGreaterThan(con.y);
  });
});
