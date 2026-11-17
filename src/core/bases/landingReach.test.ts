import { describe, expect, it } from 'vitest';
import { nearestClearPoint } from './baseSite';
import { landingReach } from '../../shared-types/shipScale/landingReach';
import { tuningFor } from '../../shared-types/shipScale/lookup';

describe('landingReach', () => {
  it('a battleship landing beside a parked battleship finds the gap, not the overlapping point', () => {
    const clr = tuningFor('battleship').spawnClearance;
    const parked = { x: 4000, y: 0, r: clr };
    const reach = landingReach(clr);
    // The landing code drops obstacles beyond `near` before searching.
    expect(Math.abs(parked.x)).toBeLessThanOrEqual(reach.near);
    const p = nearestClearPoint(0, 0, [], clr, reach.maxDistance, [parked]);
    expect(Math.hypot(p.x - parked.x, p.y - parked.y)).toBeGreaterThanOrEqual(2 * clr);
  });

  it('a fighter landing on a parked battleship clears its full clearance', () => {
    const own = tuningFor('fighter').spawnClearance;
    const big = tuningFor('battleship').spawnClearance;
    const reach = landingReach(own);
    const p = nearestClearPoint(0, 0, [], own, reach.maxDistance, [{ x: 0, y: 0, r: big }]);
    expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(own + big);
  });

  it('keeps the old reach for small ships', () => {
    const r = landingReach(tuningFor('fighter').spawnClearance);
    expect(r.maxDistance).toBeGreaterThanOrEqual(6000);
    expect(r.near).toBeGreaterThanOrEqual(8000);
  });
});
