import { describe, it, expect } from 'vitest';
import {
  fillWarpStructureFootprint, isWarpTarget, newWarpTarget, warpStopMargin, warpTargetFor, WARP_MIN_DISTANCE,
} from './warpTarget.js';
import { WARP_DROP_TOLERANCE } from './sectorSites.js';
import type { WarpStructureFootprint, WarpStructureSource } from '../nav/warpLineStop.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { STRUCTURE_KINDS_LIST, STRUCTURE_ROTATIONS, structureHalfExtents } from '../../shared-types/structureKinds.js';
import { gateWorldAxisBoxes } from '../structures/gateGeometry.js';

/** Array-backed structure source, as a server registry would wrap. */
class Boxes implements WarpStructureSource {
  constructor(private readonly list: WarpStructureFootprint[]) {}
  get count(): number { return this.list.length; }
  footprint(i: number, out: WarpStructureFootprint): void { Object.assign(out, this.list[i]!); }
}
const box = (x: number, y: number, halfW: number, halfH: number): WarpStructureFootprint =>
  ({ x, y, halfW, halfH, boxes: undefined });

const margin = warpStopMargin(getShipKind('fighter'));
// Ship at the origin, rim point 20 km east; a 1 km box 10 km out blocks it.
const R = { x: 20_000, y: 0 };
const wall = new Boxes([box(10_000, 0, 500, 500)]);

describe('warpStopMargin', () => {
  it('is at least the hull spawn clearance, per kind', () => {
    for (const id of ['fighter', 'battleship']) {
      const k = getShipKind(id);
      expect(warpStopMargin(k)).toBeGreaterThanOrEqual(shipTuning(k).spawnClearance);
    }
    expect(warpStopMargin(getShipKind('battleship'))).toBeGreaterThan(warpStopMargin(getShipKind('fighter')));
  });
});

describe('warpTargetFor', () => {
  it('a clear line targets the rim point', () => {
    const t = warpTargetFor(R.x, R.y, 0, 0, null, null, margin, newWarpTarget());
    expect(t).toEqual({ x: R.x, y: R.y, blocked: false, shortBy: 0, reachable: true });
  });

  it('a blocked line targets the near side of the obstacle', () => {
    const t = warpTargetFor(R.x, R.y, 0, 0, null, wall, margin, newWarpTarget());
    expect(t.blocked).toBe(true);
    expect(t.reachable).toBe(true);
    expect(t.x).toBeCloseTo(9_500 - margin, 3);
    expect(t.y).toBeCloseTo(0, 6);
    expect(t.shortBy).toBeCloseTo(R.x - (9_500 - margin), 3);
  });

  it('a stop closer than the minimum warp is not reachable', () => {
    const near = new Boxes([box(WARP_MIN_DISTANCE / 2 + margin, 0, 100, 100)]);
    const t = warpTargetFor(R.x, R.y, 0, 0, null, near, margin, newWarpTarget());
    expect(t.blocked).toBe(true);
    expect(t.reachable).toBe(false);
  });
});

describe('isWarpTarget', () => {
  it('accepts the target warpTargetFor offers, clear and blocked', () => {
    const clear = warpTargetFor(R.x, R.y, 0, 0, null, null, margin, newWarpTarget());
    expect(isWarpTarget(0, 0, clear.x, clear.y, R.x, R.y, null, null, margin)).toBe(true);
    const near = warpTargetFor(R.x, R.y, 0, 0, null, wall, margin, newWarpTarget());
    expect(isWarpTarget(0, 0, near.x, near.y, R.x, R.y, null, wall, margin)).toBe(true);
    // Rounded to whole units, as the wire carries it.
    expect(isWarpTarget(0, 0, Math.round(near.x), Math.round(near.y), R.x, R.y, null, wall, margin)).toBe(true);
  });

  it('rejects a point past the obstacle', () => {
    expect(isWarpTarget(0, 0, R.x, R.y, R.x, R.y, null, wall, margin)).toBe(false);
    expect(isWarpTarget(0, 0, 12_000, 0, R.x, R.y, null, wall, margin)).toBe(false);
  });

  it('rejects a point off the line, and one short of the stop', () => {
    expect(isWarpTarget(0, 0, 5_000, 3_000, R.x, R.y, null, wall, margin)).toBe(false);
    expect(isWarpTarget(0, 0, 5_000, 3_000, R.x, R.y, null, null, margin)).toBe(false);
    // On the line, clear, but stopping short of a clear rim: never arbitrary.
    expect(isWarpTarget(0, 0, 5_000, 0, R.x, R.y, null, null, margin)).toBe(false);
    expect(isWarpTarget(0, 0, 5_000, 0, R.x, R.y, null, wall, margin)).toBe(false);
  });

  it('accepts a point within the drop tolerance of the rim', () => {
    expect(isWarpTarget(0, 0, R.x, R.y + WARP_DROP_TOLERANCE / 2, R.x, R.y, null, null, margin)).toBe(true);
  });
});

describe('fillWarpStructureFootprint', () => {
  it('agrees with structureHalfExtents for every kind and rotation', () => {
    const out: WarpStructureFootprint = { x: 0, y: 0, halfW: 0, halfH: 0, boxes: undefined };
    for (const { id: kind } of STRUCTURE_KINDS_LIST) {
      for (const rot of STRUCTURE_ROTATIONS) {
        const { hw, hh } = structureHalfExtents(kind, rot);
        fillWarpStructureFootprint(kind, 12, -34, rot, null, out);
        expect(out).toEqual({ x: 12, y: -34, halfW: hw, halfH: hh, boxes: undefined, rotDeg: rot % 90 === 0 ? undefined : rot });
      }
    }
  });

  it('carries a gate part boxes through', () => {
    const boxes = gateWorldAxisBoxes('shield_gate', Math.PI / 2)!;
    const out: WarpStructureFootprint = { x: 0, y: 0, halfW: 0, halfH: 0, boxes: undefined };
    fillWarpStructureFootprint('shield_gate', 0, 0, 90, boxes, out);
    expect(out.boxes).toBe(boxes);
  });
});
