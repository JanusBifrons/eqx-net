import { describe, it, expect } from 'vitest';
import { PLACEMENT_REJECTION_TEXT, placementRejection, canPlaceStructureAt } from './placementRules.js';
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

// Macro terrain C5b: a big irregular rock (cut-field radius up to ~8.9 km)
// refuses only a footprint on its real shape; the circle is the broad phase.
describe('placementRules — obstacle convex parts (narrow phase, C5b)', () => {
  // A long thin bar 10 km × 200 u along x, centred on the rock centre.
  const bar = [{ x: -5000, y: -100 }, { x: 5000, y: -100 }, { x: 5000, y: 100 }, { x: -5000, y: 100 }];
  const barRock = (angle = 0): GridObstacle => ({ x: 0, y: 0, radius: Math.hypot(5000, 100), parts: [bar], angle });

  it('accepts a footprint inside the bounding circle but clear of the outline', () => {
    // Capital half 280: at y = 1000 its box is 720 u above the bar, ~4 km inside the circle.
    expect(placementRejection('capital', 0, 1000, [], [{ x: 0, y: 0, radius: barRock().radius }])).toBe('overlap-obstacle');
    expect(placementRejection('capital', 0, 1000, [], [barRock()])).toBeNull();
  });

  it('refuses a footprint that overlaps a part; touching is legal', () => {
    expect(placementRejection('capital', 0, 300, [], [barRock()])).toBe('overlap-obstacle');
    expect(placementRejection('capital', 0, 380, [], [barRock()])).toBeNull();
    expect(placementRejection('capital', 0, 379, [], [barRock()])).toBe('overlap-obstacle');
  });

  it('uses the pose angle: the bar turned a quarter blocks the column, not the row', () => {
    expect(placementRejection('capital', 0, 1000, [], [barRock(Math.PI / 2)])).toBe('overlap-obstacle');
    expect(placementRejection('capital', 1000, 0, [], [barRock(Math.PI / 2)])).toBeNull();
  });

  it('tests a slanted edge, not only the parts\' bounding box', () => {
    // Triangle with hypotenuse x + y = 2000: the box near (1300, 1300) is
    // inside the triangle's bounding box but beyond its slanted edge.
    const tri: GridObstacle = { x: 0, y: 0, radius: 2000, parts: [[{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 0, y: 2000 }]] };
    expect(placementRejection('capital', 1300, 1300, [], [tri])).toBeNull();
    expect(placementRejection('capital', 1200, 1200, [], [tri])).toBe('overlap-obstacle');
  });

  it('a footprint over any one of several parts is refused; between them is clear', () => {
    const left = [{ x: -3000, y: -200 }, { x: -2000, y: -200 }, { x: -2000, y: 200 }, { x: -3000, y: 200 }];
    const right = [{ x: 2000, y: -200 }, { x: 3000, y: -200 }, { x: 3000, y: 200 }, { x: 2000, y: 200 }];
    const rock: GridObstacle = { x: 0, y: 0, radius: 3100, parts: [left, right] };
    expect(placementRejection('capital', 0, 0, [], [rock])).toBeNull();
    expect(placementRejection('capital', 2400, 0, [], [rock])).toBe('overlap-obstacle');
    expect(placementRejection('capital', -2400, 0, [], [rock])).toBe('overlap-obstacle');
  });

  it('the circle stays the broad phase: nothing outside it is refused', () => {
    // Parts that (wrongly) poke past the radius are cut off by the circle.
    expect(placementRejection('capital', 4000, 0, [], [{ ...barRock(), radius: 1000 }])).toBeNull();
  });

  it('an obstacle offset from the origin places its parts relative to its centre', () => {
    const rock: GridObstacle = { x: 10_000, y: -4000, radius: barRock().radius, parts: [bar] };
    expect(placementRejection('capital', 10_000, -3000, [], [rock])).toBeNull();
    expect(placementRejection('capital', 10_000, -3700, [], [rock])).toBe('overlap-obstacle');
  });
});

describe("placementRules — a freight dock's landing pad stays clear", () => {
  const DOCK = getStructureKind('freight_dock');
  const PAD = DOCK.keepClear!; // 900 × 500 at (0, 460) in the dock frame
  const dockAt = (x: number, y: number, rot = 0) => {
    const q = rot % 180 !== 0;
    return { x, y, radius: DOCK.radius, halfW: (q ? DOCK.footprint.h : DOCK.footprint.w) / 2, halfH: (q ? DOCK.footprint.w : DOCK.footprint.h) / 2, kind: 'freight_dock', rot };
  };

  it('rejects a structure placed onto an existing dock pad (the pad turns with the dock)', () => {
    expect(placementRejection('solar', 0, PAD.cy, [dockAt(0, 0)])).toBe('overlap-pad');
    expect(PLACEMENT_REJECTION_TEXT['overlap-pad']).toBe("Keep the landing pad clear");
    // Just past the pad's far edge is legal.
    expect(placementRejection('solar', 0, PAD.cy + PAD.h / 2 + SOLAR.h / 2, [dockAt(0, 0)])).toBeNull();
    // Turned 180°, the pad is on the -y side.
    expect(placementRejection('solar', 0, -PAD.cy, [dockAt(0, 0, 180)])).toBe('overlap-pad');
    expect(placementRejection('solar', 0, PAD.cy, [dockAt(0, 0, 180)])).toBeNull();
    // Turned 90° (CCW), the pad is on the -x side.
    expect(placementRejection('solar', -PAD.cy, 0, [dockAt(0, 0, 90)])).toBe('overlap-pad');
  });

  it('rejects a dock whose pad would cover an existing structure', () => {
    const solar = { x: 0, y: PAD.cy, radius: getStructureKind('solar').radius, halfW: SOLAR.w / 2, halfH: SOLAR.h / 2, kind: 'solar', rot: 0 };
    expect(placementRejection('freight_dock', 0, 0, [solar])).toBe('overlap-pad');
    expect(placementRejection('freight_dock', 0, 0, [solar], null, 180)).toBeNull();
  });

  it('a footprint without a kind reserves nothing beyond its box (legacy callers)', () => {
    const bare = { ...dockAt(0, 0), kind: undefined };
    expect(placementRejection('solar', 0, PAD.cy, [bare])).toBeNull();
  });
});
