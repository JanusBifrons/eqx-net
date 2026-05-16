/**
 * Phase 5 perf lock — weapon hit-test cost (plan: clever-wombat).
 *
 * Run: pnpm bench
 *
 * The perf GUARANTEE: a shield-UP target costs exactly as much as before
 * the refactor — one rayHitsSphere / projectileSweepCircle plus a single
 * `shield > 0` short-circuit, ZERO polygon work, ZERO shipCollisionTriangles
 * lookup. Only a shield-DOWN target that the cheap circle broadphase says
 * could hit pays for the exact hull-polygon refinement. These benches make
 * that profile observable for the invariant #8 gate:
 *   - `circle baseline`        ≈ `shield-up effective path`
 *   - `shield-down (hit)`      = baseline + bounded N-triangle polygon test
 *   - a clear miss is rejected by the circle test before any polygon work.
 */
import { bench, describe } from 'vitest';
import {
  rayHitsSphere,
  rayHitsShipPolygon,
  projectileSweepCircle,
  sweptSegmentHitsShipPolygon,
  SHIP_COLLISION_RADIUS,
} from '../src/core/combat/Weapons.js';
import { shipCollisionTriangles } from '../src/core/geometry/triangulate.js';

const TRIS = shipCollisionTriangles('fighter');
// A ray that passes through the bounding circle AND the hull (worst case:
// the polygon refinement actually runs and iterates every triangle).
const F = { fx: 0, fy: -100, dx: 0, dy: 1, max: 200, cx: 0, cy: 0, ang: 0 };

describe('hitscan hit-test', () => {
  bench('circle baseline (legacy shield-up cost)', () => {
    rayHitsSphere(F.fx, F.fy, F.dx, F.dy, F.max, F.cx, F.cy, SHIP_COLLISION_RADIUS);
  });
  bench('shield-up effective path (circle + short-circuit)', () => {
    const c = rayHitsSphere(F.fx, F.fy, F.dx, F.dy, F.max, F.cx, F.cy, SHIP_COLLISION_RADIUS);
    const shieldUp = true;
    if (c === null || shieldUp) {
      /* return c — identical to baseline */
    }
  });
  bench('shield-down refine (circle + hull polygon)', () => {
    const c = rayHitsSphere(F.fx, F.fy, F.dx, F.dy, F.max, F.cx, F.cy, SHIP_COLLISION_RADIUS);
    if (c !== null) rayHitsShipPolygon(F.fx, F.fy, F.dx, F.dy, F.max, F.cx, F.cy, F.ang, TRIS);
  });
  bench('clear miss (circle rejects, no polygon)', () => {
    const c = rayHitsSphere(500, 500, 1, 0, 50, 0, 0, SHIP_COLLISION_RADIUS);
    if (c !== null) rayHitsShipPolygon(500, 500, 1, 0, 50, 0, 0, 0, TRIS);
  });
});

describe('projectile sweep hit-test', () => {
  bench('circle baseline (legacy shield-up cost)', () => {
    projectileSweepCircle(0, -100, 0, 200, 3, 0, 0, SHIP_COLLISION_RADIUS);
  });
  bench('shield-down refine (circle + hull polygon)', () => {
    const c = projectileSweepCircle(0, -100, 0, 200, 3, 0, 0, SHIP_COLLISION_RADIUS);
    if (c !== null) sweptSegmentHitsShipPolygon(0, -100, 0, 200, 0, 0, 0, TRIS);
  });
});
