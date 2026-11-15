import { describe, it, expect } from 'vitest';
import { fleetArrivalPoses, largestHullIndex, type FleetArrivalPose } from './fleetArrivalPoses.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';

describe('fleetArrivalPoses', () => {
  it('lands the largest hull on the anchor and keeps everyone\'s offset from it', () => {
    const hulls = [
      { x: 100, y: 0, radius: 20 },
      { x: 0, y: 0, radius: 90 }, // the flagship
      { x: -50, y: 40, radius: 20 },
    ];
    const out: FleetArrivalPose[] = [];
    expect(fleetArrivalPoses(hulls, { x: 5000, y: -2000 }, out)).toBe(1);
    expect(out).toEqual([
      { x: 5100, y: -2000 },
      { x: 5000, y: -2000 },
      { x: 4950, y: -1960 },
    ]);
  });

  it('clamps each pose to the sector bounds', () => {
    const lim = SECTOR_PLAYABLE_HALF_EXTENT;
    const out: FleetArrivalPose[] = [];
    fleetArrivalPoses([{ x: 0, y: 0, radius: 50 }, { x: 500, y: -500, radius: 10 }], { x: lim, y: -lim }, out);
    expect(out[1]).toEqual({ x: lim, y: -lim });
  });

  it('reuses the output entries and handles an empty group', () => {
    const out: FleetArrivalPose[] = [{ x: 9, y: 9 }];
    const first = out[0];
    fleetArrivalPoses([{ x: 1, y: 2, radius: 3 }], { x: 0, y: 0 }, out);
    expect(out[0]).toBe(first);
    expect(fleetArrivalPoses([], { x: 0, y: 0 }, out)).toBe(-1);
    expect(largestHullIndex([{ x: 0, y: 0, radius: 5 }, { x: 0, y: 0, radius: 5 }])).toBe(0);
  });
});
