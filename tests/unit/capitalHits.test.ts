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
    expect(refineRayHit('battleship', circle, x, -bb.radius * 2, 0, 1, bb.radius * 4, 0, 0, 0)).toBeNull();
    // Straight down the centreline it hits the hull.
    const c2 = rayHitsSphere(0, -bb.radius * 2, 0, 1, bb.radius * 4, 0, 0, bb.radius);
    expect(refineRayHit('battleship', c2, 0, -bb.radius * 2, 0, 1, bb.radius * 4, 0, 0, 0)).not.toBeNull();
  });

  it('a projectile step is refined the same way; a fighter is unchanged', () => {
    const x = bb.radius * 0.4;
    const s = projectileSweepCircle(x, -bb.radius - 10, 0, 40, 2, 0, -bb.radius + 20, bb.radius);
    expect(refineSweepHit('battleship', s, x, -bb.radius - 10, 0, 40, 0, -bb.radius + 20, 0)).toBeNull();
    const f = getShipKind('fighter');
    const fs = projectileSweepCircle(0, -100, 0, 200, 2, 0, 0, f.radius);
    expect(refineSweepHit('fighter', fs, 0, -100, 0, 200, 0, 0, 0)).toBe(fs);
  });

  it('every drone hit site calls the shared refinement (server and client, #15)', () => {
    const src = (p: string): string => readFileSync(p, 'utf8');
    expect(src('src/server/rooms/ProjectilePipeline.ts')).toContain('refineSweepHit(rec.shipKind');
    expect(src('src/server/rooms/PlayerFireResolver.ts')).toContain('refineRayHit(rec.shipKind');
    expect(src('src/client/net/ColyseusClient.ts')).toContain('refineRayHit(sw.shipKind');
  });
});
