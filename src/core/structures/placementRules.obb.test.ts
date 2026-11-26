/**
 * Base platforms 16: a building turned by a 30° step is tested as its REAL
 * turned box, not the nearest-quarter axis box (which wrongly accepted or
 * refused). Quarter turns keep the old rule (placementRules.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { keepClearBox, placementRejection } from './placementRules.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import type { GridObstacle } from './Grid.js';

const CAP = getStructureKind('capital').footprint; // 560×560
const SOLAR = getStructureKind('solar').footprint; // 700×300
const capitalAt = (x: number, y: number) => ({ x, y, radius: getStructureKind('capital').radius, halfW: CAP.w / 2, halfH: CAP.h / 2 });

/** The old rule: the nearest-quarter axis box (30° keeps it, 60° swaps). */
function oldAxisOverlap(x: number, y: number, rot: 30 | 60): boolean {
  const swap = rot === 60;
  const hw = (swap ? SOLAR.h : SOLAR.w) / 2, hh = (swap ? SOLAR.w : SOLAR.h) / 2;
  return Math.abs(x) < CAP.w / 2 + hw && Math.abs(y) < CAP.h / 2 + hh;
}

describe('placementRejection — oriented box at a 30° step', () => {
  it('a Solar turned 30° just above a Capital: the axis box cleared it, the turned box overlaps', () => {
    expect(oldAxisOverlap(0, 440, 30)).toBe(false);
    expect(placementRejection('solar', 0, 440, [capitalAt(0, 0)], null, 30)).toBe('overlap-structure');
  });

  it('a Solar turned 60° off a Capital corner: the axis box refused it, the turned box fits', () => {
    expect(oldAxisOverlap(400, 620, 60)).toBe(true);
    expect(placementRejection('solar', 400, 620, [capitalAt(0, 0)], null, 60)).toBeNull();
  });

  it('an EXISTING turned structure is tested as its turned box (its record carries rot)', () => {
    // The record keeps the nearest-quarter box in halfW/halfH, plus its rot.
    const solar30 = { x: 0, y: 440, radius: getStructureKind('solar').radius, halfW: SOLAR.w / 2, halfH: SOLAR.h / 2, kind: 'solar', rot: 30 };
    expect(placementRejection('capital', 0, 0, [solar30], null, 0)).toBe('overlap-structure');
    // The 60° case mirrored below the Capital (away from its crane-bay pad): 120°.
    const solar120 = { x: 400, y: -620, radius: getStructureKind('solar').radius, halfW: SOLAR.h / 2, halfH: SOLAR.w / 2, kind: 'solar', rot: 120 };
    expect(placementRejection('capital', 0, 0, [solar120], null, 0)).toBeNull();
  });

  it('obstacles: a rock at the axis box corner is clear of the turned box; one by its long face is not', () => {
    const corner: GridObstacle = { x: 360, y: 160, radius: 20 };
    expect(placementRejection('solar', 0, 0, [], [corner], 0)).toBe('overlap-obstacle');
    expect(placementRejection('solar', 0, 0, [], [corner], 30)).toBeNull();
    const face: GridObstacle = { x: 0, y: 200, radius: 30 };
    expect(placementRejection('solar', 0, 0, [], [face], 0)).toBeNull();
    expect(placementRejection('solar', 0, 0, [], [face], 30)).toBe('overlap-obstacle');
  });

  it('obstacle parts are tested in the turned frame (broad circle hits, the part decides)', () => {
    const sq = (h: number) => [{ x: -h, y: -h }, { x: h, y: -h }, { x: h, y: h }, { x: -h, y: h }];
    const big: GridObstacle = { x: 0, y: 200, radius: 40, parts: [sq(25)] };
    const small: GridObstacle = { x: 0, y: 200, radius: 40, parts: [sq(5)] };
    expect(placementRejection('solar', 0, 0, [], [big], 30)).toBe('overlap-obstacle');
    expect(placementRejection('solar', 0, 0, [], [small], 30)).toBeNull();
    // A turned part: the 25-square turned 45° reaches √2·25 ≈ 35 toward the box.
    const turned: GridObstacle = { x: 0, y: 200, radius: 40, angle: Math.PI / 4, parts: [sq(25)] };
    expect(placementRejection('solar', 0, 0, [], [turned], 30)).toBe('overlap-obstacle');
  });

  it("a turned dock's pad is its turned box", () => {
    // The freight dock's pad, turned 30°: oriented fields carry the real box.
    const pad = keepClearBox('freight_dock', 0, 0, 30)!;
    expect(pad.sin).toBeCloseTo(0.5, 12);
    const kc = getStructureKind('freight_dock').keepClear!;
    expect(pad.lhw).toBe(kc.w / 2);
    expect(pad.lhh).toBe(kc.h / 2);
    // Quarter turns keep the axis box with no turn.
    const q = keepClearBox('freight_dock', 0, 0, 90)!;
    expect([q.lhw, q.lhh, q.cos, q.sin]).toEqual([kc.h / 2, kc.w / 2, 1, 0]);
  });
});
