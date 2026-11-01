/**
 * Phase V — weapons hit a structure's FOOTPRINT box, not its bounding circle.
 * `rayHitsBox` / `projectileSweepBox` are used by every fire path for kind-2
 * records (PlayerFireResolver, AiFireResolver, ProjectilePipeline,
 * MissileSimulation).
 */
import { describe, expect, it } from 'vitest';
import { projectileSweepBox, rayHitsBox, rayHitsSphere } from './Weapons.js';

describe('rayHitsBox', () => {
  it('hits the near face at the right distance', () => {
    // Box 360×150 (a Solar) at (500, 0); ray from the origin along +x.
    expect(rayHitsBox(0, 0, 1, 0, 2000, 500, 0, 180, 75)).toBeCloseTo(320, 6);
  });

  it("misses the bounding circle's empty corner — a beam that grazes past the box", () => {
    // Ray along y = 120 (above the 75 half-height) passes the box but crosses
    // its 195-radius bounding circle.
    expect(rayHitsBox(0, 120, 1, 0, 2000, 500, 0, 180, 75)).toBeNull();
    expect(rayHitsSphere(0, 120, 1, 0, 2000, 500, 0, 195)).not.toBeNull();
  });

  it('respects max distance and handles axis-parallel rays + rays starting inside', () => {
    expect(rayHitsBox(0, 0, 1, 0, 300, 500, 0, 180, 75)).toBeNull(); // face at 320
    expect(rayHitsBox(500, -1000, 0, 1, 2000, 500, 0, 180, 75)).toBeCloseTo(925, 6);
    expect(rayHitsBox(500, 0, 1, 0, 2000, 500, 0, 180, 75)).toBe(0); // inside
    expect(rayHitsBox(0, 0, -1, 0, 2000, 500, 0, 180, 75)).toBeNull(); // pointing away
  });
});

describe('projectileSweepBox', () => {
  it('a bolt sweeping into a box hits at the grown face', () => {
    const r = projectileSweepBox(0, 0, 400, 0, 5, 500, 0, 180, 75)!;
    expect(r.entry).toBeCloseTo(315, 6); // 320 − projectile radius 5
    expect(r.hitX).toBeCloseTo(315, 6);
  });

  it('a step that stops short (or passes the corner gap) is a miss', () => {
    expect(projectileSweepBox(0, 0, 200, 0, 5, 500, 0, 180, 75)).toBeNull();
    expect(projectileSweepBox(0, 100, 1000, 0, 5, 500, 0, 180, 75)).toBeNull(); // 100 > 75 + 5
  });
});
