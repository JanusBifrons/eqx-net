import { describe, it, expect } from 'vitest';
import {
  distancePointToSegment,
  playerInMiningBeam,
  MINING_BEAM_HALF_WIDTH,
  MINING_BEAM_PLAYER_DPS,
} from './miningBeamHazard.js';

/** WS-4 Phase 3 / R2.27 — the mining beam's thin player-damage ray. */
describe('distancePointToSegment', () => {
  it('is 0 on the segment, and the perpendicular distance off it', () => {
    // Segment along +x from (0,0) to (100,0).
    expect(distancePointToSegment(50, 0, 0, 0, 100, 0)).toBe(0); // on the line, mid-segment
    expect(distancePointToSegment(50, 20, 0, 0, 100, 0)).toBeCloseTo(20, 9); // 20 off to the side
  });

  it('clamps to the endpoints (no infinite line)', () => {
    // Beyond the B endpoint: distance to B, not to the infinite line.
    expect(distancePointToSegment(130, 0, 0, 0, 100, 0)).toBeCloseTo(30, 9);
    // Before the A endpoint: distance to A.
    expect(distancePointToSegment(-40, 0, 0, 0, 100, 0)).toBeCloseTo(40, 9);
    // Beyond B and off to the side: hypot to B.
    expect(distancePointToSegment(103, 4, 0, 0, 100, 0)).toBeCloseTo(5, 9);
  });

  it('degrades to point-to-point for a zero-length segment', () => {
    expect(distancePointToSegment(3, 4, 10, 10, 10, 10)).toBeCloseTo(Math.hypot(7, 6), 9);
  });
});

describe('playerInMiningBeam', () => {
  const R = 12; // SHIP_COLLISION_RADIUS-ish
  it('a ship straddling the beam line is in-beam; one well off to the side is not', () => {
    // Beam from (-350,0) to (-700,0) (the structure-scenario miner→rock geometry).
    expect(playerInMiningBeam(-350, 0, -700, 0, -500, 0, R, MINING_BEAM_HALF_WIDTH)).toBe(true);
    // Off to the side by more than ship radius + half-width.
    expect(playerInMiningBeam(-350, 0, -700, 0, -500, R + MINING_BEAM_HALF_WIDTH + 5, R, MINING_BEAM_HALF_WIDTH)).toBe(false);
  });

  it('the grazing boundary is shipRadius + beamHalfWidth', () => {
    // Exactly at the boundary → in (<=). Just past → out.
    expect(playerInMiningBeam(0, 0, 100, 0, 50, R + MINING_BEAM_HALF_WIDTH, R, MINING_BEAM_HALF_WIDTH)).toBe(true);
    expect(playerInMiningBeam(0, 0, 100, 0, 50, R + MINING_BEAM_HALF_WIDTH + 0.01, R, MINING_BEAM_HALF_WIDTH)).toBe(false);
  });

  it('a ship beyond the beam endpoints is not in-beam (it is a SEGMENT, not a ray)', () => {
    // 200u past the (100,0) endpoint, on-axis → distance 100 ≫ R+halfWidth.
    expect(playerInMiningBeam(0, 0, 100, 0, 300, 0, R, MINING_BEAM_HALF_WIDTH)).toBe(false);
  });
});

describe('mining-beam tunables', () => {
  it('the player DPS is a gentle hazard (within the ADR ~1-2 HP/tick band)', () => {
    expect(MINING_BEAM_PLAYER_DPS).toBeGreaterThan(0);
    expect(MINING_BEAM_PLAYER_DPS).toBeLessThanOrEqual(2);
  });
});
