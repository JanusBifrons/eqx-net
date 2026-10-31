/**
 * Procedural-bases budget harness (plan: soft-leaping-truffle, PR-B).
 *
 * The question it answers: how much does a field of STATIC base geometry
 * (Tier A: walls, racks, buildings) cost the fixed 60 Hz physics step when
 * ships are flying through it? This number grounds the Tier A piece budget
 * in `src/shared-types/baseBudgets.ts` — the budget is derived from this
 * measurement, never guessed.
 *
 * Scenario: 25 thrusting + turning ships (matches the `feel-test-25`
 * reference load) inside an 8000 u square filled with N axis-aligned cuboid
 * pieces laid out as warehouse rack rows (the densest archetype).
 *
 * Two layouts are compared, because the plan must pick one:
 *  - `body-per-piece`  — one fixed rigid body + one collider per piece
 *                        (how `spawnWall` works today).
 *  - `body-per-chunk`  — one fixed body per 1024 u chunk carrying many
 *                        cuboid colliders.
 *  - `trimesh-per-chunk` — one fixed body + ONE solid trimesh collider per
 *                        chunk (pieces = triangle pairs behind an internal BVH).
 *
 * Also measured: a 20-tick burst ≈ one reconciler replay window on the
 * client predWorld (ticksAhead is typically 6–24).
 */
import { bench, describe } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../src/core/physics/World.js';

const SHIP_COUNT = 25;
const AREA = 8000;
const CHUNK = 1024;
const PIECE_W = 200;
const PIECE_H = 40;
const REPLAY_TICKS = 20;

type Layout = 'body-per-piece' | 'body-per-chunk' | 'trimesh-per-chunk';

function rawWorld(w: PhysicsWorld): RAPIER.World {
  // Bench-only reach into the private Rapier world: there is no public
  // static-geometry API yet (that is what this harness is sizing).
  return (w as unknown as { world: RAPIER.World }).world;
}

/** Deterministic warehouse-row layout: N pieces on a grid with aisles. */
function piecePositions(n: number): Float64Array {
  const out = new Float64Array(n * 2);
  const pitchX = PIECE_W + 120; // 120 u cross-aisle
  const pitchY = PIECE_H + 160; // 160 u fly-through aisle
  const cols = Math.max(1, Math.floor(AREA / pitchX));
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out[i * 2] = -AREA / 2 + c * pitchX + PIECE_W / 2;
    out[i * 2 + 1] = -AREA / 2 + r * pitchY + PIECE_H / 2;
  }
  return out;
}

function addPieces(w: PhysicsWorld, n: number, layout: Layout): void {
  const world = rawWorld(w);
  const pos = piecePositions(n);
  if (layout === 'body-per-piece') {
    for (let i = 0; i < n; i++) {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(pos[i * 2]!, pos[i * 2 + 1]!),
      );
      world.createCollider(RAPIER.ColliderDesc.cuboid(PIECE_W / 2, PIECE_H / 2), body);
    }
    return;
  }
  if (layout === 'trimesh-per-chunk') {
    // One fixed body + ONE trimesh collider per chunk: every piece becomes
    // two solid triangles inside a single collider (internal BVH), so the
    // broad-phase tracks one proxy per chunk instead of one per piece.
    const perChunk = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const cx = Math.floor((pos[i * 2]! + AREA / 2) / CHUNK);
      const cy = Math.floor((pos[i * 2 + 1]! + AREA / 2) / CHUNK);
      const key = cy * 64 + cx;
      let list = perChunk.get(key);
      if (list === undefined) { list = []; perChunk.set(key, list); }
      list.push(i);
    }
    for (const list of perChunk.values()) {
      const verts = new Float32Array(list.length * 8);
      const idx = new Uint32Array(list.length * 6);
      list.forEach((i, k) => {
        const x = pos[i * 2]!, y = pos[i * 2 + 1]!, hw = PIECE_W / 2, hh = PIECE_H / 2;
        verts.set([x - hw, y - hh, x + hw, y - hh, x + hw, y + hh, x - hw, y + hh], k * 8);
        const b = k * 4;
        idx.set([b, b + 1, b + 2, b, b + 2, b + 3], k * 6);
      });
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      world.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx), body);
    }
    return;
  }
  const chunkBodies = new Map<number, RAPIER.RigidBody>();
  for (let i = 0; i < n; i++) {
    const x = pos[i * 2]!;
    const y = pos[i * 2 + 1]!;
    const cx = Math.floor((x + AREA / 2) / CHUNK);
    const cy = Math.floor((y + AREA / 2) / CHUNK);
    const key = cy * 64 + cx;
    let body = chunkBodies.get(key);
    const ox = -AREA / 2 + cx * CHUNK;
    const oy = -AREA / 2 + cy * CHUNK;
    if (body === undefined) {
      body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(ox, oy));
      chunkBodies.set(key, body);
    }
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(PIECE_W / 2, PIECE_H / 2).setTranslation(x - ox, y - oy),
      body,
    );
  }
}

async function buildWorld(n: number, layout: Layout): Promise<{ world: PhysicsWorld; ids: string[] }> {
  const world = await PhysicsWorld.create();
  const ids: string[] = [];
  for (let i = 0; i < SHIP_COUNT; i++) {
    const id = `ship-${i}`;
    // Ships start in aisles spread across the base.
    world.spawnShip(id, -AREA / 2 + 300 + (i % 5) * 1500, -AREA / 2 + 140 + Math.floor(i / 5) * 1600);
    ids.push(id);
  }
  addPieces(world, n, layout);
  return { world, ids };
}

const THRUST_LEFT = { thrust: true, turnLeft: true, turnRight: false };
const THRUST_RIGHT = { thrust: true, turnLeft: false, turnRight: true };

function step(world: PhysicsWorld, ids: string[], t: number): void {
  for (let i = 0; i < ids.length; i++) {
    world.applyInput(ids[i]!, ((i + (t >> 5)) & 1) === 0 ? THRUST_LEFT : THRUST_RIGHT);
  }
  world.tick(1 / 60);
}

for (const layout of ['body-per-piece', 'body-per-chunk', 'trimesh-per-chunk'] as const) {
  for (const n of [0, 1000, 4000, 8000]) {
    describe(`base static colliders — ${layout} — ${n} pieces`, () => {
      let world: PhysicsWorld;
      let ids: string[];
      let t = 0;
      const setup = async (): Promise<void> => {
        ({ world, ids } = await buildWorld(n, layout));
        // Warm: let ships get moving so the broad-phase is in steady state.
        for (t = 0; t < 60; t++) step(world, ids, t);
      };

      bench(
        'physics step (25 moving ships)',
        () => {
          step(world, ids, t++);
        },
        { setup },
      );

      bench(
        `replay burst (${REPLAY_TICKS} ticks)`,
        () => {
          for (let k = 0; k < REPLAY_TICKS; k++) step(world, ids, t++);
        },
        { setup },
      );
    });
  }
}
