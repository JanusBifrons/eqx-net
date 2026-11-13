/**
 * Capital destruction S2b — the local ship flying into a wreck piece must be
 * PREDICTED, not corrected (#12: one paradigm for every remote moving entity).
 *
 * Two real Rapier worlds side by side:
 *  - the SERVER world builds the piece the way the physics worker does for a
 *    `SPAWN_OBSTACLE` from `CapitalWreckSubsystem` (convex parts, mass,
 *    damping, angular damping);
 *  - the CLIENT predWorld builds it through the real client factory
 *    (`leafFor(SWARM_KIND_WRECK)`) from the geometry the `WreckGeometryStore`
 *    rebuilt off the `wrecks[]` descriptor, seeded with the server state as
 *    `syncSwarmIntoPredWorld` does.
 * The same thrust drives the local ship into the piece in both. If the two
 * diverge, every snapshot would correct the local ship (the "correction storm"
 * scrap had in 2026-06). Before S2b the client had no wreck body at all: the
 * ship flew through it in prediction while the server stopped it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from '../../src/core/physics/World.js';
import { WRECK_COLLISION_GROUPS } from '../../src/core/physics/collisionGroups.js';
import type { SwarmRenderState } from '../../src/core/contracts/IRenderer.js';
import { SWARM_KIND_WRECK } from '../../src/shared-types/swarmWireFormat.js';
import type { WreckDescriptor } from '../../src/shared-types/messages/snapshotMessages.js';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from '../../src/server/rooms/CapitalWreckSubsystem.js';
import { ClientEntityFactory } from '../../src/client/net/entity/ClientEntityFactory.js';
import { WreckGeometryStore } from '../../src/client/net/wreckGeometryStore.js';
import type { ClientSpawnCtx } from '../../src/client/net/entity/IClientEntityLeaf.js';

/** The LERP_THRESHOLD the reconciler treats as a correction is 0.05 u. */
const CORRECTION_U = 0.05;

function oneWreck(): { piece: WreckPieceSpawn; desc: WreckDescriptor } {
  const spawned: WreckPieceSpawn[] = [];
  const sys = new CapitalWreckSubsystem({
    serverTick: () => 1,
    capitalKindOf: () => 'battleship',
    positionOf: () => null,
    spawnPiece: (s) => { spawned.push(s); return true; },
    removePiece: () => {},
    isLive: () => true,
    pieceAngle: () => 0,
    kickPiece: () => {},
  });
  sys.forcedSeed = 5;
  sys.noteHit('cap', 'x', 1e6, 0, -2000);
  // At rest, unturned, far from the origin; the test moves the piece's pose.
  sys.onDeath('cap', 'battleship', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }, 1e5);
  // A mid-sized piece (v6: the biggest is half a battleship, too heavy for a
  // fighter to shove measurably).
  spawned.sort((a, b) => b.mass - a.mass);
  return { piece: spawned[Math.floor(spawned.length / 3)]!, desc: JSON.parse(JSON.stringify(sys.descriptors()))[0] };
}

describe('wreck piece in predWorld (S2b)', () => {
  let server: PhysicsWorld;
  let client: PhysicsWorld;
  beforeAll(async () => {
    server = await PhysicsWorld.create();
    client = await PhysicsWorld.create();
  });

  it('the local ship ramming a wreck piece is predicted exactly: no corrections, and it does not pass through', () => {
    const { piece, desc } = oneWreck();
    const px = 0;
    const pa = 0.4;
    // Put the piece's lowest vertex 150 u above the ship, over the ship's line.
    let low = Infinity;
    let lowX = 0;
    for (const part of piece.parts) for (const v of part) {
      const wy = v.x * Math.sin(pa) + v.y * Math.cos(pa);
      if (wy < low) { low = wy; lowX = v.x * Math.cos(pa) - v.y * Math.sin(pa); }
    }
    const py = 150 - low;
    const shipX = px + lowX * 0.9;

    // SERVER: what the worker does for SPAWN_OBSTACLE (+ spin + angular damping).
    server.spawnObstacle('wreck-0', px, py, piece.radius, piece.mass, undefined, piece.linearDamping, WRECK_COLLISION_GROUPS, piece.colliderParts);
    server.setShipState('wreck-0', { x: px, y: py, vx: 0, vy: 0, angle: pa, angvel: 0 });
    server.setAngularDamping('wreck-0', piece.angularDamping);

    // CLIENT: the real factory leaf, geometry rebuilt from the descriptor.
    const store = new WreckGeometryStore();
    store.apply([desc]);
    const leaf = new ClientEntityFactory().leafFor(SWARM_KIND_WRECK);
    expect(leaf, 'the client constructs wreck pieces').not.toBeNull();
    const entry = {
      x: px, y: py, vx: 0, vy: 0, angle: pa, angvel: 0, radius: piece.radius,
      kind: SWARM_KIND_WRECK, shipKind: 'battleship', componentIndex: piece.pieceIndex, wreckId: desc.wreckId,
    } as SwarmRenderState;
    const ctx: ClientSpawnCtx = {
      predWorld: client,
      aiController: { register: () => undefined, unregister: () => undefined } as unknown as ClientSpawnCtx['aiController'],
      wrecks: store,
      entityId: 77,
      key: 'swarm-77',
      entry,
      registeredAiId: null,
    };
    leaf!.spawnBody(ctx);
    expect(client.hasShip('swarm-77'), 'a wreck piece has a predWorld body').toBe(true);
    // syncSwarmIntoPredWorld seeds a new moving body with its server state.
    client.setShipState('swarm-77', { x: px, y: py, vx: 0, vy: 0, angle: pa, angvel: 0 });

    server.spawnShip('local', shipX, 0);
    client.spawnShip('local', shipX, 0);
    let corrections = 0;
    let maxDrift = 0;
    for (let i = 0; i < 240; i++) {
      for (const w of [server, client]) {
        w.applyInput('local', { thrust: true, turnLeft: false, turnRight: false });
        w.tick(1 / 60);
      }
      const s = server.getShipState('local')!;
      const c = client.getShipState('local')!;
      const d = Math.hypot(s.x - c.x, s.y - c.y);
      if (d > CORRECTION_U) corrections++;
      maxDrift = Math.max(maxDrift, d);
    }
    expect(corrections, `local ship drift (max ${maxDrift.toFixed(3)} u)`).toBe(0);
    // It really hit: the piece was shoved and the ship never got through it.
    const sp = server.getShipState('wreck-0')!;
    expect(Math.hypot(sp.x - px, sp.y - py)).toBeGreaterThan(0.5);
    const cs = client.getShipState('local')!;
    expect(cs.y).toBeLessThan(sp.y);
    // And the twin piece followed the server's.
    const cp = client.getShipState('swarm-77')!;
    expect(Math.hypot(cp.x - sp.x, cp.y - sp.y)).toBeLessThan(CORRECTION_U);
  });
});
