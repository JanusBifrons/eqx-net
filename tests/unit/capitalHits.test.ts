/**
 * Capital-ship R&D round 3 (B): hits on capitals follow the hull. A capital's
 * bounding circle is half its length across, so before this a shot anywhere
 * near a 10x battleship counted as a hit. The refinement is ONE shared helper
 * used by the server projectile + hitscan paths and the client beam
 * prediction (#15); the parity case fails if any of them stops calling it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isCapitalKindId, refineRayHit, refineSweepHit } from '../../src/core/combat/capitalHits.js';
import { rayHitsSphere, projectileSweepCircle } from '../../src/core/combat/Weapons.js';
import { getShipKind } from '../../src/shared-types/shipKinds.js';

describe('capital hits follow the hull', () => {
  const bb = getShipKind('battleship');

  it('only the capital class is refined', () => {
    expect(isCapitalKindId('battleship')).toBe(true);
    expect(isCapitalKindId('fighter')).toBe(false);
    expect(isCapitalKindId('nonsense')).toBe(false);
  });

  it('a beam inside the bounding circle but beside the hull misses a capital', () => {
    // Battleship at the origin, nose up (+y); a vertical beam 40% of the radius
    // to the side: inside the circle, far outside a hull ~1/8 of its length wide.
    const x = bb.radius * 0.4;
    const circle = rayHitsSphere(x, -bb.radius * 2, 0, 1, bb.radius * 4, 0, 0, bb.radius);
    expect(circle).not.toBeNull();
    expect(refineRayHit('battleship', circle, x, -bb.radius * 2, 0, 1, bb.radius * 4, 0, 0, 0, bb.radius)).toBeNull();
    // Straight down the centreline it hits the hull.
    const c2 = rayHitsSphere(0, -bb.radius * 2, 0, 1, bb.radius * 4, 0, 0, bb.radius);
    expect(refineRayHit('battleship', c2, 0, -bb.radius * 2, 0, 1, bb.radius * 4, 0, 0, 0, bb.radius)).not.toBeNull();
  });

  it('a projectile step is refined the same way; a fighter is unchanged', () => {
    const x = bb.radius * 0.4;
    const s = projectileSweepCircle(x, -bb.radius - 10, 0, 40, 2, 0, -bb.radius + 20, bb.radius);
    expect(refineSweepHit('battleship', s, x, -bb.radius - 10, 0, 40, 0, -bb.radius + 20, 0, bb.radius + 2)).toBeNull();
    const f = getShipKind('fighter');
    const fs = projectileSweepCircle(0, -100, 0, 200, 2, 0, 0, f.radius);
    expect(refineSweepHit('fighter', fs, 0, -100, 0, 200, 0, 0, 0, f.radius + 2)).toBe(fs);
  });

  /**
   * 2026-11-13 (found building wreck knock-back, PR #542): the circle gate was
   * `rayHitsSphere`, which is null once the shot's origin is inside the circle
   * and past its closest approach to the centre. A shell steps one segment a
   * tick, so once a step started inside a long capital's circle past that
   * point the polygon test never ran: shells passed straight through the FAR
   * half of the hull. Battleship at the origin, angle 0: keel along y, beam
   * ~±0.12 R, so these paths are beside the hull until they cross the keel.
   */
  describe('the far half of the hull (step starts inside the circle, past the centre)', () => {
    const R = bb.radius;
    const PROJ_R = 4;
    const STEP = 25; // a 1,500 u/s shell, one tick
    /** Step a shell like ProjectilePipeline does; the first refined hit, or null. */
    function stepShell(sx: number, sy: number, dx: number, dy: number, maxSteps: number): { x: number; y: number } | null {
      const n = Math.hypot(dx, dy);
      const stepX = (dx / n) * STEP;
      const stepY = (dy / n) * STEP;
      let x = sx;
      let y = sy;
      for (let i = 0; i < maxSteps; i++) {
        const circle = projectileSweepCircle(x, y, stepX, stepY, PROJ_R, 0, 0, R);
        const hit = refineSweepHit('battleship', circle, x, y, stepX, stepY, 0, 0, 0, R + PROJ_R);
        if (hit) return { x: hit.hitX, y: hit.hitY };
        x += stepX;
        y += stepY;
      }
      return null;
    }

    it('one step that starts inside the circle past the centre and crosses the keel hits', () => {
      // From beside the stern quarter, heading away from the centre, across the keel.
      const fx = R * 0.2;
      const fy = -R * 0.5;
      const stepX = -R * 0.4;
      const stepY = -R * 0.4;
      expect(rayHitsSphere(fx, fy, stepX / Math.hypot(stepX, stepY), stepY / Math.hypot(stepX, stepY), Math.hypot(stepX, stepY), 0, 0, R),
        'the old gate rejects this step').toBeNull();
      const hit = refineSweepHit('battleship', null, fx, fy, stepX, stepY, 0, 0, 0, R + PROJ_R);
      expect(hit, 'the step crosses the hull, so it must hit').not.toBeNull();
      expect(hit!.hitY).toBeLessThan(-R * 0.4);
    });

    it('a shell fired along the hull\'s length, from beside midships toward the stern, hits', () => {
      const hit = stepShell(R * 0.2, 0, -0.25, -1, 200);
      expect(hit, 'the shell flew through the stern half').not.toBeNull();
      expect(hit!.y).toBeLessThan(0);
    });

    it('an oblique shell from outside the circle that reaches the hull only past the centre hits', () => {
      // Crosses the keel at (0, -0.55 R); closest approach to the centre is
      // at (0.275 R, -0.275 R), beside the hull, before it gets there.
      const d = Math.SQRT1_2;
      const kx = 0;
      const ky = -R * 0.55;
      const hit = stepShell(kx + d * R * 1.6, ky + d * R * 1.6, -1, -1, 400);
      expect(hit, 'the shell flew through the far half').not.toBeNull();
      expect(Math.abs(hit!.x)).toBeLessThan(R * 0.2);
    });

    it('a beam fired from beside the hull, away from the centre, across the keel hits', () => {
      const fx = R * 0.2;
      const fy = -R * 0.5;
      const dx = -Math.SQRT1_2;
      const dy = -Math.SQRT1_2;
      const c = rayHitsSphere(fx, fy, dx, dy, R, 0, 0, R);
      expect(c, 'the old gate rejects this ray').toBeNull();
      expect(refineRayHit('battleship', c, fx, fy, dx, dy, R, 0, 0, 0, R)).not.toBeNull();
    });

    it('a step entirely outside the circle still misses (the gate still gates)', () => {
      expect(refineSweepHit('battleship', null, R * 2, 0, 0, 40, 0, 0, 0, R + PROJ_R)).toBeNull();
      expect(refineRayHit('battleship', null, R * 2, 0, 0, 1, R, 0, 0, 0, R)).toBeNull();
    });
  });

  it('every drone hit site calls the shared refinement (server and client, #15)', () => {
    const src = (p: string): string => readFileSync(p, 'utf8');
    // Since 2026-11-13 every ship hit (player or NPC, any size) goes through
    // `shipHitShape.ts`, which refines capitals to the hull.
    expect(src('src/server/rooms/ProjectilePipeline.ts')).toContain('shipSweepHit(rec.shipKind');
    expect(src('src/server/rooms/PlayerFireResolver.ts')).toContain('shipRayHit(rec.shipKind');
    expect(src('src/client/net/ColyseusClient.ts')).toContain('shipRayHit(sw.shipKind');
    expect(src('src/client/combat/displayPoseHitscan.ts')).toContain('shipRayHit(e.shipKind');
    expect(src('src/server/rooms/SectorRoom.ts')).toContain('shipRayHit(ship.kind');
    expect(src('src/server/rooms/SectorRoom.ts')).toContain('shipSweepHit(ship.kind');
    expect(src('src/server/rooms/SectorRoom.ts')).toContain('shipRayHit(rec.shipKind');
    expect(src('src/server/rooms/MissileSimulation.ts')).toContain('shipSweepHit(rec.shipKind');
  });
});
