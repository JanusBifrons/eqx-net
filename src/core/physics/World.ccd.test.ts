/**
 * Soft-CCD lock — moving bodies must never tunnel through static geometry
 * (plan: soft-leaping-truffle, PR-C; user: "we should have raycasting when
 * moving ships surely to prevent tunneling? True for any moving object").
 *
 * Before PR-C no body enabled Rapier CCD, so only the 60 Hz step geometry
 * stopped a pass-through: a body whose centre crossed a wall's midline within
 * one step was ejected out the FAR side. Measured 2026-10-31: a shields-down
 * scout at ~46 u/tick tunnelled a 76 u wall 12/48 times head-on; real speeds
 * were safe against today's 20 u shield walls, but rams / missile impulses
 * exceed the maxSpeed clamp, and procedural bases add many thin trimesh
 * walls. With soft CCD (prediction 48): 0 pass-throughs at 16 u. (Full CCD also
 * stops tunnelling but broke static-overlap contact events — see World.ts.)
 *
 * This runs through the REAL spawn paths (`spawnShip`, `spawnObstacle`) — the
 * same code the server worker and the client predWorld both use, so the two
 * sides cannot disagree (Invariant #15).
 */
import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from './World.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

const HZ = 60;
const WALL_THICKNESS = 16;
/** ~2× the fastest flyable ship's per-tick travel at max topSpeed upgrade
 *  (950 u/s × 1.45 / 60 ≈ 23 u/tick). */
const PER_TICK = 46;

function addThinWall(world: PhysicsWorld, kind: 'cuboid' | 'trimesh'): void {
  const raw = (world as unknown as { world: RAPIER.World }).world;
  const body = raw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const hw = 1000;
  const ht = WALL_THICKNESS / 2;
  const desc =
    kind === 'cuboid'
      ? RAPIER.ColliderDesc.cuboid(hw, ht)
      : RAPIER.ColliderDesc.trimesh(
          new Float32Array([-hw, -ht, hw, -ht, hw, ht, -hw, ht]),
          new Uint32Array([0, 1, 2, 0, 2, 3]),
        );
  raw.createCollider(desc, body);
}

type Spawn = (w: PhysicsWorld, y: number) => void;

const SPAWNS: Record<string, Spawn> = {
  'ship (shielded)': (w, y) => w.spawnShip('m', 0, y, 'scout'),
  'ship (hull exposed)': (w, y) => {
    w.spawnShip('m', 0, y, 'scout');
    w.setHullExposed('m', true, getShipKind('scout'));
  },
  'obstacle body (drone/asteroid/scrap path)': (w, y) => w.spawnObstacle('m', 0, y, 10, 1),
};

async function passesThrough(spawn: Spawn, wall: 'cuboid' | 'trimesh', angleDeg: number, off: number): Promise<boolean> {
  const world = await PhysicsWorld.create();
  addThinWall(world, wall);
  const y0 = -200 - off;
  spawn(world, y0);
  world.tick(1 / HZ);
  const a = (angleDeg * Math.PI) / 180;
  world.setShipState('m', { x: 0, y: y0, angle: 0, vx: Math.cos(a) * PER_TICK * HZ, vy: Math.sin(a) * PER_TICK * HZ, angvel: 0 });
  for (let t = 0; t < 60; t++) {
    world.tick(1 / HZ);
    const s = world.getShipState('m');
    if (s && s.y > WALL_THICKNESS / 2) return true;
  }
  return false;
}

describe('CCD — moving bodies never tunnel thin static walls', () => {
  for (const [label, spawn] of Object.entries(SPAWNS)) {
    for (const wall of ['cuboid', 'trimesh'] as const) {
      it(`${label} vs ${WALL_THICKNESS} u ${wall} wall at ~${PER_TICK} u/tick`, async () => {
        for (const angleDeg of [90, 60, 30]) {
          // Sweep sub-tick start offsets: the failure is step-phase dependent.
          for (let off = 0; off < PER_TICK; off += 2) {
            expect(await passesThrough(spawn, wall, angleDeg, off), `angle ${angleDeg}° offset ${off}`).toBe(false);
          }
        }
      });
    }
  }
});
