/**
 * Unit tests for the pure Equinox -> eqx-net composite transform helpers
 * (composite-ships Phase 1, Step A).
 *
 * `equinoxPartPoints` re-frames an Equinox component (+x forward, y-down)
 * into eqx-net catalogue space (Pixi-up, nose at -y) via `(x,y)->(y,-x)`
 * applied LAST, after the per-instance mirror/scale/offset. `convexHull`
 * is Andrew's monotone-chain, used to derive a composite's gross collision
 * outline from the union of its parts' points.
 */
import { describe, it, expect } from 'vitest';
import {
  equinoxPartPoints,
  convexHull,
} from '../../src/shared-types/shipKinds/composite/equinoxTransform.js';

describe('equinoxPartPoints', () => {
  // Equinox's `adjustCenter` re-centres each component on its CENTROID and
  // places that centroid at the offset. So a part is centred, not anchored at
  // its (0,0) origin.
  it('centres the part on its centroid; the forward-most point maps to -y (nose)', () => {
    // [[0,0],[20,0]] centroid (10,0); centred -> [-10,0],[10,0]; offset 0;
    // reframe (x,y)->(y,-x) -> [0,10],[0,-10]. The +x-most input (the nose) is
    // the -y output.
    const out = equinoxPartPoints(
      [
        [0, 0],
        [20, 0],
      ],
      [0, 0],
      1,
      false,
    );
    expect(out[0]).toEqual([0, 10]);
    expect(out[1]![0]).toBeCloseTo(0, 9);
    expect(out[1]![1]).toBeCloseTo(-10, 9); // nose forward = -y
  });

  it('places the part centroid at the (reframed) offset', () => {
    // Centroid (10,0); offset (5,7). Reframed offset = (7,-5). Mean of the
    // output points must equal the reframed offset.
    const out = equinoxPartPoints(
      [
        [0, 0],
        [20, 0],
      ],
      [5, 7],
      1,
      false,
    );
    const mean = out.reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
    expect(mean[0] / out.length).toBeCloseTo(7, 9);
    expect(mean[1] / out.length).toBeCloseTo(-5, 9);
  });

  it('mirror flips the cross-axis (eqx-net x) for a centreline part', () => {
    const pts: [number, number][] = [
      [0, 0],
      [20, 8],
    ];
    const noMirror = equinoxPartPoints(pts, [0, 0], 1, false);
    const mirror = equinoxPartPoints(pts, [0, 0], 1, true);
    // For every [x,y] in the no-mirror output there is a [-x,y] in the mirror.
    for (const [x, y] of noMirror) {
      const hit = mirror.some(
        ([mx, my]) => Math.abs(mx - -x) < 1e-9 && Math.abs(my - y) < 1e-9,
      );
      expect(hit, `mirror of [${x},${y}]`).toBe(true);
    }
  });

  it('applies scale before centring (uniform)', () => {
    // scale 2 -> [[0,0],[20,0]] centroid (10,0) -> centred [-10,0],[10,0] ->
    // reframe [0,10],[0,-10]. The +x input maps to -y at the scaled magnitude.
    const out = equinoxPartPoints(
      [
        [0, 0],
        [10, 0],
      ],
      [0, 0],
      2,
      false,
    );
    expect(out[1]![1]).toBeCloseTo(-10, 9);
  });

  it('centroidSource centres a sub-feature on the PARENT centroid, not its own', () => {
    // A lone dome point [0,0] centred on its OWN centroid would land at the
    // offset (0,0) -> [0,0]. With centroidSource [[0,0],[20,0]] (centroid
    // (10,0)) it is centred by the parent: (0-10,0)+offset(0,0) -> reframe
    // [0,10].
    const own = equinoxPartPoints([[0, 0]], [0, 0], 1, false);
    expect(own[0]![0]).toBeCloseTo(0, 9);
    expect(own[0]![1]).toBeCloseTo(0, 9);
    const glued = equinoxPartPoints([[0, 0]], [0, 0], 1, false, [
      [0, 0],
      [20, 0],
    ]);
    expect(glued[0]![0]).toBeCloseTo(0, 9);
    expect(glued[0]![1]).toBeCloseTo(10, 9);
  });

  it('returns one output point per input point', () => {
    const out = equinoxPartPoints(
      [
        [0, 0],
        [1, 1],
        [2, -2],
      ],
      [0, 0],
      1,
      false,
    );
    expect(out).toHaveLength(3);
  });
});

describe('convexHull', () => {
  it('returns the 4 corners of a square (interior point dropped)', () => {
    const hull = convexHull([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [1, 1], // interior — must be dropped
    ]);
    expect(hull).toHaveLength(4);
    // Every corner of the square is present.
    const has = (x: number, y: number) =>
      hull.some(([hx, hy]) => Math.abs(hx - x) < 1e-9 && Math.abs(hy - y) < 1e-9);
    expect(has(0, 0)).toBe(true);
    expect(has(2, 0)).toBe(true);
    expect(has(2, 2)).toBe(true);
    expect(has(0, 2)).toBe(true);
    // The interior point is NOT a hull vertex.
    expect(has(1, 1)).toBe(false);
  });

  it('drops collinear points on an edge', () => {
    const hull = convexHull([
      [0, 0],
      [1, 0], // collinear on the bottom edge
      [2, 0],
      [2, 2],
      [0, 2],
    ]);
    expect(hull).toHaveLength(4);
  });

  it('passes through degenerate (< 3 point) input', () => {
    expect(convexHull([[1, 2]])).toEqual([[1, 2]]);
    expect(
      convexHull([
        [1, 2],
        [3, 4],
      ]),
    ).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});
