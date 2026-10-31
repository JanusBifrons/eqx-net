/**
 * Tunnelling lock for base geometry (plan: soft-leaping-truffle, PR-B).
 *
 * `MIN_WALL_THICKNESS` is derived on paper (thickness + ship diameter must
 * beat per-tick travel with a 2× margin). This test proves it in the real
 * physics: the SMALLEST player-flyable hull, at the maximum per-tick speed any
 * flyable ship can reach (×2 margin), is fired into a wall of exactly
 * `MIN_WALL_THICKNESS` built the way Tier A builds geometry (one fixed body +
 * one solid trimesh collider per chunk). It must never come out the far side —
 * head-on, at shallow grazing angles, from many sub-tick start offsets, with
 * shields up (circle collider) and down (hull triangles).
 *
 * Every dynamic body runs Rapier soft CCD (PR-C, `SOFT_CCD_PREDICTION`), which
 * is what stops the pass-through. If CCD is removed, walls thinned below the
 * floor, or ships sped up past the look-ahead, this goes red.
 */
import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../../src/core/physics/World.js';
import { MIN_WALL_THICKNESS } from '../../src/shared-types/baseBudgets.js';
import { GAMEPLAY_SHIP_KINDS_LIST, getShipKind } from '../../src/shared-types/shipKinds.js';
import { deriveStatMultipliers, pointBudget } from '../../src/core/leveling/shipStats.js';
import { LEVEL_CAP } from '../../src/core/leveling/shipXp.js';

// Long enough that a grazing ship sliding along it for 60 ticks never rounds an
// end (at 15° a slide covers ~2600 u) — the test measures tunnelling only.
const WALL_LEN = 20000;
const HZ = 60;

function smallestFlyableKind(): string {
  let best = GAMEPLAY_SHIP_KINDS_LIST[0]!;
  for (const k of GAMEPLAY_SHIP_KINDS_LIST) if (k.radius < best.radius) best = k;
  return best.id;
}

function maxPerTickTravel(): number {
  const mul = deriveStatMultipliers({ topSpeed: pointBudget(LEVEL_CAP) }).topSpeed;
  let m = 0;
  for (const k of GAMEPLAY_SHIP_KINDS_LIST) m = Math.max(m, (k.maxSpeed * mul) / HZ);
  return m;
}

/** A horizontal wall centred on y=0, built as Tier A will build it. */
function addTrimeshWall(world: PhysicsWorld, thickness: number): void {
  const raw = (world as unknown as { world: RAPIER.World }).world;
  const hw = WALL_LEN / 2;
  const ht = thickness / 2;
  const verts = new Float32Array([-hw, -ht, hw, -ht, hw, ht, -hw, ht]);
  const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const body = raw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  raw.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx), body);
}

async function firesThrough(opts: {
  angleDeg: number;
  startOffset: number;
  hullExposed: boolean;
}): Promise<boolean> {
  const world = await PhysicsWorld.create();
  addTrimeshWall(world, MIN_WALL_THICKNESS);
  const kindId = smallestFlyableKind();
  world.spawnShip('s', 0, -200 - opts.startOffset, kindId as never);
  if (opts.hullExposed) world.setHullExposed('s', true, getShipKind(kindId));
  world.tick(1 / HZ); // let the collider changes reach the broad-phase
  // 2× the fastest possible per-tick travel, aimed up into the wall.
  const speed = 2 * maxPerTickTravel() * HZ;
  const a = (opts.angleDeg * Math.PI) / 180;
  world.setShipState('s', {
    x: 0,
    y: -200 - opts.startOffset,
    angle: 0,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    angvel: 0,
  });
  for (let t = 0; t < 60; t++) {
    world.tick(1 / HZ);
    const s = world.getShipState('s');
    if (s && s.y > MIN_WALL_THICKNESS / 2) return true; // on the far side
  }
  return false;
}

describe('base walls — no tunnelling at MIN_WALL_THICKNESS', () => {
  for (const hullExposed of [false, true]) {
    for (const angleDeg of [90, 60, 30, 15]) {
      it(`smallest flyable hull, 2× max speed, ${angleDeg}° into the wall, hull ${hullExposed ? 'exposed' : 'shielded'}`, async () => {
        // Sweep sub-tick start offsets so the wall is approached from every
        // phase of the 60 Hz step (the worst case is phase-dependent).
        for (let off = 0; off < 48; off += 3) {
          expect(await firesThrough({ angleDeg, startOffset: off, hullExposed }), `offset ${off}`).toBe(false);
        }
      });
    }
  }
});
