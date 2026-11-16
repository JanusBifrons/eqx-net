/**
 * Rock cut (salvage stream; mining-and-salvage.md "Mining asteroids"): a
 * mined-out rock breaks through the SAME wreck fracture as a dead hull, on
 * its own outline (`rockWreckSource`). Locks: deterministic both sides; the
 * pieces tile the rock in the PARENT rock's rest frame (centroid + body-frame
 * vertices land inside the rock's own outline, cut after cut); a slice cut
 * splits along its line; mass is area × `ROCK_WRECK_DENSITY`; only the
 * mining laser wears rock.
 */
import { describe, expect, it } from 'vitest';
import { wreckPieceGeometry, type WreckFractureInputs, type WreckPieceGeometry } from './wreckPieces.js';
import { wreckChildGeometry, wreckChildSeed } from './wreckChildren.js';
import { rockWreckSource, ROCK_WRECK_DENSITY, wreckSourceOf } from './wreckSource.js';
import { wreckCanResplit, wreckPieceIntegrity, wreckWearFactor } from './wreckIntegrity.js';
import { generateAsteroidVertices, polygonArea, asteroidShapeSeed, type Vec2 } from '../swarm/asteroidShape.js';
import { CUT_ANGLE_STEPS } from './fractureHull.js';

const ROCK = { id: 'belt-0-7', shape: asteroidShapeSeed('belt-0-7'), r: 60 };

/** The rock cut through its middle by a slice along +x (Pixi-up 1× frame =
 *  the rock's rest frame, y flipped), hit on its left rim. */
function inputs(seed = 11, cut = true): WreckFractureInputs {
  return {
    rock: ROCK, seed, killX: -ROCK.r, killY: 3, killBlowDamage: 0, recentDamageRate: 0, snapChance: 0.2,
    ...(cut ? { cutKind: 'slice' as const, cutAng: 0 } : {}),
  };
}

function inside(poly: ReadonlyArray<Vec2>, p: Vec2, eps: number): boolean {
  // Convex CCW polygon: p is left of (or within eps of) every edge.
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const cr = ex * (p.y - a.y) - ey * (p.x - a.x);
    if (cr < -eps * Math.hypot(ex, ey)) return false;
  }
  return true;
}

/** Every piece vertex back in the parent rock's rest frame (math-up). */
function rockFrameVerts(g: WreckPieceGeometry): Vec2[] {
  return g.outline.map((v) => ({ x: v.x + g.cx, y: v.y + g.cy }));
}

describe('rock cut: a rock fractures like a wreck, in its own frame', () => {
  it('is deterministic (both sides rebuild the same pieces from the inputs)', () => {
    const a = wreckPieceGeometry(inputs());
    const b = wreckPieceGeometry(inputs());
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keeps every piece in the parent rock rest frame: the pieces tile the rock outline', () => {
    const rock = generateAsteroidVertices(ROCK.shape, ROCK.r);
    const geom = wreckPieceGeometry(inputs(11, false));
    expect(geom.length).toBeGreaterThanOrEqual(2);
    let area = 0;
    for (const g of geom) {
      for (const v of rockFrameVerts(g)) expect(inside(rock, v, 1e-3 * ROCK.r + 0.5)).toBe(true);
      area += g.area;
    }
    // No cut channel, no jag loss: the pieces add up to the rock.
    expect(area / polygonArea(rock)).toBeGreaterThan(0.97);
    expect(area / polygonArea(rock)).toBeLessThan(1.03);
  });

  it('a slice splits along its line (pieces on both sides of y = kill y)', () => {
    const geom = wreckPieceGeometry(inputs());
    // Pixi-up kill y 3 ⇒ math-up line y = -3, along +x (cutAng 0).
    const above = geom.filter((g) => g.cy > -3).length;
    const below = geom.filter((g) => g.cy < -3).length;
    expect(above).toBeGreaterThan(0);
    expect(below).toBeGreaterThan(0);
    // Reachable angle encoding (the descriptor's u16).
    expect(CUT_ANGLE_STEPS).toBe(65536);
  });

  it('a piece re-cut stays in the parent rock frame (chain of one step)', () => {
    const rock = generateAsteroidVertices(ROCK.shape, ROCK.r);
    const root = inputs();
    const big = wreckPieceGeometry(root).reduce((a, b) => (b.area > a.area ? b : a));
    const kids = wreckChildGeometry({
      root,
      steps: [{ pieceIndex: big.index, killX: big.cx, killY: -big.cy, cutKind: 'slice', cutAng: CUT_ANGLE_STEPS / 4 }],
    });
    expect(kids.length).toBeGreaterThanOrEqual(2);
    let area = 0;
    for (const g of kids) {
      for (const v of rockFrameVerts(g)) expect(inside(rock, v, 1e-3 * ROCK.r + 0.5)).toBe(true);
      area += g.area;
    }
    expect(area).toBeLessThanOrEqual(big.area * 1.01);
    expect(wreckChildSeed(root.seed, big.index)).toBeGreaterThanOrEqual(0);
  });

  it('mass is area × rock density; integrity scales with the piece; small pieces turn to pods', () => {
    const src = wreckSourceOf(inputs());
    expect(src).toBe(rockWreckSource(ROCK));
    expect(src.scale).toBe(1);
    for (const g of wreckPieceGeometry(inputs())) expect(g.mass).toBeCloseTo(g.area * ROCK_WRECK_DENSITY, 6);
    const whole = wreckPieceIntegrity(src, src.bodyMass);
    expect(wreckPieceIntegrity(src, src.bodyMass / 2)).toBeCloseTo(whole / 2, 6);
    expect(wreckCanResplit(src, src.area * 0.5, src.radius * 0.5)).toBe(true);
    expect(wreckCanResplit(src, src.area * 0.01, src.radius * 0.1)).toBe(false);
  });

  it('only the mining laser wears rock (rock factor; untagged hits do not)', () => {
    expect(wreckWearFactor('mining_laser', true)).toBe(1);
    expect(wreckWearFactor('laser', true)).toBe(0);
    expect(wreckWearFactor('heavy_beam', true)).toBe(0);
    expect(wreckWearFactor(undefined, true)).toBe(0);
    // Wrecks keep their factors.
    expect(wreckWearFactor('laser')).toBeCloseTo(0.1, 9);
  });
});
