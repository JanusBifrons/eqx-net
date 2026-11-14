import { describe, it, expect } from 'vitest';
import { segmentNearCircle, wreckRayHit, wreckSweepHit } from './wreckHits.js';

/** A long thin piece: a 1000 × 100 box along x, centred on its body origin
 *  (CCW), bounding radius ~501. */
const PARTS = [[{ x: -500, y: -50 }, { x: 500, y: -50 }, { x: 500, y: 50 }, { x: -500, y: 50 }]];
const R = Math.hypot(500, 50);

describe('wreckHits', () => {
  it('segmentNearCircle: inside, crossing and clear segments', () => {
    expect(segmentNearCircle(0, 0, 10, 0, 0, 0, 1)).toBe(true); // starts inside
    expect(segmentNearCircle(-10, 0.5, 20, 0, 0, 0, 1)).toBe(true); // crosses
    expect(segmentNearCircle(-10, 2, 20, 0, 0, 0, 1)).toBe(false); // clear
    expect(segmentNearCircle(2, 0, 10, 0, 0, 0, 1)).toBe(false); // moving away, outside
  });

  // A shell inside the piece's bounding circle and already past its closest
  // approach to the centre still hits the far half of a long piece. The old
  // `rayHitsSphere` gate returned null there, so shells passed through
  // (found by the overkill knock-back test, 2026-11-13).
  it('a step past the closest approach to the centre still hits the far half of the piece', () => {
    // Travelling +x along y = 0 from x = 100 (inside the circle, past the
    // centre): the box spans to x = 500, so the shell is inside the part.
    const sweep = wreckSweepHit(PARTS, R, 100, 0, 50, 0, 1, 0, 0, 0);
    expect(sweep).not.toBeNull();
    // From outside the part but inside the circle, heading down onto the
    // box's top edge with the closest approach to the centre behind it.
    const fx = 300, fy = 200;
    const dx = 0.6, dy = -0.8; // closest approach to (0,0) is behind the origin
    expect(dx * (0 - fx) + dy * (0 - fy)).toBeLessThan(0);
    const ray = wreckRayHit(PARTS, R, fx, fy, dx, dy, 1000, 0, 0, 0);
    expect(ray, 'the ray enters the top edge at y = 50').not.toBeNull();
    expect(fy + dy * ray!).toBeCloseTo(50, 6);
    const step = wreckSweepHit(PARTS, R, fx, fy, dx * 400, dy * 400, 1, 0, 0, 0);
    expect(step).not.toBeNull();
    expect(step!.hitY).toBeCloseTo(50, 6);
  });

  it('a clear miss stays a miss', () => {
    expect(wreckRayHit(PARTS, R, -1000, 600, 1, 0, 3000, 0, 0, 0)).toBeNull();
    expect(wreckSweepHit(PARTS, R, -1000, 600, 3000, 0, 1, 0, 0, 0)).toBeNull();
    // Inside the circle but beside the thin box: no hit.
    expect(wreckSweepHit(PARTS, R, 0, 200, 300, 0, 1, 0, 0, 0)).toBeNull();
  });
});
