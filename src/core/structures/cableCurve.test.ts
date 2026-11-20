import { describe, it, expect } from 'vitest';
import { type GridNode, isConnectionLineBlocked } from './Grid.js';
import {
  CABLE_BLOCK_STATS,
  CABLE_CURVE_FLOATS,
  CABLE_CURVE_SEGMENTS,
  CABLE_SHORT_TAIL,
  CABLE_TAIL_MAX,
  flattenCableCurve,
  isCablePolylineBlocked,
  makeCableBox,
  type CableEnd,
} from './cableCurve.js';

function node(id: string, x: number, y: number, half = 40): GridNode {
  return {
    id, kind: 'solar_panel', x, y, rot: 0, radius: half, halfW: half, halfH: half, isHub: false, isCapital: false, isConnector: false,
    maxConnections: 4, powerOutput: 0, powerConsumption: 0, isConstructed: true,
  };
}

function nodes(...ns: GridNode[]): Map<string, GridNode> {
  return new Map(ns.map((n) => [n.id, n]));
}

const poly = new Float64Array(CABLE_CURVE_FLOATS);
const box = makeCableBox();

describe('flattenCableCurve', () => {
  it('starts and ends exactly on the sockets', () => {
    const a: CableEnd = { x: 10, y: 20, nx: 1, ny: 0 };
    const b: CableEnd = { x: 500, y: -80, nx: 0, ny: 1 };
    flattenCableCurve(a, false, b, false, poly, box);
    expect(poly.length).toBe((CABLE_CURVE_SEGMENTS + 1) * 2);
    expect([poly[0], poly[1]]).toEqual([10, 20]);
    expect([poly[CABLE_CURVE_FLOATS - 2], poly[CABLE_CURVE_FLOATS - 1]]).toEqual([500, -80]);
  });

  it('leaves A along its normal and enters B against its normal', () => {
    const a: CableEnd = { x: 0, y: 0, nx: 0, ny: 1 }; // A points up
    const b: CableEnd = { x: 400, y: 0, nx: 0, ny: 1 }; // B points up too: a U bend
    flattenCableCurve(a, false, b, false, poly, box);
    const fdx = poly[2]! - poly[0]!, fdy = poly[3]! - poly[1]!;
    expect(fdy).toBeGreaterThan(0);
    expect(Math.abs(fdx / fdy)).toBeLessThan(0.5); // mostly along +y
    const e = CABLE_CURVE_FLOATS - 2;
    const ldx = poly[e]! - poly[e - 2]!, ldy = poly[e + 1]! - poly[e - 1]!;
    expect(ldy).toBeLessThan(0); // comes down into B (against its up normal)
    expect(Math.abs(ldx / ldy)).toBeLessThan(0.5);
  });

  it('box bounds every point and reaches the bulge', () => {
    const a: CableEnd = { x: 0, y: 0, nx: 0, ny: 1 };
    const b: CableEnd = { x: 400, y: 0, nx: 0, ny: 1 };
    flattenCableCurve(a, false, b, false, poly, box);
    for (let i = 0; i < CABLE_CURVE_FLOATS; i += 2) {
      expect(poly[i]!).toBeGreaterThanOrEqual(box.x0);
      expect(poly[i]!).toBeLessThanOrEqual(box.x1);
      expect(poly[i + 1]!).toBeGreaterThanOrEqual(box.y0);
      expect(poly[i + 1]!).toBeLessThanOrEqual(box.y1);
    }
    expect(box.x0).toBe(0);
    expect(box.x1).toBe(400);
    expect(box.y0).toBe(0);
    // k = min(260, 400 * 0.35) = 140; a cubic's peak with both controls at 140 is 0.75 k
    expect(box.y1).toBeCloseTo(0.75 * 140, 0);
  });

  it('caps the tail at CABLE_TAIL_MAX and a connector end at CABLE_SHORT_TAIL', () => {
    const a: CableEnd = { x: 0, y: 0, nx: 0, ny: 1 };
    const b: CableEnd = { x: 2000, y: 0, nx: 0, ny: 1 };
    flattenCableCurve(a, false, b, false, poly, box);
    expect(box.y1).toBeCloseTo(0.75 * CABLE_TAIL_MAX, 0);
    flattenCableCurve(a, true, b, true, poly, box);
    expect(box.y1).toBeCloseTo(0.75 * CABLE_SHORT_TAIL, 0);
  });

  it('two straight-facing sockets give a straight line', () => {
    const a: CableEnd = { x: 0, y: 0, nx: 1, ny: 0 };
    const b: CableEnd = { x: 300, y: 0, nx: -1, ny: 0 };
    flattenCableCurve(a, false, b, true, poly, box);
    for (let i = 1; i < CABLE_CURVE_FLOATS; i += 2) expect(poly[i]).toBe(0);
  });
});

describe('isCablePolylineBlocked', () => {
  const A = node('a', 0, -60);
  const B = node('b', 400, -60);
  // Sockets on A's and B's top edges, pointing up: the cable bows up over y = -20.
  const sa: CableEnd = { x: 0, y: -20, nx: 0, ny: 1 };
  const sb: CableEnd = { x: 400, y: -20, nx: 0, ny: 1 };

  it('a box under the bend is clear for the curve but blocks the straight centre line', () => {
    const under = node('u', 200, -60, 30);
    const ns = nodes(A, B, under);
    flattenCableCurve(sa, false, sb, false, poly, box);
    expect(isCablePolylineBlocked(A, B, poly, box, ns)).toBe(false);
    expect(isConnectionLineBlocked(A, B, ns)).toBe(true);
  });

  it('a box in the bend blocks the curve', () => {
    const inBend = node('m', 200, 80, 30);
    flattenCableCurve(sa, false, sb, false, poly, box);
    expect(isCablePolylineBlocked(A, B, poly, box, nodes(A, B, inBend))).toBe(true);
  });

  it('ignores the two endpoints', () => {
    flattenCableCurve(sa, false, sb, false, poly, box);
    expect(isCablePolylineBlocked(A, B, poly, box, nodes(A, B))).toBe(false);
  });

  it('obstacles block, with the parts narrow phase', () => {
    flattenCableCurve(sa, false, sb, false, poly, box);
    const rock = { x: 200, y: 80, radius: 30 };
    expect(isCablePolylineBlocked(A, B, poly, box, nodes(A, B), [rock])).toBe(true);
    // Box overlaps the curve, but the body (a small square in its far corner) does not.
    const corner = { x: 200, y: 100, radius: 40, parts: [[{ x: 30, y: 30 }, { x: 40, y: 30 }, { x: 40, y: 40 }, { x: 30, y: 40 }]] };
    expect(isCablePolylineBlocked(A, B, poly, box, nodes(A, B), [corner])).toBe(false);
  });

  it('skips far nodes and obstacles in the broad phase (no segment tests)', () => {
    flattenCableCurve(sa, false, sb, false, poly, box);
    const far: GridNode[] = [A, B];
    for (let i = 0; i < 50; i++) far.push(node('f' + i, 5000 + i * 100, 5000));
    const near = node('n', 200, 300, 20); // y 280..320: above the bulge, outside the curve box
    CABLE_BLOCK_STATS.narrow = 0;
    expect(isCablePolylineBlocked(A, B, poly, box, nodes(...far, near), [{ x: -9000, y: 0, radius: 100 }])).toBe(false);
    expect(CABLE_BLOCK_STATS.narrow).toBe(0);
    // A node inside the curve box (under the bend, clear of the cable) is narrow-tested once.
    CABLE_BLOCK_STATS.narrow = 0;
    expect(isCablePolylineBlocked(A, B, poly, box, nodes(...far, node('in', 200, 20, 10)))).toBe(false);
    expect(CABLE_BLOCK_STATS.narrow).toBe(1);
  });

  it('a landing pad (keepClear) is solid: another node\'s pad and an end\'s own pad block, straight line too', () => {
    flattenCableCurve(sa, false, sb, false, poly, box);
    // A freight dock far below whose pad (local +y, rotated 180°: -y) is clear...
    const dockClear: GridNode = { ...node('d', 200, 2000, 500), kind: 'freight_dock', halfH: 200, rot: 0 };
    expect(isCablePolylineBlocked(A, B, poly, box, nodes(A, B, dockClear))).toBe(false);
    // ...and turned 180° so its pad (900 × 500, 210..710 past the open edge)
    // reaches up over the cable's bend: the body is clear, the pad is not.
    const dockUp: GridNode = { ...node('d', 200, 600, 500), kind: 'freight_dock', halfH: 200, rot: Math.PI };
    expect(isCablePolylineBlocked(A, B, poly, box, nodes(A, B, dockUp))).toBe(true);
    expect(isConnectionLineBlocked(node('p', -2000, 0), node('q', 2000, 0), nodes(dockUp))).toBe(true);
    // An end's own pad blocks too (A as a Capital whose crane bay lies under
    // the cable: pad y 290..530 past +y, here shifted so it covers the bend).
    const capA: GridNode = { ...A, kind: 'capital', y: -360 };
    expect(isCablePolylineBlocked(capA, B, poly, box, nodes(capA, B))).toBe(true);
  });
});
