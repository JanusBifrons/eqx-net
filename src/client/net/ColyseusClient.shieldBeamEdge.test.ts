/**
 * Live-beam SHIELD-EDGE endpoint lock (2026-06-03).
 *
 * Symptom (on-device): the laser beam doesn't terminate exactly on the
 * cyan shield ring — it pops slightly inside/outside during combat.
 *
 * Root cause: `updateLiveBeam` used the predWorld collider's raw
 * `timeOfImpact` for the visible endpoint. The shield collider IS
 * `targetRadius + SHIELD_RADIUS_PAD` (the same radius the aura is drawn
 * at) in STEADY STATE, but it can lag the shield by one physics step
 * right after a shield 0-cross or a drone's first in-interest tick
 * (Rapier query-pipeline lag) — so the endpoint disagreed with the ring
 * for a frame.
 *
 * Fix: `shieldEdgeDist` recomputes the distance to the shield sphere
 * ANALYTICALLY (via the same pure `rayHitsSphere` the server uses) for a
 * shield-UP target, so the beam can never disagree with the rendered ring.
 * Shield-DOWN / hull hits, asteroids, and misses fall through to the
 * predWorld distance unchanged.
 *
 * This locks `shieldEdgeDist` directly (the seam where the fix lives),
 * mirroring `ColyseusClient.liveBeamPose.test.ts`'s internals-cast pattern.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { getShipKind, SHIELD_RADIUS_PAD } from '../../shared-types/shipKinds.js';

interface SwarmLike {
  x: number; y: number; vx: number; vy: number; radius: number; kind: number; shieldDown?: boolean;
}
interface ShipLike {
  x: number; y: number; vx: number; vy: number; angle: number; kind?: string; shieldDown?: boolean;
}
interface Internals {
  shieldEdgeDist(
    hit: { hitId: string; dist: number },
    fromX: number, fromY: number, fwdX: number, fwdY: number,
  ): number;
  mirror: {
    swarm?: Map<number, SwarmLike>;
    ships: Map<string, ShipLike>;
    localPlayerId: string | null;
  };
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

describe('live-beam endpoint snaps to the shield ring for shield-up targets', () => {
  let client: ColyseusGameClient;
  let internals: Internals;

  // Shooter at origin firing straight up (+y); a drone centred 100 u away.
  const FROM_X = 0, FROM_Y = 0, FWD_X = 0, FWD_Y = 1;
  const DRONE_DIST = 100;
  const DRONE_R = 30;
  // The predWorld collider (lagged) reports the BARE-radius hit: 100-30=70.
  const COLLIDER_HIT_DIST = DRONE_DIST - DRONE_R; // 70
  // The shield ring is radius+pad: ray enters it at 100-(30+10)=60.
  const SHIELD_EDGE_DIST = DRONE_DIST - (DRONE_R + SHIELD_RADIUS_PAD); // 60

  beforeEach(() => {
    client = new ColyseusGameClient();
    internals = asInternals(client);
    internals.mirror.swarm = new Map<number, SwarmLike>();
  });

  it('snaps a shield-UP drone hit to the shield ring (radius + SHIELD_RADIUS_PAD)', () => {
    internals.mirror.swarm!.set(5, { x: 0, y: DRONE_DIST, vx: 0, vy: 0, radius: DRONE_R, kind: 1, shieldDown: false });
    const got = internals.shieldEdgeDist({ hitId: 'swarm-5', dist: COLLIDER_HIT_DIST }, FROM_X, FROM_Y, FWD_X, FWD_Y);
    expect(got).toBeCloseTo(SHIELD_EDGE_DIST, 5);
    expect(got).toBeLessThan(COLLIDER_HIT_DIST); // ring is `pad` closer to shooter
  });

  it('leaves a shield-DOWN drone hit on the predWorld (hull) distance', () => {
    internals.mirror.swarm!.set(5, { x: 0, y: DRONE_DIST, vx: 0, vy: 0, radius: DRONE_R, kind: 1, shieldDown: true });
    const got = internals.shieldEdgeDist({ hitId: 'swarm-5', dist: COLLIDER_HIT_DIST }, FROM_X, FROM_Y, FWD_X, FWD_Y);
    expect(got).toBe(COLLIDER_HIT_DIST);
  });

  it('leaves an asteroid (kind 0) hit unchanged — asteroids have no shield', () => {
    internals.mirror.swarm!.set(5, { x: 0, y: DRONE_DIST, vx: 0, vy: 0, radius: DRONE_R, kind: 0, shieldDown: false });
    const got = internals.shieldEdgeDist({ hitId: 'swarm-5', dist: COLLIDER_HIT_DIST }, FROM_X, FROM_Y, FWD_X, FWD_Y);
    expect(got).toBe(COLLIDER_HIT_DIST);
  });

  it('snaps a shield-UP player ship hit to its kind shield ring', () => {
    internals.mirror.ships.set('p2', { x: 0, y: DRONE_DIST, vx: 0, vy: 0, angle: 0, kind: 'fighter', shieldDown: false });
    const r = getShipKind('fighter').radius + SHIELD_RADIUS_PAD;
    const got = internals.shieldEdgeDist({ hitId: 'p2', dist: 999 }, FROM_X, FROM_Y, FWD_X, FWD_Y);
    expect(got).toBeCloseTo(DRONE_DIST - r, 5);
  });

  it('falls through to predWorld distance when the analytical ray misses the sphere', () => {
    // Drone off to the side — the straight-up ray never enters its sphere.
    internals.mirror.swarm!.set(5, { x: 500, y: DRONE_DIST, vx: 0, vy: 0, radius: DRONE_R, kind: 1, shieldDown: false });
    const got = internals.shieldEdgeDist({ hitId: 'swarm-5', dist: COLLIDER_HIT_DIST }, FROM_X, FROM_Y, FWD_X, FWD_Y);
    expect(got).toBe(COLLIDER_HIT_DIST);
  });
});
