import { describe, it, expect } from 'vitest';
import { placementRejection, canPlaceStructureAt } from './placementRules.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import type { GridObstacle } from './Grid.js';

// Phase V (plan soft-leaping-truffle v2): structures are rotated BOXES
// (footprints), not circles. Capital 560×560, Solar 360×150.
const CAP = getStructureKind('capital').footprint; // 560×560
const SOLAR = getStructureKind('solar').footprint; // 360×150
const capitalAt = (x: number, y: number) => ({ x, y, radius: getStructureKind('capital').radius, halfW: CAP.w / 2, halfH: CAP.h / 2 });

describe('placementRules — canPlaceStructureAt / placementRejection (rotated footprint boxes)', () => {
  it('is legal on empty ground (no structures, no obstacles)', () => {
    expect(placementRejection('capital', 0, 0, [])).toBeNull();
    expect(canPlaceStructureAt('capital', 0, 0, [])).toBe(true);
  });

  it('rejects overlapping an existing STRUCTURE box', () => {
    const structures = [capitalAt(0, 0)];
    // A solar whose box intrudes into the Capital's box → overlap.
    expect(placementRejection('solar', 300, 0, structures)).toBe('overlap-structure');
    // Exactly touching (280 + 180 = 460) is legal; one unit closer overlaps.
    expect(placementRejection('solar', 460, 0, structures)).toBeNull();
    expect(placementRejection('solar', 459, 0, structures)).toBe('overlap-structure');
  });

  it('a quarter turn swaps the footprint: a rotated Solar fits where an upright one overlaps', () => {
    const structures = [capitalAt(0, 0)];
    // Upright Solar (360 wide) at x = 400 → half 180 → overlaps the Capital (280).
    expect(placementRejection('solar', 400, 0, structures, null, 0)).toBe('overlap-structure');
    // Rotated 90° it is 150 wide → half 75 → 400 − 75 = 325 > 280 → legal.
    expect(placementRejection('solar', 400, 0, structures, null, 90)).toBeNull();
    expect(SOLAR.w).toBeGreaterThan(SOLAR.h);
  });

  it('rejects overlapping an ASTEROID obstacle (box vs circle)', () => {
    const obstacles: GridObstacle[] = [{ x: 0, y: 0, radius: 120 }];
    expect(placementRejection('capital', 0, 0, [], obstacles)).toBe('overlap-obstacle');
    expect(canPlaceStructureAt('capital', 0, 0, [], obstacles)).toBe(false);
    // Capital edge at 400 − 280 = 120 from the rock centre → just touching → legal.
    expect(placementRejection('capital', 400, 0, [], obstacles)).toBeNull();
    expect(placementRejection('capital', 399, 0, [], obstacles)).toBe('overlap-obstacle');
  });

  it("a rock in the box's corner gap is legal (box, not bounding circle)", () => {
    // Rock radius 40 at (330, 330): the Capital box corner is (280, 280),
    // ~70.7 u away — clear. The bounding circle (radius 396) would have said overlap.
    const obstacles: GridObstacle[] = [{ x: 330, y: 330, radius: 40 }];
    expect(placementRejection('capital', 0, 0, [], obstacles)).toBeNull();
  });

  it('reports the STRUCTURE overlap first when both overlap (deterministic order)', () => {
    const obstacles: GridObstacle[] = [{ x: 0, y: 0, radius: 120 }];
    expect(placementRejection('solar', 0, 0, [capitalAt(0, 0)], obstacles)).toBe('overlap-structure');
  });

  it('omitting obstacles is structures-only (legacy back-compat)', () => {
    const obstacles: GridObstacle[] = [{ x: 0, y: 0, radius: 120 }];
    expect(placementRejection('capital', 0, 0, [])).toBeNull();
    expect(placementRejection('capital', 0, 0, [], undefined)).toBeNull();
    expect(placementRejection('capital', 0, 0, [], obstacles)).toBe('overlap-obstacle');
  });
});
