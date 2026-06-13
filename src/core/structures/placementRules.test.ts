import { describe, it, expect } from 'vitest';
import { placementRejection, canPlaceStructureAt } from './placementRules.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import type { GridObstacle } from './Grid.js';

const CAPITAL_R = getStructureKind('capital').radius; // 80

describe('placementRules — canPlaceStructureAt / placementRejection (Phase-4 C2)', () => {
  it('is legal on empty ground (no structures, no obstacles)', () => {
    expect(placementRejection('capital', 0, 0, [])).toBeNull();
    expect(canPlaceStructureAt('capital', 0, 0, [])).toBe(true);
  });

  it('rejects overlapping an existing STRUCTURE (sum-of-radii circle)', () => {
    const structures = [{ x: 0, y: 0, radius: CAPITAL_R }];
    // A solar centred 10u away: 10 < (80 + 40) → overlap.
    expect(placementRejection('solar', 10, 10, structures)).toBe('overlap-structure');
    // A solar well clear (centre 200u away: 200 > 120) → legal.
    expect(placementRejection('solar', 200, 0, structures)).toBeNull();
  });

  it('rejects overlapping an ASTEROID obstacle — the C2 bug fix', () => {
    const obstacles: GridObstacle[] = [{ x: 0, y: 0, radius: 120 }];
    // Capital centred on the rock (0 < 80 + 120) → overlap-obstacle.
    expect(placementRejection('capital', 0, 0, [], obstacles)).toBe('overlap-obstacle');
    expect(canPlaceStructureAt('capital', 0, 0, [], obstacles)).toBe(false);
    // Capital clear of the rock (centre 300u: 300 > 200) → legal.
    expect(placementRejection('capital', 300, 0, [], obstacles)).toBeNull();
  });

  it('reports the STRUCTURE overlap first when both overlap (deterministic order)', () => {
    const structures = [{ x: 0, y: 0, radius: CAPITAL_R }];
    const obstacles: GridObstacle[] = [{ x: 0, y: 0, radius: 120 }];
    // Both overlap; structures are checked first.
    expect(placementRejection('solar', 0, 0, structures, obstacles)).toBe('overlap-structure');
  });

  it('treats touching-at-the-edge (distance === sum of radii) as legal (strict <)', () => {
    const obstacles: GridObstacle[] = [{ x: 0, y: 0, radius: 100 }];
    // solar radius 40; exactly 140u away → distance == sum of radii → NOT < → legal.
    expect(placementRejection('solar', 140, 0, [], obstacles)).toBeNull();
    // One unit closer → overlap.
    expect(placementRejection('solar', 139, 0, [], obstacles)).toBe('overlap-obstacle');
  });

  it('omitting obstacles is structures-only (legacy back-compat)', () => {
    const obstacles: GridObstacle[] = [{ x: 0, y: 0, radius: 120 }];
    // Same spot is legal when obstacles aren't supplied (the pre-C2 behaviour).
    expect(placementRejection('capital', 0, 0, [])).toBeNull();
    expect(placementRejection('capital', 0, 0, [], undefined)).toBeNull();
    expect(placementRejection('capital', 0, 0, [], obstacles)).toBe('overlap-obstacle');
  });
});
