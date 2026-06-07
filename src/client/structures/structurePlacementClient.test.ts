import { describe, it, expect } from 'vitest';
import { computePlacementPose, computePlacementPreview, PLACEMENT_AHEAD_GAP } from './structurePlacementClient.js';
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

describe('computePlacementPreview (Issue 5 — render-mirror ghost pose)', () => {
  it('returns null when no kind is selected (no preview)', () => {
    expect(computePlacementPreview({ x: 0, y: 0, angle: 0 }, null)).toBeNull();
  });

  it('lands at EXACTLY the computePlacementPose spot (no preview/commit drift)', () => {
    const ship = { x: 100, y: 50, angle: Math.PI / 3 };
    const pose = computePlacementPose(ship, 'turret');
    const preview = computePlacementPreview(ship, 'turret');
    expect(preview).not.toBeNull();
    expect(preview!.kind).toBe('turret');
    expect(preview!.x).toBeCloseTo(pose.x, 6);
    expect(preview!.y).toBeCloseTo(pose.y, 6);
    // Structures render as regular polygons — angle is 0 (no facing).
    expect(preview!.angle).toBe(0);
  });
});
