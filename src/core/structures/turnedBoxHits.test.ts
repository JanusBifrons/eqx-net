/**
 * bp-17: at a 30° deck step every hit test uses the REAL turned box, not the
 * nearest-quarter axis box the records keep; a quarter turn is unchanged.
 * Each case picks a point/line the axis box answers WRONGLY for.
 *
 * The test box: local half extents 200 × 20 (a long thin bar) turned 30°.
 * Its nearest quarter is 0°, so the stored box is also 200 × 20, axis aligned.
 *  - (147.2, 85) lies ON the turned bar (local (170, 0)), OUTSIDE the axis box.
 *  - (190, 0) lies INSIDE the axis box, OFF the turned bar.
 *  - The vertical line x = 190 crosses the axis box but misses the turned bar.
 */
import { describe, expect, it } from 'vitest';
import { projectileSweepBox, rayHitsBox } from '../combat/Weapons.js';
import { warpLineClear, type WarpStructureFootprint, type WarpStructureSource } from '../nav/warpLineStop.js';
import { fillWarpStructureFootprint } from '../galaxy/warpTarget.js';
import { CABLE_CURVE_SEGMENTS, isCablePolylineBlocked } from './cableCurve.js';
import { edgeDistance, isConnectionLineBlocked, type GridNode } from './Grid.js';
import { gateColliderBoxes } from './gateGeometry.js';
import {
  isStructureQuarterTurnOnly, playerStructureRotationStep, pointInOrientedBox, snapPlayerStructureRotation,
  structureHalfExtents, structureTurnedBoxInto, STRUCTURE_KINDS_LIST,
} from '../../shared-types/structureKinds.js';

const DEG = Math.PI / 180;
const ON_BAR = { x: 170 * Math.cos(30 * DEG), y: 170 * Math.sin(30 * DEG) }; // (147.2, 85)

function node(id: string, x: number, y: number, rotDeg: number, halfW: number, halfH: number, kind = ''): GridNode {
  return {
    id, kind, x, y, rot: rotDeg * DEG, radius: Math.hypot(halfW, halfH), halfW, halfH,
    isHub: false, isCapital: false, isConnector: false, maxConnections: 4,
    powerOutput: 0, powerConsumption: 0, isConstructed: true,
  };
}

describe('structureTurnedBoxInto / pointInOrientedBox', () => {
  const t = { hw: 0, hh: 0, cos: 1, sin: 0 };
  it('a 30° step is the real bar; the axis box answers wrongly', () => {
    expect(structureTurnedBoxInto(200, 20, 30, t)).toBe(true);
    expect(pointInOrientedBox(ON_BAR.x, ON_BAR.y, 0, 0, t.hw, t.hh, t.cos, t.sin)).toBe(true);
    expect(pointInOrientedBox(190, 0, 0, 0, t.hw, t.hh, t.cos, t.sin)).toBe(false);
    expect(Math.abs(ON_BAR.y) <= 20).toBe(false); // axis box: miss
  });
  it('60° swaps the stored box back to local extents', () => {
    // nearest quarter of 60° is 90°: stored 20 × 200, local 200 × 20.
    expect(structureTurnedBoxInto(20, 200, 60, t)).toBe(true);
    expect(t.hw).toBe(200); expect(t.hh).toBe(20);
    const p = { x: 170 * Math.cos(60 * DEG), y: 170 * Math.sin(60 * DEG) };
    expect(pointInOrientedBox(p.x, p.y, 0, 0, t.hw, t.hh, t.cos, t.sin)).toBe(true);
  });
  it('a quarter turn (or none) is the stored axis box', () => {
    for (const r of [undefined, 0, 90, 180, 270]) {
      expect(structureTurnedBoxInto(20, 200, r, t)).toBe(false);
      expect([t.hw, t.hh, t.cos, t.sin]).toEqual([20, 200, 1, 0]);
    }
  });
});

describe('weapon ray / projectile sweep vs a turned structure', () => {
  it('rayHitsBox: x = 190 misses the turned bar, x = 147 hits it', () => {
    expect(rayHitsBox(190, 300, 0, -1, 1000, 0, 0, 200, 20)).not.toBeNull(); // axis: wrong hit
    expect(rayHitsBox(190, 300, 0, -1, 1000, 0, 0, 200, 20, undefined, 0, 30)).toBeNull();
    const t = rayHitsBox(ON_BAR.x, 300, 0, -1, 1000, 0, 0, 200, 20, undefined, 0, 30);
    expect(t).not.toBeNull();
    // Enters above the bar's centreline (y 85), well before the axis box (y 20).
    expect(t!).toBeLessThan(300 - 85);
    expect(t!).toBeGreaterThan(300 - 85 - 40);
  });
  it('rayHitsBox: a wide beam turns too', () => {
    expect(rayHitsBox(190, 300, 0, -1, 1000, 0, 0, 200, 20, undefined, 2, 30)).toBeNull();
  });
  it('rayHitsBox at a quarter turn is byte-identical to the axis call', () => {
    for (const r of [0, 90, 180, 270]) {
      expect(rayHitsBox(190, 300, 0, -1, 1000, 0, 0, 200, 20, undefined, 0, r))
        .toBe(rayHitsBox(190, 300, 0, -1, 1000, 0, 0, 200, 20));
    }
  });
  it('projectileSweepBox: misses the turned bar where the axis box hits', () => {
    expect(projectileSweepBox(190, 300, 0, -600, 1, 0, 0, 200, 20)).not.toBeNull();
    expect(projectileSweepBox(190, 300, 0, -600, 1, 0, 0, 200, 20, undefined, 30)).toBeNull();
    expect(projectileSweepBox(ON_BAR.x, 300, 0, -600, 1, 0, 0, 200, 20, undefined, 30)).not.toBeNull();
    expect(projectileSweepBox(190, 300, 0, -600, 1, 0, 0, 200, 20, undefined, 90))
      .toEqual(projectileSweepBox(190, 300, 0, -600, 1, 0, 0, 200, 20));
  });
});

describe('grid: edge distance and line of sight use the turned box', () => {
  it('edgeDistance: a 30° bar is nearer than its axis box says', () => {
    const a = node('a', 0, 0, 30, 200, 20);
    const b = node('b', 0, 60, 0, 20, 20);
    // Axis rule: 60 - 20 - 20 = 20. The turned bar's top edge is 4.64 below
    // b's corner (20, 40): local y = -20·sin30 + 40·cos30 - 20.
    expect(edgeDistance(a, b)).toBeCloseTo(-10 + 40 * Math.cos(30 * DEG) - 20, 6);
  });
  it('edgeDistance at quarter turns is the old axis rule exactly', () => {
    const a = node('a', 0, 0, 90, 20, 200);
    const b = node('b', 70, 260, 180, 30, 10);
    expect(edgeDistance(a, b)).toBe(Math.hypot(70 - 50, 260 - 210));
  });
  it('isConnectionLineBlocked: the x = 190 line passes a turned bar', () => {
    const bar = node('bar', 0, 0, 30, 200, 20);
    const a = node('a', 190, 400, 0, 5, 5);
    const b = node('b', 190, -400, 0, 5, 5);
    expect(isConnectionLineBlocked(a, b, new Map([['bar', bar]]))).toBe(false);
    const axisBar = node('bar', 0, 0, 0, 200, 20);
    expect(isConnectionLineBlocked(a, b, new Map([['bar', axisBar]]))).toBe(true);
    const a2 = node('a', ON_BAR.x, 400, 0, 5, 5);
    const b2 = node('b', ON_BAR.x, -400, 0, 5, 5);
    expect(isConnectionLineBlocked(a2, b2, new Map([['bar', bar]]))).toBe(true);
  });
});

/** A straight cable from (x0, y) to (x1, y) as a flattened polyline. */
function straightCable(x0: number, y0: number, x1: number, y1: number): { poly: Float64Array; box: { x0: number; y0: number; x1: number; y1: number } } {
  const poly = new Float64Array((CABLE_CURVE_SEGMENTS + 1) * 2);
  for (let i = 0; i <= CABLE_CURVE_SEGMENTS; i++) {
    const t = i / CABLE_CURVE_SEGMENTS;
    poly[i * 2] = x0 + (x1 - x0) * t; poly[i * 2 + 1] = y0 + (y1 - y0) * t;
  }
  return { poly, box: { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) } };
}

describe('cable routing: turned bodies and turned landing pads', () => {
  it('a cable along x = 190 passes a turned bar body', () => {
    const bar = node('bar', 0, 0, 30, 200, 20);
    const a = node('a', 190, 400, 0, 5, 5);
    const b = node('b', 190, -400, 0, 5, 5);
    const { poly, box } = straightCable(190, 400, 190, -400);
    expect(isCablePolylineBlocked(a, b, poly, box, new Map([['bar', bar]]))).toBe(false);
    expect(isCablePolylineBlocked(a, b, poly, box, new Map([['bar', node('bar', 0, 0, 0, 200, 20)]]))).toBe(true);
  });
  it("a cable through a 30° Capital's turned pad corner is blocked (the axis pad misses it)", () => {
    // Capital pad: local centre (0, 410), 500 × 240. Local point (240, 100)
    // from the pad centre is inside the turned pad; in world it is y ≈ 561.6,
    // above the axis pad's top (355 + 120 = 475) and off the body.
    const c = Math.cos(30 * DEG), s = Math.sin(30 * DEG);
    const padX = -410 * s, padY = 410 * c;
    const px = padX + 240 * c - 100 * s, py = padY + 240 * s + 100 * c;
    const ext = structureHalfExtents('capital', 30);
    const cap = node('cap', 0, 0, 30, ext.hw, ext.hh, 'capital');
    const a = node('a', px - 15, py, 0, 1, 1);
    const b = node('b', px + 15, py, 0, 1, 1);
    const { poly, box } = straightCable(px - 15, py, px + 15, py);
    expect(isCablePolylineBlocked(a, b, poly, box, new Map([['cap', cap]]))).toBe(true);
    expect(isConnectionLineBlocked(a, b, new Map([['cap', cap]]))).toBe(true);
    // The same capital unturned has its pad elsewhere: clear.
    const cap0 = node('cap', 0, 0, 0, 280, 280, 'capital');
    expect(isCablePolylineBlocked(a, b, poly, box, new Map([['cap', cap0]]))).toBe(false);
  });
});

describe('warp line vs a turned structure', () => {
  const fp: WarpStructureFootprint = { x: 0, y: 0, halfW: 200, halfH: 20, rotDeg: undefined, boxes: undefined };
  const src = (rotDeg: number | undefined): WarpStructureSource => ({
    count: 1,
    footprint(_i, out) { out.x = fp.x; out.y = fp.y; out.halfW = fp.halfW; out.halfH = fp.halfH; out.rotDeg = rotDeg; out.boxes = undefined; },
  });
  it('the x = 190 line is clear past a turned bar, blocked by the axis box', () => {
    expect(warpLineClear(null, src(30), 190, 500, 190, -500)).toBe(true);
    expect(warpLineClear(null, src(undefined), 190, 500, 190, -500)).toBe(false);
    expect(warpLineClear(null, src(30), ON_BAR.x, 500, ON_BAR.x, -500)).toBe(false);
  });
  it('a start inside the turned box is skipped (never behind the start)', () => {
    expect(warpLineClear(null, src(30), ON_BAR.x, ON_BAR.y, ON_BAR.x + 1000, ON_BAR.y)).toBe(true);
  });
  it('fillWarpStructureFootprint (both sides) carries the turn only at a 30° step, never for a gate', () => {
    const out: WarpStructureFootprint = { x: 0, y: 0, halfW: 0, halfH: 0, boxes: undefined };
    expect(fillWarpStructureFootprint('solar', 0, 0, 30, null, out).rotDeg).toBe(30);
    expect(fillWarpStructureFootprint('solar', 0, 0, 90, null, out).rotDeg).toBeUndefined();
    expect(fillWarpStructureFootprint('solar', 0, 0, undefined, null, out).rotDeg).toBeUndefined();
    expect(fillWarpStructureFootprint('shield_gate', 0, 0, 30, new Float32Array(4), out).rotDeg).toBeUndefined();
  });
});

describe('quarter-turn-only kinds (gates, doors, teleporters)', () => {
  it('isStructureQuarterTurnOnly is exactly the kinds with gate part boxes', () => {
    for (const k of STRUCTURE_KINDS_LIST) {
      expect([k.id, isStructureQuarterTurnOnly(k.id)]).toEqual([k.id, gateColliderBoxes(k.id) !== null]);
    }
  });
  it('the player snap refuses a 30° step for them on a deck room (one rule both sides)', () => {
    expect(snapPlayerStructureRotation(30, true, 'shield_gate')).toBe(0);
    expect(snapPlayerStructureRotation(60, true, 'teleporter')).toBe(90);
    expect(playerStructureRotationStep(true, 'shield_airlock')).toBe(90);
    expect(snapPlayerStructureRotation(30, true, 'solar')).toBe(30);
    expect(playerStructureRotationStep(true, 'solar')).toBe(30);
    expect(snapPlayerStructureRotation(30, true)).toBe(30);
  });
});
