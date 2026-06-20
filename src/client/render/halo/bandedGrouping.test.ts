/**
 * WS-B PR1 (#2) — distance-banded grouping unit lock.
 *
 * The bug: grouping only formed beyond a single flat
 * RADAR_GROUPING_DISTANCE (2000 u), so a tight cluster of contacts at
 * CLOSE range each got its own icon (a just-placed structure popped in,
 * zoomed, vanished). The fix bands the grouping threshold by the cluster's
 * distance from the player: when the nearest contacts are CLOSE, the
 * grouping distance shrinks so those close clusters collapse to one
 * representative; when the action is far away, the grouping distance opens
 * back up so distant entities still pass through as singletons until the
 * far wedge band.
 *
 * `groupingDistanceForBand(closestDist)` is the pure helper that produces
 * the per-frame `groupingDistance` argument fed to
 * `partitionAndGroupCandidates`. Monotonic-non-decreasing in closestDist,
 * clamped to a sane [min, max] band.
 */
import { describe, it, expect } from 'vitest';
import {
  groupingDistanceForBand,
  RADAR_GROUPING_DISTANCE_MIN,
  RADAR_GROUPING_DISTANCE_MAX,
} from './wedgeGrouping.js';

describe('groupingDistanceForBand (WS-B #2 distance-banding)', () => {
  it('returns a SMALLER grouping distance when the nearest contacts are close', () => {
    const close = groupingDistanceForBand(300);
    const far = groupingDistanceForBand(6000);
    expect(close).toBeLessThan(far);
  });

  it('clamps to the documented [min, max] band', () => {
    expect(groupingDistanceForBand(0)).toBeGreaterThanOrEqual(RADAR_GROUPING_DISTANCE_MIN);
    expect(groupingDistanceForBand(0)).toBeLessThanOrEqual(RADAR_GROUPING_DISTANCE_MAX);
    expect(groupingDistanceForBand(1e9)).toBe(RADAR_GROUPING_DISTANCE_MAX);
    // A negative / degenerate distance still produces the floor, never NaN.
    expect(Number.isFinite(groupingDistanceForBand(-50))).toBe(true);
    expect(groupingDistanceForBand(-50)).toBeGreaterThanOrEqual(RADAR_GROUPING_DISTANCE_MIN);
  });

  it('is monotonic non-decreasing in the closest distance', () => {
    let prev = -Infinity;
    for (let d = 0; d <= 8000; d += 250) {
      const g = groupingDistanceForBand(d);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });

  it('a close, tight cluster groups under the banded distance but NOT under the legacy flat 2000 u', () => {
    // Three contacts ~400 u from the player, all within ~120 u of each
    // other on the same east bearing. Under the legacy flat
    // groupingDistance (2000) each is a singleton (dist <= 2000). Under
    // the banded distance (close ⇒ small grouping distance) they collapse.
    const band = groupingDistanceForBand(400);
    expect(band).toBeLessThan(400);
  });
});
