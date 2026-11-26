/**
 * Road pop-in (owner, film review 2026-11-26): a road tile's carriageway runs
 * out to its deck hex's edge midpoints (`ROAD_ARM_LEN`), past the 800 × 692
 * footprint its catalogue radius (529) bounds, so culling it by that radius
 * hid a road whose lane was already on screen and it "snapped in" late. The
 * cull radius must cover everything the road draws.
 */
import { describe, expect, it } from 'vitest';
import { getStructureKind } from '../../../shared-types/structureKinds/lookup.js';
import { isSpriteInView } from '../spriteUpdateDecisions.js';
import { ROAD_ARM_LEN, ROAD_HALF_W } from './structureStyleC.transport.road.js';
import { cullRadiusForStructure } from './structureDeckZones.js';

describe('structure cull radius', () => {
  const road = getStructureKind('road');

  it("covers a road's carriageway out to the seam (arm end + half width)", () => {
    expect(cullRadiusForStructure('road', road.radius)).toBeGreaterThanOrEqual(Math.hypot(ROAD_ARM_LEN, ROAD_HALF_W));
  });

  it('keeps a road drawn while only its arm end is on screen', () => {
    // View rect x ∈ [0, 1000]; the road's centre sits 600 u off the left edge,
    // so its east arm (to x = +50) is on screen.
    const bounds = new Float64Array([0, -500, 1000, 500]);
    expect(isSpriteInView(-600, 0, cullRadiusForStructure('road', road.radius), bounds)).toBe(true);
  });

  it('leaves other structures on their catalogue radius', () => {
    expect(cullRadiusForStructure('solar', 123)).toBe(123);
    expect(cullRadiusForStructure(undefined, 77)).toBe(77);
  });
});
