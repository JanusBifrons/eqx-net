import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CONTEXT_SLOTS,
  CONTEXT_SLOT_ANGLE,
  addDangerFromPoint,
  addDangerFromSegment,
  addInterestOrbit,
  addInterestToward,
  angleForDir,
  clearContextMaps,
  createContextMaps,
  makeContextOutput,
  resolveContext,
  slotDirX,
  slotDirY,
} from './contextSteering.js';

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

describe('contextSteering', () => {
  it('slot table follows the ship-angle convention (-sin θ, cos θ)', () => {
    expect(slotDirX(0)).toBeCloseTo(0);
    expect(slotDirY(0)).toBeCloseTo(1);
    // A quarter turn counter-clockwise points at -X.
    expect(slotDirX(CONTEXT_SLOTS / 4)).toBeCloseTo(-1);
    expect(slotDirY(CONTEXT_SLOTS / 4)).toBeCloseTo(0);
    for (let i = 0; i < CONTEXT_SLOTS; i++) {
      expect(angleDiff(angleForDir(slotDirX(i), slotDirY(i)), i * CONTEXT_SLOT_ANGLE)).toBeLessThan(1e-9);
    }
    expect(angleForDir(1, 0)).toBeCloseTo(Math.atan2(-1, 0));
  });

  it('interest only: heading equals the desired direction within sub-slot error', () => {
    const m = createContextMaps();
    const out = makeContextOutput();
    fc.assert(
      fc.property(fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }), (theta) => {
        clearContextMaps(m);
        addInterestToward(m, -Math.sin(theta), Math.cos(theta), 1, 2);
        resolveContext(m, out);
        // Parabolic refinement: well under half a slot (11.25°).
        expect(angleDiff(out.angle, theta)).toBeLessThan(CONTEXT_SLOT_ANGLE * 0.25);
        expect(Math.hypot(out.dirX, out.dirY)).toBeCloseTo(1);
        expect(angleDiff(angleForDir(out.dirX, out.dirY), out.angle)).toBeLessThan(1e-9);
        expect(out.speedScale).toBeGreaterThan(0.9);
      }),
    );
  });

  it('a danger point dead ahead deflects to one side and never into the danger', () => {
    const m = createContextMaps();
    const out = makeContextOutput();
    // Goal straight up (+Y); an obstacle 60 u ahead, inside its radius band.
    addInterestToward(m, 0, 1, 1, 1);
    addDangerFromPoint(m, 0, 60, 60, 50, 100, 1);
    resolveContext(m, out);
    expect(Math.abs(out.dirX)).toBeGreaterThan(0.5); // deflected sideways
    expect(out.dirY).toBeLessThan(0.05); // not toward the obstacle
    expect(m.danger[out.slot]!).toBeLessThan(0.05);
  });

  it('a faint far danger does not mask the goal', () => {
    const m = createContextMaps();
    const out = makeContextOutput();
    addInterestToward(m, 0, 1, 1, 2);
    addDangerFromPoint(m, 0, 1, 149, 50, 100, 1); // strength 0.01
    resolveContext(m, out);
    expect(out.slot).toBe(0);
  });

  it('danger beyond falloff writes nothing', () => {
    const m = createContextMaps();
    addDangerFromPoint(m, 1, 0, 200, 50, 100, 1);
    for (let i = 0; i < CONTEXT_SLOTS; i++) expect(m.danger[i]).toBe(0);
  });

  it('segment danger masks headings crossing the lane, not parallel or departing ones', () => {
    const m = createContextMaps();
    // Lane along +Y from (0,0) to (0,1000); agent 100 u to its +X side.
    addDangerFromSegment(m, 100, 500, 0, 0, 0, 1000, 20, 300, 1);
    for (let i = 0; i < CONTEXT_SLOTS; i++) {
      const sx = slotDirX(i);
      if (sx < -0.3) expect(m.danger[i]!).toBeGreaterThan(0); // toward the lane (-X), reaches it
      if (sx >= -1e-6) expect(m.danger[i]).toBe(0); // parallel or away
    }
    // Straight at the lane: gap 80 over lookahead 300.
    expect(m.danger[CONTEXT_SLOTS / 4]!).toBeCloseTo(1 - 80 / 300, 5);
  });

  it('segment danger ignores crossings beyond the segment ends and the lookahead', () => {
    const m = createContextMaps();
    // Agent far past b: heading back toward the line would cross beyond the segment.
    addDangerFromSegment(m, 100, 2000, 0, 0, 0, 1000, 20, 300, 1);
    for (let i = 0; i < CONTEXT_SLOTS; i++) expect(m.danger[i]).toBe(0);
    clearContextMaps(m);
    addDangerFromSegment(m, 500, 500, 0, 0, 0, 1000, 20, 300, 1); // 480 u gap > lookahead
    for (let i = 0; i < CONTEXT_SLOTS; i++) expect(m.danger[i]).toBe(0);
  });

  it('inside the lane the perpendicular exit is the least dangerous', () => {
    const m = createContextMaps();
    const out = makeContextOutput();
    addDangerFromSegment(m, 5, 500, 0, 0, 0, 1000, 20, 300, 1);
    addInterestToward(m, 0, 1, 1, 1); // wants to fly along the lane
    resolveContext(m, out);
    expect(out.dirX).toBeGreaterThan(0.9); // exits to the nearer (+X) edge
  });

  it('orbit interest is tangential in the requested direction', () => {
    const m = createContextMaps();
    const out = makeContextOutput();
    // Target to the +X; clockwise (viewed Y-up) around it from its -X side means heading +Y.
    addInterestOrbit(m, 100, 0, true, 1);
    resolveContext(m, out);
    expect(out.dirY).toBeGreaterThan(0.95);
    clearContextMaps(m);
    addInterestOrbit(m, 100, 0, false, 1);
    resolveContext(m, out);
    expect(out.dirY).toBeLessThan(-0.95);
  });

  it('all slots fully dangerous: faces the least dangerous slot at zero speed', () => {
    const m = createContextMaps();
    const out = makeContextOutput();
    addInterestToward(m, 0, 1, 1, 1);
    for (let i = 0; i < CONTEXT_SLOTS; i++) m.danger[i] = 2;
    m.danger[5] = 1.2;
    resolveContext(m, out);
    expect(out.slot).toBe(5);
    expect(out.speedScale).toBe(0);
  });

  it('speed drops when the chosen slot still carries danger or interest is weak', () => {
    const m = createContextMaps();
    const out = makeContextOutput();
    addInterestToward(m, 0, 1, 0.4, 4);
    resolveContext(m, out);
    expect(out.speedScale).toBeCloseTo(0.4, 2);
    clearContextMaps(m);
    addInterestToward(m, 0, 1, 1, 4);
    for (let i = 0; i < CONTEXT_SLOTS; i++) m.danger[i] = 0.5;
    resolveContext(m, out);
    expect(out.speedScale).toBeCloseTo(0.5, 5);
  });

  it('resolve writes and returns the caller-owned out object', () => {
    const m = createContextMaps();
    const out = makeContextOutput();
    addInterestToward(m, 1, 1, 1, 1);
    expect(resolveContext(m, out)).toBe(out);
    expect(m.interest).toBeInstanceOf(Float32Array);
    expect(m.interest.length).toBe(CONTEXT_SLOTS);
  });
});
