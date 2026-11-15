/**
 * #15 two-sided contract: the heavy beam hits by its width (owner 2026-11-15).
 * The server resolves it analytically (`SectorRoom.playerHitscanDist`,
 * `swarmRayHit`, the shared `shipHitShape` / `Weapons` helpers); the pilot's
 * own client predicts the same shot (the live beam end and the predicted hit)
 * through `DisplayPoseHitscan`: a Rapier disc cast against its predWorld
 * bodies (remote ships, rocks) and the same core helpers for drones at their
 * drawn pose. Both must pick the same target at the same distance, or the
 * beam the pilot sees stops somewhere the server's doesn't.
 *
 * Each case sweeps the beam sideways across the target, from dead centre to
 * past the half-width, and compares the two sides at every offset.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../../../src/core/physics/World.js';
import type { SwarmRenderState } from '../../../src/core/contracts/IRenderer.js';
import { DisplayPoseHitscan } from '../../../src/client/combat/displayPoseHitscan.js';
import { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import { beamHalfWidth } from '../../../src/core/combat/Weapons.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipHitBound } from '../../../src/core/combat/shipHitShape.js';
import type { ShipState } from '../../../src/server/rooms/schema/SectorState.js';

const room = SectorRoom.prototype as unknown as {
  playerHitscanDist(s: ShipState, fx: number, fy: number, dx: number, dy: number, md: number, cx: number, cy: number, a: number, hw?: number): number | null;
  swarmRayHit(rec: object, fx: number, fy: number, dx: number, dy: number, md: number, cx: number, cy: number, a: number, hw?: number): number | null;
};

const HW = beamHalfWidth(getWeapon('heavy_beam'));
const KIND = 'missile-frigate';
const ROCK = [{ x: -60, y: -50 }, { x: 70, y: -40 }, { x: 55, y: 60 }, { x: -50, y: 45 }];

beforeAll(async () => {
  await RAPIER.init();
});

function drawnDrone(x: number, y: number, angle: number, shieldDown: boolean): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle, angvel: 0, radius: getShipKind(KIND).radius, kind: 1, shipKind: KIND, shieldDown,
    sleeping: false, lastUpdateTick: 0, prevX: x, prevY: y, prevAngle: angle, prevArrivalMs: 0,
    latestArrivalMs: 0, poseRing: [], ringHead: 0,
  } as unknown as SwarmRenderState;
}

type Target = 'pilot-up' | 'pilot-down' | 'rock' | 'box' | 'drone-up' | 'drone-down';
/** A structure footprint (half extents), axis-aligned like every structure. */
const BOX_HW = 60, BOX_HH = 35;

/** One world with one target at (0, 500), angle 0.4 (a box: 0); the beam fires along +y
 *  from (lateral, 0). Returns [client, server] (dist or null). */
async function both(target: Target, lateral: number): Promise<[number | null, number | null]> {
  const w = await PhysicsWorld.create();
  w.spawnShip('me', 0, -400);
  const cx = 0, cy = 500, ang = 0.4;
  const swarm = new Map<number, SwarmRenderState>();
  const moving = new Set<string>();
  const keys = new Map<number, string>();
  if (target === 'pilot-up' || target === 'pilot-down') {
    w.spawnShip('pilot', cx, cy, KIND);
    w.setShipState('pilot', { x: cx, y: cy, vx: 0, vy: 0, angle: ang, angvel: 0 });
    if (target === 'pilot-down') w.setHullExposed('pilot', true, getShipKind(KIND));
  } else if (target === 'rock') {
    w.spawnObstacle('swarm-7', cx, cy, 80, 3, ROCK);
    w.setShipState('swarm-7', { x: cx, y: cy, vx: 0, vy: 0, angle: ang, angvel: 0 });
  } else if (target === 'box') {
    w.spawnObstacle('swarm-8', cx, cy, 80, 3, [
      { x: -BOX_HW, y: -BOX_HH }, { x: BOX_HW, y: -BOX_HH }, { x: BOX_HW, y: BOX_HH }, { x: -BOX_HW, y: BOX_HH },
    ]);
  } else {
    swarm.set(3, drawnDrone(cx, cy, ang, target === 'drone-down'));
    moving.add('swarm-3');
    keys.set(3, 'swarm-3');
  }
  w.tick(1 / 60); // query pipeline
  const h = new DisplayPoseHitscan(moving, keys);
  h.world = w;
  h.swarm = swarm;
  const c = h.hitscan(lateral, 0, 0, 1, 2000, 'me', HW);
  w.dispose();
  return [c?.dist ?? null, serverDist(target, lateral, HW)];
}

/** The server's analytic pick for the same shot (target at (0, 500), 0.4). */
function serverDist(target: Target, fx: number, hw: number): number | null {
  const cx = 0, cy = 500, ang = 0.4, maxD = 2000;
  if (target === 'pilot-up' || target === 'pilot-down') {
    const ship = { alive: true, kind: KIND, shield: target === 'pilot-up' ? 100 : 0 } as unknown as ShipState;
    return room.playerHitscanDist(ship, fx, 0, 0, 1, maxD, cx, cy, ang, hw);
  }
  if (target === 'box') return room.swarmRayHit({ id: 'b', kind: 2, radius: 80, halfW: BOX_HW, halfH: BOX_HH }, fx, 0, 0, 1, maxD, cx, cy, 0, hw);
  if (target === 'rock') return room.swarmRayHit({ id: 'r', kind: 0, radius: 80, vertices: ROCK }, fx, 0, 0, 1, maxD, cx, cy, ang, hw);
  return room.swarmRayHit(
    { id: 'd', kind: 1, radius: getShipKind(KIND).radius, shipKind: KIND, shieldDown: target === 'drone-down' },
    fx, 0, 0, 1, maxD, cx, cy, ang, hw,
  );
}

describe('heavy beam width: client prediction and server pick the same hit (#15)', () => {
  const targets: Target[] = ['pilot-up', 'pilot-down', 'rock', 'box', 'drone-up', 'drone-down'];
  for (const target of targets) {
    it(`${target}: same hit and distance across the beam's width`, async () => {
      const reach = (target === 'rock' ? 95 : target === 'box' ? BOX_HW : shipHitBound(KIND)) + HW + 10;
      let wideOnly = 0;
      for (let lat = 0; lat <= reach; lat += reach / 24) {
        for (const side of [1, -1]) {
          const [c, s] = await both(target, side * lat);
          const what = `${target}, lateral ${(side * lat).toFixed(1)}: client ${c}, server ${s}`;
          expect(c === null, what).toBe(s === null);
          if (c !== null && s !== null) expect(Math.abs(c - s), what).toBeLessThan(0.05);
          if (s !== null && serverDist(target, side * lat, 0) === null) wideOnly++;
        }
      }
      expect(wideOnly).toBeGreaterThan(0);
    });
  }

  it('the wide beam is wider than the thin one on both sides (a 20 u miss of the centre line is a hit)', async () => {
    const bound = shipHitBound(KIND);
    // Far enough out that only the width can reach the bubble/hull.
    let found = false;
    for (let lat = bound; lat <= bound + HW; lat += 2) {
      const [c, s] = await both('pilot-up', lat);
      const thin = serverDist('pilot-up', lat, 0);
      if (thin === null && s !== null) { found = true; expect(c).not.toBeNull(); }
    }
    expect(found).toBe(true);
  });
});
