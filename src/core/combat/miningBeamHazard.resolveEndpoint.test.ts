/**
 * P1b regression — the mining beam "doesn't cut at impact / shoots through
 * buildings" fix. `resolveMiningBeamEndpoint` clips the beam at the asteroid
 * SURFACE (not its centre) and stops at any built structure blocking the line of
 * sight (a blocked beam mines no ore).
 */
import { describe, it, expect } from 'vitest';
import { resolveMiningBeamEndpoint, type MiningBeamObstacle } from './miningBeamHazard.js';

describe('resolveMiningBeamEndpoint (P1b)', () => {
  it('clips at the asteroid SURFACE, not the centre (cut at impact)', () => {
    // Miner at origin, asteroid centre at (100,0), radius 20 → surface at x=80.
    const r = resolveMiningBeamEndpoint(0, 0, 100, 0, 20, []);
    expect(r.blocked).toBe(false);
    expect(r.x).toBeCloseTo(80, 6);
    expect(r.y).toBeCloseTo(0, 6);
  });

  it('stops at a structure blocking the line of sight (no shoot-through, blocked)', () => {
    // A built structure (radius 10) centred at (50,0) sits on the beam line → the
    // beam stops at its near edge (x=40), well before the asteroid surface (80).
    const obstacles: MiningBeamObstacle[] = [{ x: 50, y: 0, radius: 10 }];
    const r = resolveMiningBeamEndpoint(0, 0, 100, 0, 20, obstacles);
    expect(r.blocked).toBe(true);
    expect(r.x).toBeCloseTo(40, 6);
    expect(r.y).toBeCloseTo(0, 6);
  });

  it('ignores a structure that is NOT on the beam line', () => {
    // Off to the side (y=100) — the ray never enters it.
    const obstacles: MiningBeamObstacle[] = [{ x: 50, y: 100, radius: 10 }];
    const r = resolveMiningBeamEndpoint(0, 0, 100, 0, 20, obstacles);
    expect(r.blocked).toBe(false);
    expect(r.x).toBeCloseTo(80, 6);
  });

  it('a structure BEYOND the asteroid surface does not block (only obstacles in front clip)', () => {
    // Structure at (90,0) is past the asteroid surface (80) → never reached.
    const obstacles: MiningBeamObstacle[] = [{ x: 90, y: 0, radius: 5 }];
    const r = resolveMiningBeamEndpoint(0, 0, 100, 0, 20, obstacles);
    expect(r.blocked).toBe(false);
    expect(r.x).toBeCloseTo(80, 6);
  });

  it('picks the NEAREST of multiple blocking structures', () => {
    const obstacles: MiningBeamObstacle[] = [
      { x: 60, y: 0, radius: 8 }, // near edge x=52
      { x: 30, y: 0, radius: 6 }, // near edge x=24 (closer)
    ];
    const r = resolveMiningBeamEndpoint(0, 0, 100, 0, 20, obstacles);
    expect(r.blocked).toBe(true);
    expect(r.x).toBeCloseTo(24, 6);
  });

  it('degenerate (miner on the asteroid) returns the centre, not NaN', () => {
    const r = resolveMiningBeamEndpoint(50, 50, 50, 50, 20, []);
    expect(Number.isNaN(r.x)).toBe(false);
    expect(r.x).toBeCloseTo(50, 6);
    expect(r.blocked).toBe(false);
  });
});
